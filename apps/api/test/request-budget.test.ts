import { describe, expect, it } from "vitest";
import { Budget } from "../src/budget.js";
import { MemoryStore } from "../src/store.js";

describe("paid request reservation alongside voice", () => {
  it("debits before service access and settles once without changing voice ownership or time", async () => {
    const budget = new Budget(new MemoryStore());
    const voice = await budget.reserve("visitor", 1);
    const request = await budget.reserveRequest("visitor", 0.2);
    await expect(budget.reserve("visitor", 0.5)).rejects.toMatchObject({ code: "already-active" });
    await request.settle(0.03, true);
    await request.settle(0, true);
    await voice.settle(0.1, 10, true);
    expect((await budget.summary("visitor")).usd).toBeCloseTo(0.13);
    expect((await budget.summary("visitor")).seconds).toBe(10);
  });
  it("retains unknown usage and rejects spending beyond the daily cap", async () => {
    const budget = new Budget(new MemoryStore());
    const request = await budget.reserveRequest("visitor", 1.9);
    await request.settle(0, false);
    expect((await budget.summary("visitor")).usd).toBeCloseTo(1.9);
    await expect(budget.reserveRequest("visitor", 0.2)).rejects.toMatchObject({ code: "quota-exceeded" });
    await expect(request.settle(-1, true)).rejects.toMatchObject({ code: "unknown-usage" });
  });
});
