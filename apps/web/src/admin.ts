import type { Registration } from "@car/contracts";
import type { IPublicClientApplication } from "@azure/msal-browser";
import { apiBase } from "./api";

function redirectUri(): string { return `${location.origin}${location.pathname}?admin-auth=1`; }
// MSAL v5 popup/silent responses use the same-origin redirect bridge, not token parsing.
if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("admin-auth") === "1") {
  void import("@azure/msal-browser/redirect-bridge").then(module => module.broadcastResponseToMainFrame()).catch(() => {
    window.history.replaceState(null, "", window.location.pathname);
  });
}

export const followUpStatuses = ["new", "contacted", "qualified", "closed"] as const;
export type FollowUpStatus = typeof followUpStatuses[number];
export interface AdminConfig { configured: true; tenantId: string; clientId: string; scope: string }
export interface AdminLead {
  id: string; createdAt: string; expiresAt?: string; registration: Omit<Registration, "website">;
  followUp?: { status: FollowUpStatus; notes: string; updatedAt: string };
}
export interface AdminFilters { company: string; scenario: string; status: FollowUpStatus | "" }
export interface AdminPage { leads: AdminLead[]; limit: number; nextCursor: string | null }
export interface AdminOverview {
  activeSessions: number; killSwitch: boolean; billingConfigured: boolean;
  usage: { records: number; seconds: number; turns: number; partialCountRecords?: number; estimatedUsd: number | null; knownEstimatedUsd: number; unpricedRecords: number; currency: string; source: string; invoiceReconciled: boolean };
}
export interface AdminBillingReport {
  source: "azure-cost-management"; scope: string; from: string; to: string; fetchedAt: string;
  rows: Array<{ date: string; service: string; currency: string; cost: number }>;
  totals: Array<{ currency: string; cost: number }>; finalInvoice: false;
}
export function validBillingRange(from: string, to: string, now = Date.now()): boolean {
  for (const value of [from, to]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  return days >= 1 && days <= 31 && Date.parse(to) <= now;
}
export class AdminError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
export function isAdminConfig(value: unknown): value is AdminConfig {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<AdminConfig>, guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return data.configured === true && typeof data.tenantId === "string" && guid.test(data.tenantId) &&
    typeof data.clientId === "string" && guid.test(data.clientId) && typeof data.scope === "string" &&
    /^(api:\/\/|https:\/\/)[^\s?#]+\/[A-Za-z][A-Za-z0-9_.-]*$/.test(data.scope) && !data.scope.endsWith("/.default");
}
export function filterParams(filters: AdminFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const name of ["company", "scenario", "status"] as const) if (filters[name].trim()) params.set(name, filters[name].trim());
  return params;
}
export async function loadAdminConfig(signal: AbortSignal): Promise<AdminConfig | null> {
  const response = await fetch(`${apiBase}/api/admin/config`, { credentials: "omit", cache: "no-store", signal });
  if (!response.ok) return null;
  const value: unknown = await response.json();
  return isAdminConfig(value) ? value : null;
}

export class AdminSession {
  private generation = 0;
  constructor(private client: IPublicClientApplication, private scope: string) {}
  async login(): Promise<void> {
    const generation = this.generation;
    const result = await this.client.loginPopup({ scopes: [this.scope], prompt: "select_account" });
    if (generation !== this.generation) { await this.client.clearCache(); throw new AdminError(401, "login-cancelled"); }
    this.client.setActiveAccount(result.account);
  }
  async clear(): Promise<void> {
    this.generation++;
    this.client.setActiveAccount(null);
    await this.client.clearCache();
  }
  async logout(): Promise<void> {
    this.generation++;
    const account = this.client.getActiveAccount();
    this.client.setActiveAccount(null);
    await this.client.clearCache();
    try { await this.client.logoutPopup({ account, postLogoutRedirectUri: redirectUri() }); }
    finally { await this.client.clearCache(); }
  }
  private async request(path: string, signal: AbortSignal, body?: unknown, method?: "DELETE"): Promise<Response> {
    const account = this.client.getActiveAccount();
    if (!account) throw new AdminError(401, "login-required");
    let accessToken: string;
    try { accessToken = (await this.client.acquireTokenSilent({ account, scopes: [this.scope] })).accessToken; }
    catch { throw new AdminError(401, "login-required"); }
    if (signal.aborted) { await this.client.clearCache(); throw new DOMException("Aborted", "AbortError"); }
    const response = await fetch(`${apiBase}/api/admin${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${accessToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "omit", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(30000)])
    });
    if (!response.ok) throw new AdminError(response.status, "admin-request-failed");
    return response;
  }
  async page(filters: AdminFilters, signal: AbortSignal, cursor?: string): Promise<AdminPage> {
    const query = filterParams(filters); query.set("limit", "50"); if (cursor) query.set("cursor", cursor);
    return (await this.request(`/leads?${query}`, signal)).json() as Promise<AdminPage>;
  }
  async overview(signal: AbortSignal): Promise<AdminOverview> { return (await this.request("/overview", signal)).json() as Promise<AdminOverview>; }
  async billing(from: string, to: string, signal: AbortSignal): Promise<AdminBillingReport> {
    if (!validBillingRange(from, to)) throw new AdminError(400, "billing-range");
    return (await this.request(`/billing?${new URLSearchParams({ from, to })}`, signal)).json() as Promise<AdminBillingReport>;
  }
  async update(id: string, status: FollowUpStatus, notes: string, signal: AbortSignal): Promise<{ lead: AdminLead }> {
    return (await this.request(`/leads/${encodeURIComponent(id)}/follow-up`, signal, { status, notes })).json() as Promise<{ lead: AdminLead }>;
  }
  async delete(id: string, signal: AbortSignal): Promise<void> { await this.request(`/leads/${encodeURIComponent(id)}`, signal, undefined, "DELETE"); }
  async stop(signal: AbortSignal): Promise<void> { await this.request("/emergency-stop", signal, { confirmed: true }); }
  async export(filters: AdminFilters, signal: AbortSignal): Promise<Blob> { return (await this.request(`/leads/export?${filterParams(filters)}`, signal)).blob(); }
}
export async function createAdminSession(config: AdminConfig): Promise<AdminSession> {
  const { PublicClientApplication, BrowserCacheLocation } = await import("@azure/msal-browser");
  const client = new PublicClientApplication({
    auth: { clientId: config.clientId, authority: `https://login.microsoftonline.com/${config.tenantId}`, redirectUri: redirectUri() },
    cache: { cacheLocation: BrowserCacheLocation.MemoryStorage }
  });
  await client.initialize();
  return new AdminSession(client, config.scope);
}
