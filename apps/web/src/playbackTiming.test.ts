import { afterEach, describe, expect, it, vi } from "vitest";
import { PlaybackTiming } from "./playbackTiming";

afterEach(() => vi.useRealTimers());
describe("observed Web Audio output timing", () => {
  it("reports once only after output reaches the scheduled audio, including output-clock mapping", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    let stamp = { contextTime: 0.9, performanceTime: 900 };
    const context = { state: "running", currentTime: 1, getOutputTimestamp: () => stamp } as AudioContext;
    const timing = new PlaybackTiming(report);
    timing.arm(); timing.scheduled(context, 1);
    vi.advanceTimersByTime(10);
    expect(report).not.toHaveBeenCalled();
    stamp = { contextTime: 1.05, performanceTime: 1100 };
    vi.advanceTimersByTime(10);
    expect(report).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]?.[0]).toBeCloseTo(1050);
    timing.scheduled(context, 2);
    vi.advanceTimersByTime(1000);
    expect(report).toHaveBeenCalledOnce();
  });
  it("does not call scheduled time a measurement when unsupported or cancelled", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const timing = new PlaybackTiming(report);
    timing.arm(); timing.scheduled({ currentTime: 0 } as AudioContext, 1);
    vi.advanceTimersByTime(2000);
    expect(report).not.toHaveBeenCalled();
    timing.arm();
    timing.scheduled({ state: "running", currentTime: 0, getOutputTimestamp: () => ({ contextTime: 1, performanceTime: 1000 }) } as AudioContext, 1);
    timing.cancel();
    vi.advanceTimersByTime(2000);
    expect(report).not.toHaveBeenCalled();
  });
});
