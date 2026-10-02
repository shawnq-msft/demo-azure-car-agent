import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { ApiError } from "./security.js";
import type { Budget } from "./budget.js";
import { readProviderJson } from "./provider-json.js";
import { searchWebIqVideos, validateWebIqSearchSettings, WebIqSearchError } from "./webiq-search.js";
export { parseVideoUrl } from "./video-url.js";

const mapsSearchSchema = z.object({ results: z.array(z.object({
  id: z.string(), poi: z.object({ name: z.string() }).optional(),
  address: z.object({ freeformAddress: z.string().optional() }).optional(),
  position: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
})).max(100) });
const routeSchema = z.object({ routes: z.array(z.object({
  summary: z.object({ lengthInMeters: z.number().nonnegative(), travelTimeInSeconds: z.number().nonnegative(), arrivalTime: z.string().optional() }),
  legs: z.array(z.object({ points: z.array(z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) })).max(50000) })).max(20)
})).max(10) });
async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) }); }
  catch { throw new ApiError("provider-unavailable", "Configured provider did not respond", 503); }
  if (!response.ok) throw new ApiError(response.status === 401 || response.status === 403 ? "provider-unauthorized" : "provider-unavailable", "Configured provider rejected the request", 503);
  return readProviderJson(response);
}
type Coordinate = { latitude: number; longitude: number };
export class Adapters {
  private shutdown = new AbortController();
  constructor(private config: Config, private budget: Budget, private recordCharge?: (visitorId: string, id: string, amount: number, rateVersion: string, inputTokens?: number, outputTokens?: number, cachedInputTokens?: number, uncertain?: boolean) => void) {}
  stop(): void { this.shutdown.abort(); }
  private async chargeMaps(visitorId: string): Promise<void> {
    await this.budget.charge(visitorId, this.config.mapsPrice!);
    this.recordCharge?.(visitorId, randomUUID(), this.config.mapsPrice!, "azure-maps-configured-request-price");
  }
  async search(visitorId: string, args: { query: string; near?: Coordinate }, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.config.mapsKey || !this.config.mapsPrice || this.config.killSwitch) throw new ApiError("unconfigured", "Azure Maps requires server credentials and verified request pricing", 503);
    await this.chargeMaps(visitorId);
    const url = new URL("https://atlas.microsoft.com/search/poi/json");
    url.searchParams.set("api-version", "1.0"); url.searchParams.set("query", args.query); url.searchParams.set("limit", "5");
    if (args.near) { url.searchParams.set("lat", String(args.near.latitude)); url.searchParams.set("lon", String(args.near.longitude)); }
    const parsed = mapsSearchSchema.safeParse(await requestJson(url.href, { headers: { "subscription-key": this.config.mapsKey }, signal: signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal }));
    if (!parsed.success) throw new ApiError("invalid-provider-response", "Azure Maps response schema mismatch", 503);
    return { places: parsed.data.results.map(place => ({ id: place.id, name: place.poi?.name ?? place.address?.freeformAddress ?? "Place", address: place.address?.freeformAddress ?? "", latitude: place.position.lat, longitude: place.position.lon })), fetchedAt: new Date().toISOString(), source: "Azure Maps" };
  }
  async route(visitorId: string, args: { origin: Coordinate; destination: Coordinate }, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    if (!this.config.mapsKey || !this.config.mapsPrice || this.config.killSwitch) throw new ApiError("unconfigured", "Azure Maps requires server credentials and verified request pricing", 503);
    await this.chargeMaps(visitorId);
    const url = new URL("https://atlas.microsoft.com/route/directions/json");
    url.searchParams.set("api-version", "1.0"); url.searchParams.set("query", `${args.origin.latitude},${args.origin.longitude}:${args.destination.latitude},${args.destination.longitude}`); url.searchParams.set("travelMode", "car"); url.searchParams.set("traffic", "true");
    const parsed = routeSchema.safeParse(await requestJson(url.href, { headers: { "subscription-key": this.config.mapsKey }, signal: signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal }));
    const route = parsed.success ? parsed.data.routes[0] : null;
    if (!route) throw new ApiError("invalid-provider-response", "No valid route returned", 503);
    return { distanceMeters: route.summary.lengthInMeters, durationSeconds: route.summary.travelTimeInSeconds, arrivalTime: route.summary.arrivalTime, points: route.legs.flatMap(leg => leg.points), origin: args.origin, destination: args.destination, simulatedProgression: true, fetchedAt: new Date().toISOString(), source: "Azure Maps" };
  }
  async videos(visitorId: string, args: { query: string; platform: "all" | "youtube" | "bilibili" }, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const settings = this.config.webIqSearch;
    if (!settings || this.config.killSwitch || this.shutdown.signal.aborted) throw new ApiError(this.config.webIq ? "web-iq-unverified" : "unconfigured", "Web IQ requires reviewed read-only tools, verified Responses deployment and prices", 503);
    const request = {
      endpoint: settings.endpoint, key: settings.key, deployment: settings.deployment,
      webIqKey: settings.webIqKey, allowedTools: settings.allowedTools, maxOutputTokens: settings.rates.maxOutputTokens
    };
    validateWebIqSearchSettings(request);
    const reservation = await this.budget.reserveRequest(visitorId, settings.rates.reservationUsd);
    const id = randomUUID();
    const estimate = (usage: { inputTokens: number; outputTokens: number; mcpCalls: number }) =>
      (usage.inputTokens * settings.rates.inputText + usage.outputTokens * settings.rates.outputText) / 1_000_000 + usage.mcpCalls * settings.rates.mcpRequestUsd;
    let result: Awaited<ReturnType<typeof searchWebIqVideos>>;
    try {
      result = await searchWebIqVideos(request, args, (url, init) => fetch(url, {
        ...init, signal: AbortSignal.any([this.shutdown.signal, ...(init?.signal ? [init.signal] : []), ...(signal ? [signal] : [])])
      }));
    } catch (error) {
      const usage = error instanceof WebIqSearchError ? error.usage : undefined;
      const charged = Math.max(settings.rates.reservationUsd, usage ? estimate(usage) : 0);
      await reservation.settle(charged, false);
      this.recordCharge?.(visitorId, id, charged, settings.rates.version, usage?.inputTokens, usage?.outputTokens, usage?.cachedInputTokens, true);
      throw error;
    }
    const cost = estimate(result.usage);
    await reservation.settle(cost, true);
    this.recordCharge?.(visitorId, id, cost, settings.rates.version, result.usage.inputTokens, result.usage.outputTokens, result.usage.cachedInputTokens);
    return result;
  }
}
