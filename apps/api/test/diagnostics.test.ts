import { describe, expect, it } from "vitest";
import { Diagnostics } from "../src/diagnostics.js";

describe("content-free conversation diagnostics", () => {
  it("collects only phase metadata and keeps browser measurements separate", () => {
    let now = 0;
    const collector = new Diagnostics(() => now);
    collector.start("gpt-realtime-2.1", "zh-CN", "websocket");
    now = 30;
    collector.event({ type: "voice.event", event: { type: "response.created", response: { id: "private-id" } } });
    collector.event({ type: "voice.event", event: { type: "response.audio_transcript.delta", delta: "PRIVATE TEXT" } });
    collector.event({ type: "voice.event", event: { type: "response.audio_transcript.delta", delta: "MORE PRIVATE TEXT" } });
    now = 45;
    collector.playback(420);
    collector.playback(500);
    const snapshot = collector.snapshot();
    expect(snapshot.observations.filter(item => item.phase === "first-text")).toHaveLength(1);
    expect(snapshot.latency).toEqual({ count: 2, p50Ms: 420, p95Ms: 500 });
    expect(snapshot.observations.at(-1)).toMatchObject({ offsetMs: 45, durationMs: 500, source: "browser" });
    expect(JSON.stringify(snapshot)).not.toContain("PRIVATE");
    expect(JSON.stringify(snapshot)).not.toContain("private-id");
  });
  it("deduplicates completed tool events and bounds the local buffer", () => {
    const collector = new Diagnostics();
    const result = { callId: "demo-call", status: "completed" as const, provider: "mock" as const, message: "Do not store", durationMs: 0.5 };
    collector.tool(result, "work.query");
    collector.tool(result, "work.query");
    expect(collector.snapshot().tools.count).toBe(1);
    for (let i = 0; i < 220; i++) collector.playback(i);
    expect(collector.snapshot().observations).toHaveLength(200);
    expect(() => collector.playback(-1)).toThrow(RangeError);
  });
  it("counts the final media outcome, not successful command dispatch", () => {
    const collector = new Diagnostics();
    collector.tool({ callId: "media-call", status: "completed", provider: "client", message: "Requested", durationMs: 1, data: { execution: "requested" } });
    expect(collector.snapshot().tools.count).toBe(0);
    collector.tool({ callId: "media-call", status: "unavailable", provider: "client", message: "Blocked", durationMs: 12000, data: { outcome: "blocked" } });
    expect(collector.snapshot().tools).toMatchObject({ count: 1, failed: 1, p95Ms: 12000 });
  });
});
