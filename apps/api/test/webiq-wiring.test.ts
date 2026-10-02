import { afterEach, describe, expect, it, vi } from "vitest";
import { Adapters } from "../src/adapters.js";
import { Budget, Meter } from "../src/budget.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/store.js";
import { searchWebIqVideos } from "../src/webiq-search.js";

vi.mock("../src/webiq-search.js", async importOriginal => {
  const original = await importOriginal<typeof import("../src/webiq-search.js")>();
  return { ...original, searchWebIqVideos: vi.fn() };
});
afterEach(() => vi.clearAllMocks());
function setup() {
  const config = loadConfig({
    WEB_IQ_API_KEY: "test-webiq-key", WEB_IQ_RESPONSES_ENDPOINT: "https://demo.openai.azure.com",
    WEB_IQ_RESPONSES_KEY: "test-responses-key", WEB_IQ_RESPONSES_DEPLOYMENT: "gpt-6.1-sol",
    WEB_IQ_READONLY_TOOLS_JSON: '["reviewed_video_search"]', WEB_IQ_SEARCH_VERIFIED: "true",
    WEB_IQ_SEARCH_RATE_CARD_JSON: JSON.stringify({
      version: "test-only", source: "https://example.test/prices", effectiveAt: "2026-09-01T00:00:00Z",
      reservationUsd: 0.2, inputText: 1, outputText: 2, mcpRequestUsd: 0.01, maxOutputTokens: 128
    })
  });
  const budget = new Budget(new MemoryStore()), meter = new Meter(null);
  const adapters = new Adapters(config, budget, (_visitor, id, cost, rateVersion, inputTokens, outputTokens, cachedInputTokens, uncertain) => {
    meter.recordExternalCharge(id, { cost, rateVersion, inputTokens, outputTokens, cachedInputTokens });
    if (uncertain) meter.markUnknown();
  });
  return { config, budget, meter, adapters };
}
describe("Web IQ action accounting", () => {
  it("reserves before search, refunds known unused funds and never double-charges a voice session", async () => {
    const { adapters, budget, meter } = setup();
    const voice = await budget.reserve("visitor", 1);
    vi.mocked(searchWebIqVideos).mockImplementation(async () => {
      expect((await budget.summary("visitor")).usd).toBeCloseTo(0.2);
      return { videos: [], citations: [], source: "Web IQ", contentIsUntrusted: true, fetchedAt: new Date().toISOString(),
        usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, mcpCalls: 1 } };
    });
    await adapters.videos("visitor", { query: "Cars", platform: "youtube" });
    expect((await budget.summary("visitor")).usd).toBeCloseTo(0.0102);
    expect(meter.summary.estimatedUsd).toBeCloseTo(0.0102);
    expect(meter.knownCost).toBe(0);
    expect(meter.summary.costBasis).toBe("uncached-upper-bound");
    await voice.settle(0.1, 10, true);
    expect((await budget.summary("visitor")).usd).toBeCloseTo(0.1102);
  });
  it("retains uncertain request spend and refuses further activity after emergency stop", async () => {
    const { adapters, budget, meter } = setup();
    vi.mocked(searchWebIqVideos).mockRejectedValue(new Error("Test provider failure"));
    await expect(adapters.videos("visitor", { query: "Cars", platform: "all" })).rejects.toThrow("Test provider failure");
    expect((await budget.summary("visitor")).usd).toBeCloseTo(0.2);
    expect(meter.summary.estimatedUsd).toBeNull();
    adapters.stop();
    await expect(adapters.videos("visitor", { query: "Cars", platform: "all" })).rejects.toMatchObject({ code: "unconfigured" });
    expect(searchWebIqVideos).toHaveBeenCalledTimes(1);
  });
});
