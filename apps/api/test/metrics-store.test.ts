import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store.js";
import { Meter } from "../src/budget.js";

afterEach(() => vi.useRealTimers());
describe("operational metric retention", () => {
  it("retains only structured metric snapshots, expires them, and removes them with a lead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    const store = new MemoryStore();
    const record = {
      id: "usage:visitor", kind: "usage" as const, visitorId: "visitor",
      createdAt: new Date().toISOString(), ttl: 30 * 86400, usage: new Meter(null).summary
    };
    await store.saveUsage(record);
    expect(await store.listUsage()).toHaveLength(1);
    await store.deleteLead("visitor");
    expect(await store.listUsage()).toHaveLength(0);
    await store.saveUsage(record);
    vi.advanceTimersByTime(30 * 86400000);
    expect(await store.listUsage()).toHaveLength(0);
  });
  it("returns detached snapshots so readers cannot mutate stored totals", async () => {
    const store = new MemoryStore();
    await store.saveUsage({
      id: "usage:visitor", kind: "usage", visitorId: "visitor",
      createdAt: new Date().toISOString(), ttl: 30 * 86400, usage: new Meter(null).summary
    });
    const rows = await store.listUsage();
    rows[0]!.usage.turns = 999;
    expect((await store.listUsage())[0]!.usage.turns).toBe(0);
  });
});
