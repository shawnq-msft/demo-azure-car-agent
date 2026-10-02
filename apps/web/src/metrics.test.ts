import { describe, expect, it } from "vitest";
import { formatReportedCount, percentile } from "./utils";

describe("observed latency percentiles", () => {
  it("distinguishes known zero counts from missing time-billed voice counts", () => {
    expect(formatReportedCount(0, false, "unknown")).toBe("0");
    expect(formatReportedCount(0, true, "unknown")).toBe("unknown");
    expect(formatReportedCount(15, true, "unknown")).toBe(">= 15");
    expect(formatReportedCount(undefined, false, "unknown")).toBe("unknown");
  });
  it("uses nearest-rank percentiles and does not mutate observations", () => {
    const values = [50, 10, 40, 30, 20];
    expect(percentile(values, 0.5)).toBe(30);
    expect(percentile(values, 0.95)).toBe(50);
    expect(values).toEqual([50, 10, 40, 30, 20]);
  });
  it("keeps no samples unknown and removes invalid samples", () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([NaN, -1, Infinity], 0.5)).toBeNull();
    expect(percentile([100, NaN], 0.95)).toBe(100);
    expect(() => percentile([1], 0)).toThrow(RangeError);
  });
});
