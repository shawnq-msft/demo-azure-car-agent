import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Capabilities } from "@car/contracts";
import { costScope } from "./billing.js";
import { validateWebIqSearchSettings } from "./webiq-search.js";

export const limits = Object.freeze({ sessionSeconds: 600, idleSeconds: 60, dailySeconds: 1200, visitorUsd: 2, globalUsd: 50 });
const rateSchema = z.object({
  version: z.string().min(1),
  source: z.string().url().refine(v => new URL(v).protocol === "https:"),
  effectiveAt: z.string().datetime(),
  model: z.literal("gpt-realtime-2.1"),
  region: z.string().min(1),
  currency: z.literal("USD"),
  inputAudio: z.number().finite().positive(), outputAudio: z.number().finite().positive(),
  inputText: z.number().finite().positive(), outputText: z.number().finite().positive(),
  reservationUsd: z.number().positive().max(2),
  maxResponseTokens: z.number().int().min(1).max(4096),
  verifiedUsageSchema: z.literal("response.done-token-details-v1")
}).strict();
export type RateCard = Readonly<z.infer<typeof rateSchema>>;
const priceEvidence = {
  version: z.string().min(1),
  source: z.string().url().refine(value => new URL(value).protocol === "https:"),
  effectiveAt: z.string().datetime(),
  reservationUsd: z.number().finite().positive().max(2)
};
const gptLiveRateSchema = z.object({
  ...priceEvidence,
  usdPerHour: z.number().finite().positive()
}).strict().refine(rate => rate.usdPerHour * limits.sessionSeconds / 3600 <= rate.reservationUsd, "Reserve the full maximum GPT-Live session duration");
const cascadeRateSchema = z.object({
  ...priceEvidence,
  inputText: z.number().finite().positive(), outputText: z.number().finite().positive(),
  sttUsdPerHour: z.number().finite().positive(), ttsUsdPerMillionCharacters: z.number().finite().positive(),
  maxResponseTokens: z.number().int().min(1).max(4096)
}).strict();
export interface GptLiveConfig {
  endpoint: string; deployment: string; region: string;
  rates: Readonly<z.infer<typeof gptLiveRateSchema>>;
  responses?: { deployment: string; inputText: number; outputText: number; maxResponseTokens: number; rateVersion: string };
}
export interface CascadeConfig {
  speechRegion: string; speechKey: string; responsesEndpoint: string; responsesKey: string; deployment: string;
  rates: Readonly<z.infer<typeof cascadeRateSchema>>;
}
const webIqSearchRateSchema = z.object({
  ...priceEvidence,
  inputText: z.number().finite().positive(), outputText: z.number().finite().positive(),
  mcpRequestUsd: z.number().finite().positive(),
  maxOutputTokens: z.number().int().min(128).max(4096)
}).strict().refine(rate => 2 * rate.mcpRequestUsd + rate.maxOutputTokens * rate.outputText / 1_000_000 < rate.reservationUsd, "Web IQ reservation must cover tool calls and maximum output, with headroom for input");
export interface WebIqSearchConfig {
  endpoint: string; key: string; deployment: string; webIqKey: string; allowedTools: string[];
  rates: Readonly<z.infer<typeof webIqSearchRateSchema>>;
}
export interface Config {
  production: boolean; port: number; origins: string[]; tokenSecret: string;
  persistence: "memory" | "cosmos"; cosmosEndpoint?: string; cosmosKey?: string;
  cosmosDatabase: string; cosmosContainer: string;
  voiceEndpoint?: string; voiceKey?: string; voiceIdentity: boolean; voiceRegion?: string; webRtcVerified: boolean;
  rates: RateCard | null; mapsKey?: string; mapsPrice: number | null;
  webIq: { endpoint: string; key: string; header: string; price: number; verification: string } | null;
  adminTenant?: string; adminAudience?: string; adminRole: string; adminClientId?: string; adminScope?: string;
  billingScope?: string;
  gptLive: GptLiveConfig | null;
  cascade: CascadeConfig | null;
  webIqSearch: WebIqSearchConfig | null;
  maxConcurrent: number; killSwitch: boolean;
}
function httpsEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Invalid HTTPS service endpoint");
  return url.href;
}
function price(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("Configured request price must be positive");
  return parsed;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  if (production && (!env.TOKEN_SIGNING_SECRET || env.TOKEN_SIGNING_SECRET.length < 32)) throw new Error("Production requires TOKEN_SIGNING_SECRET (32+ characters)");
  const persistence = z.enum(["memory", "cosmos"]).parse(env.PERSISTENCE_MODE ?? "memory");
  if (production && persistence !== "cosmos") throw new Error("Production requires durable Cosmos budgeting; memory mode is local only");
  if (env.MAX_REPLICAS && env.MAX_REPLICAS !== "1") throw new Error("Stateful gateway requires MAX_REPLICAS=1");
  const rates = env.VOICE_RATE_CARD_JSON ? Object.freeze(rateSchema.parse(JSON.parse(env.VOICE_RATE_CARD_JSON))) : null;
  let gptLive: GptLiveConfig | null = null;
  if (env.GPT_LIVE_ENDPOINT && env.GPT_LIVE_DEPLOYMENT && env.GPT_LIVE_REGION && env.GPT_LIVE_RATE_CARD_JSON && env.GPT_LIVE_DEPLOYMENT_VERIFIED === "true") {
    gptLive = {
      endpoint: httpsEndpoint(env.GPT_LIVE_ENDPOINT)!,
      deployment: z.string().trim().min(1).max(128).parse(env.GPT_LIVE_DEPLOYMENT),
      region: z.string().regex(/^[a-z0-9-]{1,50}$/).parse(env.GPT_LIVE_REGION),
      rates: Object.freeze(gptLiveRateSchema.parse(JSON.parse(env.GPT_LIVE_RATE_CARD_JSON)))
    };
    if (env.GPT_LIVE_RESPONSES_DELEGATION_VERIFIED === "true") {
      if (!env.GPT_LIVE_RESPONSES_RATE_CARD_JSON) throw new Error("Verified GPT-Live Responses delegation requires a rate card");
      gptLive.responses = Object.freeze(z.object({
        deployment: z.literal("gpt-6.1-sol"),
        source: z.string().url().startsWith("https://"), effectiveAt: z.string().datetime(),
        inputText: z.number().finite().positive(), outputText: z.number().finite().positive(),
        maxResponseTokens: z.number().int().min(1).max(4096),
        rateVersion: z.string().min(1).max(200)
      }).strict().parse(JSON.parse(env.GPT_LIVE_RESPONSES_RATE_CARD_JSON)));
      if (gptLive.rates.usdPerHour * limits.sessionSeconds / 3600 + 4 * gptLive.responses.maxResponseTokens * gptLive.responses.outputText / 1_000_000 >= gptLive.rates.reservationUsd) {
        throw new Error("GPT-Live reservation requires headroom for voice and four maximum delegated responses");
      }
    }
  }
  let cascade: CascadeConfig | null = null;
  if (env.CASCADE_SPEECH_REGION && env.CASCADE_SPEECH_KEY && env.CASCADE_RESPONSES_ENDPOINT && env.CASCADE_RESPONSES_KEY &&
      env.CASCADE_DEPLOYMENT && env.CASCADE_RATE_CARD_JSON && env.CASCADE_DEPLOYMENT_VERIFIED === "true") {
    cascade = {
      speechRegion: z.string().regex(/^[a-z0-9-]{1,50}$/).parse(env.CASCADE_SPEECH_REGION),
      speechKey: env.CASCADE_SPEECH_KEY,
      responsesEndpoint: httpsEndpoint(env.CASCADE_RESPONSES_ENDPOINT)!,
      responsesKey: env.CASCADE_RESPONSES_KEY,
      deployment: z.string().trim().min(1).max(128).parse(env.CASCADE_DEPLOYMENT),
      rates: Object.freeze(cascadeRateSchema.parse(JSON.parse(env.CASCADE_RATE_CARD_JSON)))
    };
  }
  const webEndpoint = httpsEndpoint(env.WEB_IQ_ENDPOINT);
  let webIq: Config["webIq"] = null;
  if (env.WEB_IQ_CONTRACT === "verified-json-search-v1" && env.WEB_IQ_VERIFICATION_URL && webEndpoint && env.WEB_IQ_API_KEY && env.WEB_IQ_AUTH_HEADER && env.WEB_IQ_REQUEST_USD) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(env.WEB_IQ_AUTH_HEADER) || /^(host|cookie|authorization-proxy|content-length)$/i.test(env.WEB_IQ_AUTH_HEADER)) throw new Error("Invalid Web IQ authentication header");
    webIq = { endpoint: webEndpoint, key: env.WEB_IQ_API_KEY, header: env.WEB_IQ_AUTH_HEADER, price: price(env.WEB_IQ_REQUEST_USD)!, verification: httpsEndpoint(env.WEB_IQ_VERIFICATION_URL)! };
  }
  let webIqSearch: WebIqSearchConfig | null = null;
  if (env.WEB_IQ_API_KEY && env.WEB_IQ_RESPONSES_ENDPOINT && env.WEB_IQ_RESPONSES_KEY && env.WEB_IQ_RESPONSES_DEPLOYMENT &&
      env.WEB_IQ_READONLY_TOOLS_JSON && env.WEB_IQ_SEARCH_RATE_CARD_JSON && env.WEB_IQ_SEARCH_VERIFIED === "true") {
    webIqSearch = {
      endpoint: httpsEndpoint(env.WEB_IQ_RESPONSES_ENDPOINT)!,
      key: env.WEB_IQ_RESPONSES_KEY,
      deployment: z.literal("gpt-6.1-sol").parse(env.WEB_IQ_RESPONSES_DEPLOYMENT),
      webIqKey: env.WEB_IQ_API_KEY,
      allowedTools: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).min(1).max(20).parse(JSON.parse(env.WEB_IQ_READONLY_TOOLS_JSON)),
      rates: Object.freeze(webIqSearchRateSchema.parse(JSON.parse(env.WEB_IQ_SEARCH_RATE_CARD_JSON)))
    };
    const { rates: searchRates, ...searchSettings } = webIqSearch;
    validateWebIqSearchSettings({ ...searchSettings, maxOutputTokens: searchRates.maxOutputTokens });
  }
  const config: Config = {
    production, port: z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? 3001),
    origins: (env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",").map(s => s.trim()).filter(Boolean),
    tokenSecret: env.TOKEN_SIGNING_SECRET || (!production ? env.AUTH_SECRET : undefined) || randomBytes(48).toString("base64url"), persistence,
    cosmosEndpoint: httpsEndpoint(env.COSMOS_ENDPOINT), cosmosKey: env.COSMOS_KEY,
    cosmosDatabase: env.COSMOS_DATABASE ?? "car-demo", cosmosContainer: env.COSMOS_CONTAINER ?? "records",
    voiceEndpoint: httpsEndpoint(env.VOICE_LIVE_ENDPOINT), voiceKey: env.VOICE_LIVE_API_KEY,
    voiceIdentity: env.VOICE_LIVE_USE_MANAGED_IDENTITY === "true", voiceRegion: env.VOICE_LIVE_REGION,
    webRtcVerified: env.VOICE_LIVE_WEBRTC_VERIFIED === "true",
    rates, mapsKey: env.AZURE_MAPS_KEY, mapsPrice: price(env.AZURE_MAPS_REQUEST_USD), webIq,
    adminTenant: env.ADMIN_TENANT_ID, adminAudience: env.ADMIN_AUDIENCE, adminRole: env.ADMIN_ROLE ?? "Lead.Admin",
    adminClientId: env.ADMIN_CLIENT_ID, adminScope: env.ADMIN_SCOPE,
    billingScope: costScope(env.AZURE_COST_SCOPE),
    gptLive, cascade, webIqSearch,
    maxConcurrent: z.coerce.number().int().min(1).max(10).parse(env.MAX_CONCURRENT_SESSIONS ?? 1),
    killSwitch: env.EMERGENCY_STOP === "true"
  };
  if (persistence === "cosmos" && !config.cosmosEndpoint) throw new Error("Cosmos mode requires COSMOS_ENDPOINT");
  return config;
}
export function voiceReady(config: Config): boolean {
  const safeReservation = config.rates && config.rates.maxResponseTokens * Math.max(config.rates.outputAudio, config.rates.outputText) / 1_000_000 <= config.rates.reservationUsd * 0.1;
  return Boolean(config.voiceEndpoint && (config.voiceKey || config.voiceIdentity) && config.rates && safeReservation && config.voiceRegion === config.rates.region && !config.killSwitch);
}
export function capabilities(config: Config): Capabilities {
  return {
    persistence: config.persistence,
    voiceTransports: {
      websocket: { status: voiceReady(config) ? "ready" : "unconfigured", reason: "Server-owned PCM16 relay requires configured Voice Live credentials and verified pricing." },
      webrtc: { status: voiceReady(config) && config.webRtcVerified ? "ready" : "pending-verification", reason: "Audio-only preview SDP signaling requires explicit target-resource control, usage and disconnect verification." }
    },
    models: [
      { id: "gpt-realtime-2.1", mode: "realtime", status: voiceReady(config) ? "ready" : "unconfigured", reason: voiceReady(config) ? config.webRtcVerified ? "Voice Live WebRTC preview with server-owned /calls signaling; explicit WebSocket relay also available." : "Voice Live WebSocket relay; implemented WebRTC preview requires deployment verification flag." : "Requires endpoint, server credentials, matching region and verified immutable rate card.", ...(voiceReady(config) ? { actualModel: "gpt-realtime-2.1" } : {}) },
      { id: "gpt-live-1", mode: "realtime", status: config.gptLive && !config.killSwitch ? "ready" : "pending-verification", reason: config.gptLive?.responses ? "Native GPT-Live voice plus explicitly attested gpt-6.1-sol Responses tool delegation. Voice seconds and backend tokens are separately metered; deployment compatibility still requires live verification." : "Separate GPT-Live WebSocket protocol, Entra authentication and cumulative time billing. Requires an attested gpt-live-1 deployment and rate card. Standalone client delegation cannot execute voice tools; UI tools remain available.", ...(config.gptLive && !config.killSwitch ? { actualModel: config.gptLive.responses ? "gpt-live-1 + gpt-6.1-sol (tools)" : "gpt-live-1" } : {}) },
      { id: "gpt-6.1-sol", mode: "cascade", status: config.cascade && !config.killSwitch ? "ready" : "pending-verification", reason: "Explicit WebSocket PCM cascade: Azure Speech recognition, gpt-6.1-sol Responses with confirmed tools, then Azure Speech synthesis. Requires attested deployments and all stage prices; not a native Voice Live model.", ...(config.cascade && !config.killSwitch ? { actualModel: "gpt-6.1-sol" } : {}) }
    ],
    maps: { status: config.mapsKey && config.mapsPrice && !config.killSwitch ? "ready" : "unconfigured", reason: "Real Azure Maps search and driving routes require server key and verified per-request USD price. Route progression is simulated." },
    spotify: { status: "unavailable", reason: "User-clicked external links only. Spotify policy III.3/III.5/III.7 restricts voice control, multi-service streaming and overlapping audio. No documented exception covers this demo; Premium or generic approval is insufficient." },
    webIq: { status: config.webIqSearch && !config.killSwitch ? "ready" : config.webIq ? "pending-verification" : "unconfigured", reason: "Official Web IQ remote MCP via Azure Responses; only operator-reviewed read-only tools, source-backed canonical video URLs and configured prices are accepted. Requires Web IQ access plus an attested gpt-6.1-sol Responses deployment; no substitute search." },
    workIq: { status: "mock", reason: "Stateful fictional data only; never accesses Microsoft 365 or sends email." },
    limits
  };
}
