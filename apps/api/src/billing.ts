import { DefaultAzureCredential } from "@azure/identity";
import { z } from "zod";
import { ApiError } from "./security.js";
import { readProviderJson } from "./provider-json.js";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const queryResult = z.object({
  properties: z.object({
    columns: z.array(z.object({ name: z.string(), type: z.string() })).max(50),
    rows: z.array(z.array(z.union([z.string(), z.number().finite(), z.null()]))).max(10000),
    nextLink: z.string().nullable().optional()
  })
});
export interface CostRow { date: string; service: string; currency: string; cost: number }
export interface CostReport {
  source: "azure-cost-management"; scope: string; from: string; to: string; fetchedAt: string;
  rows: CostRow[]; totals: Array<{ currency: string; cost: number }>; finalInvoice: false;
}
export function costScope(value?: string): string | undefined {
  if (!value) return undefined;
  if (!/^\/subscriptions\/[0-9a-f-]{36}(?:\/resourceGroups\/[A-Za-z0-9_.()-]{1,90})?$/i.test(value)) {
    throw new Error("AZURE_COST_SCOPE must be a subscription or resource-group ARM scope");
  }
  return value;
}
export function parseCostRows(value: unknown): { rows: CostRow[]; nextLink?: string } {
  const parsed = queryResult.safeParse(value);
  if (!parsed.success) throw new ApiError("billing-schema", "Azure Cost Management returned an unsupported response", 502);
  const { columns, rows, nextLink } = parsed.data.properties;
  const index = (name: string) => columns.findIndex(column => column.name.toLowerCase() === name.toLowerCase());
  const costIndex = index("PreTaxCost"), dateIndex = index("UsageDate"), serviceIndex = index("ServiceName"), currencyIndex = index("Currency");
  if (rows.length && [costIndex, dateIndex, serviceIndex, currencyIndex].some(i => i < 0)) throw new ApiError("billing-schema", "Required cost columns are missing", 502);
  const result = rows.map(row => {
    const cost = row[costIndex], usageDate = String(row[dateIndex]), service = row[serviceIndex], currency = row[currencyIndex];
    const date = `${usageDate.slice(0, 4)}-${usageDate.slice(4, 6)}-${usageDate.slice(6, 8)}`;
    if (typeof cost !== "number" || !/^\d{8}$/.test(usageDate) || !dateSchema.safeParse(date).success ||
        typeof service !== "string" || typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
      throw new ApiError("billing-schema", "Cost row values are invalid", 502);
    }
    return { date, service, currency, cost };
  });
  return { rows: result, ...(nextLink ? { nextLink } : {}) };
}

export class CostReader {
  private cache = new Map<string, { expires: number; report: CostReport }>();
  private pending = new Map<string, Promise<CostReport>>();
  constructor(
    private scope?: string,
    private getToken: () => Promise<string> = async () => {
      const token = await new DefaultAzureCredential().getToken("https://management.azure.com/.default");
      if (!token) throw new ApiError("billing-auth", "Managed identity could not obtain a Cost Management token", 503);
      return token.token;
    },
    private fetcher: typeof fetch = fetch
  ) { this.scope = costScope(scope); }

  async query(from: string, to: string): Promise<CostReport> {
    if (!this.scope) throw new ApiError("billing-unconfigured", "Configure AZURE_COST_SCOPE and grant Cost Management Reader to the backend identity", 503);
    dateSchema.parse(from); dateSchema.parse(to);
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    if (days < 1 || days > 31 || Date.parse(to) > Date.now()) throw new ApiError("billing-range", "Choose a past/current UTC range of 1 to 31 days", 400);
    const key = `${from}:${to}`, cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return structuredClone(cached.report);
    const pending = this.pending.get(key);
    if (pending) return structuredClone(await pending);
    if (this.pending.size >= 2) throw new ApiError("billing-busy", "A billing query is already running; retry later", 429);
    const work = this.load(from, to);
    this.pending.set(key, work);
    try {
      const report = await work;
      for (const [id, entry] of this.cache) if (entry.expires <= Date.now()) this.cache.delete(id);
      if (this.cache.size >= 50) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { expires: Date.now() + 300000, report });
      return structuredClone(report);
    } finally { this.pending.delete(key); }
  }
  private async load(from: string, to: string): Promise<CostReport> {
    const token = await this.getToken();
    const endpoint = new URL(`https://management.azure.com${this.scope}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`);
    const body = JSON.stringify({
      type: "ActualCost", timeframe: "Custom",
      timePeriod: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
      dataset: { granularity: "Daily", aggregation: { totalCost: { name: "PreTaxCost", function: "Sum" } }, grouping: [{ type: "Dimension", name: "ServiceName" }] }
    });
    const rows: CostRow[] = [];
    let next: URL | undefined = endpoint;
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next.href) || seen.size >= 20) throw new ApiError("billing-pagination", "Cost query pagination exceeded its safe bound", 502);
      seen.add(next.href);
      const response = await this.fetcher(next, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body, redirect: "error", signal: AbortSignal.timeout(20000)
      });
      if (response.status === 204) break;
      if (!response.ok) throw new ApiError("billing-unavailable", `Cost Management request failed (${response.status}); verify identity permissions and retry limits`, 503);
      const result = parseCostRows(await readProviderJson(response));
      rows.push(...result.rows);
      if (rows.length > 10000) throw new ApiError("billing-pagination", "Cost report has too many rows; shorten the date range", 502);
      next = result.nextLink ? new URL(result.nextLink) : undefined;
      if (next && (next.origin !== endpoint.origin || next.pathname !== endpoint.pathname || next.username || next.password || next.hash)) {
        throw new ApiError("billing-pagination", "Rejected unexpected cost continuation URL", 502);
      }
    }
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cost);
    return { source: "azure-cost-management", scope: this.scope!, from, to, fetchedAt: new Date().toISOString(), rows, totals: [...totals].map(([currency, cost]) => ({ currency, cost })), finalInvoice: false };
  }
}
