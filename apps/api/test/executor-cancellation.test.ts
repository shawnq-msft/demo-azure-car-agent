import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Adapters } from "../src/adapters.js";
import { Budget } from "../src/budget.js";
import { loadConfig } from "../src/config.js";
import { Executor } from "../src/executor.js";
import { MemoryStore } from "../src/store.js";

afterEach(() => vi.restoreAllMocks());
describe("turn-scoped executor cancellation", () => {
  it("keeps another visitor's paid request alive when one turn aborts", async () => {
    const adapters = new Adapters(loadConfig({ AZURE_MAPS_KEY: "test-key", AZURE_MAPS_REQUEST_USD: "0.01" }), new Budget(new MemoryStore()));
    const pending: { signal: AbortSignal; resolve: (value: Response) => void }[] = [];
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      pending.push({ signal, resolve });
      if (pending.length === 2) ready();
    }));
    const controller = new AbortController();
    const first = new Executor("first", adapters).execute({ callId: randomUUID(), name: "navigation.search", args: { query: "coffee" } }, controller.signal);
    const second = new Executor("second", adapters).execute({ callId: randomUUID(), name: "navigation.search", args: { query: "tea" } });
    await started;
    controller.abort();
    expect((await first).status).toBe("unavailable");
    expect(pending[1]!.signal.aborted).toBe(false);
    pending[1]!.resolve(Response.json({ results: [] }));
    expect((await second).status).toBe("completed");
  });
  it("aborts a paid Maps fetch without retrying it on duplicate delivery", async () => {
    const budget = new Budget(new MemoryStore());
    const executor = new Executor("visitor", new Adapters(loadConfig({ AZURE_MAPS_KEY: "test-key", AZURE_MAPS_REQUEST_USD: "0.01" }), budget));
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      ready();
    }));
    const controller = new AbortController();
    const action = { callId: randomUUID(), name: "navigation.search" as const, args: { query: "coffee" } };
    const work = executor.execute(action, controller.signal);
    await started;
    controller.abort();
    expect((await work).status).toBe("unavailable");
    expect((await executor.execute(action)).status).toBe("unavailable");
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await budget.summary("visitor")).usd).toBeCloseTo(0.01);
  });
  it("binds confirmation to its originating turn and prevents late writes after cancellation", async () => {
    const executor = new Executor("visitor", new Adapters(loadConfig({}), new Budget(new MemoryStore())));
    const controller = new AbortController();
    const action = { callId: randomUUID(), name: "work.sendMail" as const, args: { to: "alex@example.test", subject: "Cancelled", body: "Do not send" } };
    const preview = await executor.execute(action, controller.signal);
    controller.abort();
    await expect(executor.execute({ ...action, confirmationId: preview.confirmationId, confirm: true })).rejects.toMatchObject({ code: "action-cancelled" });
    expect(executor.state.mail.some(mail => mail.subject === "Cancelled")).toBe(false);
    expect((await executor.execute({ ...action, confirmationId: preview.confirmationId, confirm: false })).status).toBe("cancelled");
  });
});
