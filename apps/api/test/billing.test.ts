import { describe, expect, it, vi } from "vitest";
import { CostReader, costScope, parseCostRows } from "../src/billing.js";

const scope = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/car-demo";
const payload = (nextLink?: string) => ({ properties: {
  columns: [{ name: "ServiceName", type: "String" }, { name: "Currency", type: "String" }, { name: "UsageDate", type: "Number" }, { name: "PreTaxCost", type: "Number" }],
  rows: [["Azure AI", "USD", 20260901, 1.25]], nextLink
} });
describe("official Cost Management reconciliation", () => {
  it("uses named columns and rejects unsupported values", () => {
    expect(parseCostRows(payload()).rows).toEqual([{ date: "2026-09-01", service: "Azure AI", currency: "USD", cost: 1.25 }]);
    expect(() => parseCostRows({ properties: { columns: [], rows: [[1]] } })).toThrow();
    expect(() => costScope("/subscriptions/invalid/providers/evil")).toThrow();
  });
  it("remains unavailable without a configured scope and never fetches", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(new CostReader(undefined, async () => "test-token", fetcher).query("2026-09-01", "2026-09-02")).rejects.toMatchObject({ code: "billing-unconfigured" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("queries the documented API and caches a detached, provisional report", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload()), { status: 200 }));
    const reader = new CostReader(scope, async () => "test-token", fetcher);
    const report = await reader.query("2026-09-01", "2026-09-02");
    expect(report.finalInvoice).toBe(false);
    expect(report.totals).toEqual([{ currency: "USD", cost: 1.25 }]);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`);
    report.totals[0]!.cost = 999;
    expect((await reader.query("2026-09-01", "2026-09-02")).totals[0]?.cost).toBe(1.25);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects external pagination without forwarding an Azure token", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload("https://evil.example/query")), { status: 200 }));
    await expect(new CostReader(scope, async () => "test-token", fetcher).query("2026-09-01", "2026-09-02")).rejects.toMatchObject({ code: "billing-pagination" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("enforces a bounded UTC date range and propagates provider denial", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    const reader = new CostReader(scope, async () => "test-token", fetcher);
    await expect(reader.query("2026-01-01", "2026-03-01")).rejects.toMatchObject({ code: "billing-range" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(reader.query("2026-09-01", "2026-09-02")).rejects.toMatchObject({ code: "billing-unavailable" });
  });
});
