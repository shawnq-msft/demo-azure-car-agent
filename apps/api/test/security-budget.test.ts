import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Adapters, parseVideoUrl } from "../src/adapters.js";
import { signToken, verifyToken } from "../src/security.js";
import { Budget, Meter, parseUsage } from "../src/budget.js";
import { MemoryStore } from "../src/store.js";
import { capabilities, loadConfig, type RateCard } from "../src/config.js";

export const rates: RateCard = Object.freeze({ version: "test-only", source: "https://example.test/pricing", effectiveAt: "2026-01-01T00:00:00Z", model: "gpt-realtime-2.1", region: "test", currency: "USD", inputAudio: 100, outputAudio: 200, inputText: 10, outputText: 20, reservationUsd: 1, maxResponseTokens: 100, verifiedUsageSchema: "response.done-token-details-v1" });
describe("tokens and safe video parsing", () => {
  it("rejects tampering, wrong secret, expiration and extra segments", () => {
    const id = randomUUID(), signed = signToken(id, "secret", 1000);
    expect(verifyToken(signed.token, "secret", 1001)).toBe(id);
    expect(() => verifyToken(signed.token, "wrong", 1001)).toThrow();
    expect(() => verifyToken(`${signed.token}.extra`, "secret", 1001)).toThrow();
    expect(() => verifyToken(signed.token, "secret", 86401000)).toThrow();
  });
  it("canonicalizes allowlisted IDs and rejects hostname tricks, credentials and invalid paths", () => {
    expect(parseVideoUrl("https://youtu.be/dQw4w9WgXcQ?t=12")).toMatchObject({ videoId: "dQw4w9WgXcQ", platform: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    expect(parseVideoUrl("https://www.bilibili.com/video/BV1xx411c7mD/")).toMatchObject({ platform: "bilibili" });
    for (const url of ["https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "https://youtube.com@evil.test/watch?v=dQw4w9WgXcQ", "https://u:p@youtube.com/watch?v=dQw4w9WgXcQ", "http://youtu.be/dQw4w9WgXcQ", "https://youtu.be/short", "https://youtu.be/dQw4w9WgXcQ/evil", "https://youtube.com/watch?v=dQw4w9WgXcQ&v=abcdefghijk", "https://b23.tv/example", "javascript:alert(1)", "https://youtube.com:444/watch?v=dQw4w9WgXcQ"]) expect(parseVideoUrl(url)).toBeNull();
  });
  it("blocks unsafe production memory and missing token secret", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "production", TOKEN_SIGNING_SECRET: "a".repeat(32), PERSISTENCE_MODE: "memory" })).toThrow();
    expect(() => loadConfig({ MAX_REPLICAS: "2" })).toThrow();
    expect(loadConfig({ TOKEN_SIGNING_SECRET: "" }).tokenSecret.length).toBeGreaterThanOrEqual(32);
    expect(loadConfig({ NODE_ENV: "test", AUTH_SECRET: "test-only-signing-secret" }).tokenSecret).toBe("test-only-signing-secret");
  });
  it("never enables undocumented Web IQ from self-attested environment configuration", async () => {
    const config = loadConfig({ WEB_IQ_ENDPOINT: "https://example.test/search", WEB_IQ_API_KEY: "test-key", WEB_IQ_AUTH_HEADER: "api-key", WEB_IQ_CONTRACT: "verified-json-search-v1", WEB_IQ_VERIFICATION_URL: "https://example.test/docs", WEB_IQ_REQUEST_USD: "0.01" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const budget = new Budget(new MemoryStore()), visitor = randomUUID();
    expect(capabilities(config).webIq.status).toBe("pending-verification");
    await expect(new Adapters(config, budget).videos(visitor, { query: "cars", platform: "all" })).rejects.toMatchObject({ code: "web-iq-unverified" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await budget.summary(visitor)).usd).toBe(0);
  });
  it("exposes distinct machine-readable transport gates", () => {
    const config = loadConfig({
      VOICE_LIVE_ENDPOINT: "https://example.test",
      VOICE_LIVE_API_KEY: "test-only",
      VOICE_LIVE_REGION: "test",
      VOICE_RATE_CARD_JSON: JSON.stringify(rates)
    });
    expect(capabilities(config).voiceTransports?.websocket.status).toBe("ready");
    expect(capabilities(config).voiceTransports?.webrtc.status).toBe("pending-verification");
    expect(capabilities({ ...config, webRtcVerified: true }).voiceTransports?.webrtc.status).toBe("ready");
    expect(capabilities({ ...config, webRtcVerified: true, killSwitch: true }).voiceTransports?.webrtc.status).not.toBe("ready");
  });
});
describe("durable-style quota accounting and metering", () => {
  it("deduplicates usage and conservatively prices cached input without inventing discounts", () => {
    const usage = { input_tokens: 12, output_tokens: 23, input_token_details: { audio_tokens: 10, text_tokens: 2, cached_tokens: 0 }, output_token_details: { audio_tokens: 20, text_tokens: 3 } };
    expect(parseUsage(usage, rates).cost).toBeCloseTo(0.00508);
    const meter = new Meter(rates); meter.record("response-1", usage); meter.record("response-1", usage);
    expect(meter.summary.turns).toBe(1); expect(meter.summary.inputTokens).toBe(12);
    expect(() => meter.record("response-2", {})).toThrow();
    const cachedUsage = { ...usage, input_token_details: { ...usage.input_token_details, cached_tokens: 1 } };
    expect(parseUsage(cachedUsage, rates).cost).toBeCloseTo(0.00508);
    meter.record("cached-response", cachedUsage);
    expect(meter.summary.costBasis).toBe("uncached-upper-bound");
    expect(meter.summary.cachedInputTokens).toBe(1);
    expect(() => parseUsage({ ...usage, input_token_details: { ...usage.input_token_details, cached_tokens: 99 } }, rates)).toThrow();
    expect(new Meter(null).summary.estimatedUsd).toBeNull();
  });
  it("serializes reservations, enforces one active session and safely settles once", async () => {
    const budget = new Budget(new MemoryStore()), id = randomUUID();
    const results = await Promise.allSettled([budget.reserve(id, 1), budget.reserve(id, 1)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const success = results.find(result => result.status === "fulfilled");
    if (success?.status !== "fulfilled") throw new Error("reservation missing");
    await success.value.settle(0.25, 30, true);
    await success.value.settle(0.25, 30, true);
    expect(await budget.summary(id)).toMatchObject({ usd: 0.25, seconds: 30 });
  });
  it("retains unknown reservation on interruption and enforces visitor/global caps", async () => {
    const budget = new Budget(new MemoryStore()), id = randomUUID();
    const session = await budget.reserve(id, 2); await session.settle(0, 600, false);
    expect((await budget.summary(id)).usd).toBe(2);
    await expect(budget.charge(id, 0.01)).rejects.toMatchObject({ code: "quota-exceeded" });
    for (let i = 0; i < 24; i++) await budget.charge(randomUUID(), 2);
    await expect(budget.charge(randomUUID(), 0.01)).rejects.toMatchObject({ code: "quota-exceeded" });
  });
  it("does not permit more than twenty daily minutes", async () => {
    const budget = new Budget(new MemoryStore()), id = randomUUID();
    for (let i = 0; i < 2; i++) { const reservation = await budget.reserve(id, 0.1); await reservation.settle(0.01, 600, true); }
    await expect(budget.reserve(id, 0.1)).rejects.toMatchObject({ code: "quota-exceeded" });
  });
  it("accounts any in-flight overrun instead of hiding it at the reservation ceiling", async () => {
    const budget = new Budget(new MemoryStore()), id = randomUUID();
    const reservation = await budget.reserve(id, 1);
    await reservation.settle(2.1, 30, true);
    expect((await budget.summary(id)).usd).toBe(2.1);
    await expect(budget.reserve(id, 0.1)).rejects.toMatchObject({ code: "quota-exceeded" });
  });
});
