import { randomUUID } from "node:crypto";
import type { Container } from "@azure/cosmos";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CosmosStore, MemoryStore, type Lead } from "../src/store.js";

const registration = { name: "Example", company: "Example Company", email: "visitor@example.test", scenario: "Fleet cockpit", privacyConsent: true as const, marketingConsent: false, locale: "en-US" as const };
function lead(overrides: Partial<Lead> = {}): Lead {
  return { id: randomUUID(), kind: "lead", createdAt: new Date().toISOString(), ttl: 90 * 86400, registration, ...overrides };
}
afterEach(() => vi.useRealTimers());
describe("administrator lead storage", () => {
  it("paginates all leads deterministically, including identical timestamps and filters", async () => {
    const store = new MemoryStore();
    const rows = Array.from({ length: 7 }, () => lead());
    for (const row of rows) await store.createLead(row);
    await store.updateLead(rows[0]!.id, { status: "qualified", notes: "Requested callback", updatedAt: new Date().toISOString() });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.paginateLeads({ limit: 2, ...(cursor ? { cursor } : {}) });
      seen.push(...page.leads.map(row => row.id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(seen).size).toBe(7); expect(seen).toHaveLength(7);
    expect((await store.paginateLeads({ limit: 5, status: "qualified", company: "EXAMPLE", scenario: "fleet" })).leads.map(row => row.id)).toEqual([rows[0]!.id]);
    expect((await store.paginateLeads({ limit: 10, status: "new" })).leads).toHaveLength(6);
    await expect(store.paginateLeads({ limit: 0 })).rejects.toMatchObject({ statusCode: 400 });
    await expect(store.paginateLeads({ limit: 5, cursor: "invalid" })).rejects.toMatchObject({ statusCode: 400 });
  });
  it("never extends the original absolute retention on follow-up edits", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const store = new MemoryStore(), row = lead();
    await store.createLead(row);
    vi.setSystemTime(new Date("2026-03-01T00:00:00Z"));
    const updated = await store.updateLead(row.id, { status: "contacted", notes: "Follow up", updatedAt: new Date().toISOString() });
    expect(updated.expiresAt).toBe("2026-04-01T00:00:00.000Z");
    updated.registration.name = "Mutated";
    expect((await store.listLeads())[0]!.registration.name).toBe("Example");
    vi.setSystemTime(new Date("2026-04-01T00:00:00Z"));
    expect(await store.listLeads()).toEqual([]);
    await expect(store.updateLead(row.id, { status: "closed", notes: "", updatedAt: new Date().toISOString() })).rejects.toMatchObject({ statusCode: 404 });
  });
  it("uses Cosmos continuation tokens and parameterized filters without TOP truncation", async () => {
    const fetchNext = vi.fn().mockResolvedValue({ resources: [lead()], continuationToken: "opaque-next" });
    const query = vi.fn().mockReturnValue({ fetchNext });
    const store = new CosmosStore({ items: { query } } as unknown as Container);
    const asOf = new Date().toISOString();
    const cursor = Buffer.from(JSON.stringify({ asOf, continuationToken: "opaque-before" })).toString("base64url");
    const result = await store.paginateLeads({ limit: 30, company: "' OR true", scenario: "fleet", status: "new", cursor });
    expect(JSON.parse(Buffer.from(result.nextCursor!, "base64url").toString())).toEqual({ asOf, continuationToken: "opaque-next" });
    expect(query.mock.calls[0]![0].query).not.toContain("TOP");
    expect(query.mock.calls[0]![0].query).not.toContain("' OR true");
    expect(query.mock.calls[0]![0].parameters).toContainEqual({ name: "@company", value: "' OR true" });
    expect(query.mock.calls[0]![1]).toEqual({ maxItemCount: 30, continuationTokenLimitInKB: 4, continuationToken: "opaque-before" });
    expect(query.mock.calls[0]![0].parameters).toContainEqual({ name: "@now", value: asOf });
  });
  it("updates Cosmos TTL to remaining life and preserves it through repeated writes", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-11T00:00:00Z"));
    const original = lead({ createdAt: "2026-01-01T00:00:00.000Z" });
    const read = vi.fn().mockResolvedValue({ resource: { ...original, _etag: "version-1" } });
    const replace = vi.fn().mockResolvedValue({});
    const store = new CosmosStore({ item: () => ({ read, replace }) } as unknown as Container);
    const first = await store.updateLead(original.id, { status: "contacted", notes: "", updatedAt: new Date().toISOString() });
    expect(first.ttl).toBe(80 * 86400); expect(first.expiresAt).toBe("2026-04-01T00:00:00.000Z");
    expect(replace.mock.calls[0]![1]).toEqual({ accessCondition: { type: "IfMatch", condition: "version-1" } });
    read.mockResolvedValue({ resource: { ...first, _etag: "version-2" } });
    vi.setSystemTime(new Date("2026-01-21T00:00:00Z"));
    const second = await store.updateLead(original.id, { status: "qualified", notes: "", updatedAt: new Date().toISOString() });
    expect(second.ttl).toBe(70 * 86400); expect(second.expiresAt).toBe(first.expiresAt);
  });
  it("retries Cosmos optimistic conflicts without recreating deleted leads", async () => {
    const row = lead();
    const read = vi.fn().mockResolvedValueOnce({ resource: { ...row, _etag: "old" } }).mockResolvedValueOnce({});
    const replace = vi.fn().mockRejectedValue({ code: 412 });
    const store = new CosmosStore({ item: () => ({ read, replace }) } as unknown as Container);
    await expect(store.updateLead(row.id, { status: "closed", notes: "", updatedAt: new Date().toISOString() })).rejects.toMatchObject({ statusCode: 404 });
    expect(replace).toHaveBeenCalledTimes(1);
  });
});
