import { describe, expect, it } from "vitest";
import { capabilities, loadConfig } from "../src/config.js";
import { Meter } from "../src/budget.js";

const evidence = { version: "test-only", source: "https://example.test/pricing", effectiveAt: "2026-09-01T00:00:00Z", reservationUsd: 1 };
const liveEnv = {
  GPT_LIVE_ENDPOINT: "https://demo.openai.azure.com",
  GPT_LIVE_DEPLOYMENT: "verified-live-deployment", GPT_LIVE_REGION: "eastus",
  GPT_LIVE_DEPLOYMENT_VERIFIED: "true",
  GPT_LIVE_RATE_CARD_JSON: JSON.stringify({ ...evidence, usdPerHour: 3 })
};
const cascadeEnv = {
  CASCADE_SPEECH_REGION: "eastus", CASCADE_SPEECH_KEY: "not-a-real-key",
  CASCADE_RESPONSES_ENDPOINT: "https://demo.openai.azure.com",
  CASCADE_RESPONSES_KEY: "not-a-real-key", CASCADE_DEPLOYMENT: "verified-sol-deployment",
  CASCADE_DEPLOYMENT_VERIFIED: "true",
  CASCADE_RATE_CARD_JSON: JSON.stringify({ ...evidence, inputText: 1, outputText: 2, sttUsdPerHour: 1, ttsUsdPerMillionCharacters: 1, maxResponseTokens: 512 })
};
describe("explicit model-specific deployment configuration", () => {
  it("requires credentials, rates and deployment attestation with no silent substitution", () => {
    expect(loadConfig({}).gptLive).toBeNull();
    expect(loadConfig({ ...liveEnv, GPT_LIVE_DEPLOYMENT_VERIFIED: "false" }).gptLive).toBeNull();
    expect(loadConfig({ ...cascadeEnv, CASCADE_RESPONSES_KEY: "" }).cascade).toBeNull();
    const config = loadConfig({ ...liveEnv, ...cascadeEnv });
    expect(config.gptLive?.deployment).toBe("verified-live-deployment");
    expect(config.cascade?.deployment).toBe("verified-sol-deployment");
    expect(capabilities(config).models.map(item => item.status)).toEqual(["unconfigured", "ready", "ready"]);
    expect(capabilities({ ...config, killSwitch: true }).models.every(item => item.status !== "ready")).toBe(true);
  });
  it("rejects underreserved time prices and invalid stage rates", () => {
    expect(() => loadConfig({ ...liveEnv, GPT_LIVE_RATE_CARD_JSON: JSON.stringify({ ...evidence, usdPerHour: 100 }) })).toThrow();
    expect(() => loadConfig({ ...cascadeEnv, CASCADE_RATE_CARD_JSON: JSON.stringify({ ...evidence, inputText: -1 }) })).toThrow();
    expect(() => loadConfig({ ...cascadeEnv, CASCADE_SPEECH_REGION: "eastus/attacker" })).toThrow();
  });
  it("gates optional Responses delegation explicitly and reserves both model costs", () => {
    const responses = { deployment: "gpt-6.1-sol", source: evidence.source, effectiveAt: evidence.effectiveAt, inputText: 1, outputText: 2, maxResponseTokens: 512, rateVersion: "sol-test-v1" };
    const env = { ...liveEnv, GPT_LIVE_RESPONSES_RATE_CARD_JSON: JSON.stringify(responses) };
    expect(loadConfig(env).gptLive?.responses).toBeUndefined();
    expect(() => loadConfig({ ...liveEnv, GPT_LIVE_RESPONSES_DELEGATION_VERIFIED: "true" })).toThrow("requires a rate card");
    expect(loadConfig({ ...env, GPT_LIVE_RESPONSES_DELEGATION_VERIFIED: "true" }).gptLive?.responses).toEqual(responses);
    expect(capabilities(loadConfig({ ...env, GPT_LIVE_RESPONSES_DELEGATION_VERIFIED: "true" })).models[1]?.actualModel).toBe("gpt-live-1 + gpt-6.1-sol (tools)");
    expect(() => loadConfig({ ...env, GPT_LIVE_RESPONSES_DELEGATION_VERIFIED: "true", GPT_LIVE_RESPONSES_RATE_CARD_JSON: JSON.stringify({ ...responses, deployment: "different-model" }) })).toThrow();
    expect(() => loadConfig({ ...env, GPT_LIVE_RESPONSES_DELEGATION_VERIFIED: "true", GPT_LIVE_RESPONSES_RATE_CARD_JSON: JSON.stringify({ ...responses, outputText: 1000 }) })).toThrow();
  });
});
describe("multi-stage metering", () => {
  it("deduplicates prices without requiring a different model's rate card", () => {
    const meter = new Meter(null);
    expect(meter.recordCharge("speech", { cost: 0.01, rateVersion: "stages-v1" })).toBe(0.01);
    expect(meter.recordCharge("speech", { cost: 0.01, rateVersion: "stages-v1" })).toBe(0);
    meter.recordCharge("sol", { cost: 0.02, inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, turns: 1, rateVersion: "stages-v1" });
    expect(meter.summary).toMatchObject({ estimatedUsd: 0.03, inputTokens: 10, outputTokens: 5, turns: 1, cachedInputTokens: 2, costBasis: "uncached-upper-bound", rateVersion: "stages-v1" });
    meter.recordCharge("live", { cost: 0.01, rateVersion: "other-v1" });
    expect(meter.summary.rateVersion).toBe("mixed-rate-versions");
    meter.recordExternalCharge("maps", { cost: 0.03, rateVersion: "maps-v1" });
    expect(meter.knownCost).toBeCloseTo(0.04);
    expect(meter.summary.estimatedUsd).toBeCloseTo(0.07);
    meter.markUnknown();
    meter.recordCharge("later", { cost: 0.01, rateVersion: "other-v1" });
    expect(meter.summary.estimatedUsd).toBeNull();
    expect(() => meter.recordCharge("bad", { cost: Number.NaN, rateVersion: "v1" })).toThrow();
  });
});
