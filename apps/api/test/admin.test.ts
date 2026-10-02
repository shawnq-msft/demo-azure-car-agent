import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { generateKeyPair, SignJWT, type JWTPayload } from "jose";
import Fastify from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore, type Lead } from "../src/store.js";
import { adminPublicConfig, csvCell, registerAdminRoutes, usageSummary } from "../src/admin.js";
import { CostReader, type CostReport } from "../src/billing.js";

const local = vi.hoisted(() => ({ key: null as CryptoKey | null }));
vi.mock("jose", async importOriginal => {
  const original = await importOriginal<typeof import("jose")>();
  return { ...original, createRemoteJWKSet: () => async () => local.key! };
});
const tenant = "11111111-1111-4111-8111-111111111111", client = "22222222-2222-4222-8222-222222222222", audience = "33333333-3333-4333-8333-333333333333";
const configured = () => loadConfig({ ADMIN_TENANT_ID: tenant, ADMIN_CLIENT_ID: client, ADMIN_AUDIENCE: audience, ADMIN_SCOPE: `api://${audience}/Leads.Manage`, TOKEN_SIGNING_SECRET: "admin-test-signing-secret-at-least-32-characters" });
const registration = { name: "Example", company: "Example Company", email: "visitor@example.test", scenario: "Fleet cockpit", privacyConsent: true as const, marketingConsent: false, locale: "en-US" as const };
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
let privateKey: CryptoKey;
beforeAll(async () => { const pair = await generateKeyPair("RS256"); privateKey = pair.privateKey; local.key = pair.publicKey; });
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
async function token(claims: JWTPayload = {}) {
  return new SignJWT({ tid: tenant, azp: client, scp: "Leads.Manage", roles: ["Lead.Admin"], ...claims }).setProtectedHeader({ alg: "RS256" })
    .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`).setAudience(audience).setSubject("operator-id").setIssuedAt().setExpirationTime("5m").sign(privateKey);
}
async function setup(billing = false) {
  const config = configured(), store = new MemoryStore();
  if (billing) config.billingScope = `/subscriptions/${audience}`;
  const app = await buildApp({ config, store });
  apps.push(app); return { app, config, store, headers: { authorization: `Bearer ${await token()}` } };
}
function row(): Lead { return { id: randomUUID(), kind: "lead", createdAt: new Date().toISOString(), ttl: 90 * 86400, registration }; }
describe("Entra administrator operations", () => {
  it("fails closed on partial configuration and publishes no secrets", async () => {
    const config = loadConfig({ ADMIN_TENANT_ID: tenant, ADMIN_AUDIENCE: audience });
    const app = await buildApp({ config, store: new MemoryStore() }); apps.push(app);
    expect(adminPublicConfig(config)).toBeNull();
    expect((await app.inject("/api/admin/config")).json()).toEqual({ configured: false });
    expect((await app.inject("/api/admin/leads")).statusCode).toBe(503);
    const configuredApp = await setup();
    expect((await configuredApp.app.inject("/api/admin/config")).json()).toEqual({ configured: true, tenantId: tenant, clientId: client, scope: `api://${audience}/Leads.Manage` });
  });
  it("requires a cryptographically verified token with tenant, client, role and delegated scope", async () => {
    const { app, headers } = await setup();
    expect((await app.inject("/api/admin/overview")).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/admin/leads", headers: { authorization: "Bearer invalid" } })).statusCode).toBe(403);
    for (const claims of [{ roles: [] }, { scp: "Leads.Read" }, { tid: client }, { azp: tenant }]) {
      expect((await app.inject({ url: "/api/admin/leads", headers: { authorization: `Bearer ${await token(claims)}` } })).statusCode).toBe(403);
    }
    expect((await app.inject({ url: "/api/admin/overview", headers })).statusCode).toBe(200);
  });
  it("bounds and binds signed pagination cursors to filters and rejects tampering", async () => {
    const { app, store, headers } = await setup();
    for (let i = 0; i < 5; i++) await store.createLead(row());
    const first = (await app.inject({ url: "/api/admin/leads?limit=2&company=Example", headers })).json();
    expect(first.leads).toHaveLength(2); expect(first.limit).toBe(2); expect(first.nextCursor).toBeTypeOf("string");
    const second = (await app.inject({ url: `/api/admin/leads?limit=2&company=Example&cursor=${encodeURIComponent(first.nextCursor)}`, headers })).json();
    expect(second.leads).toHaveLength(2);
    expect(second.leads[0].id).not.toBe(first.leads[0].id);
    for (const url of ["/api/admin/leads?limit=201", "/api/admin/leads?limit=0", "/api/admin/leads?unexpected=1",
      `/api/admin/leads?cursor=${encodeURIComponent(first.nextCursor)}`, `/api/admin/leads?company=Example&cursor=x${encodeURIComponent(first.nextCursor)}`]) {
      expect((await app.inject({ url, headers })).statusCode).toBe(400);
    }
  });
  it("saves bounded follow-up notes, filters status, audits hashed identities and never sends mail", async () => {
    const { app, store, headers } = await setup(), lead = row();
    await store.createLead(lead);
    const audit = vi.spyOn(store, "appendAudit");
    const response = await app.inject({ method: "POST", url: `/api/admin/leads/${lead.id}/follow-up`, headers, payload: { status: "qualified", notes: "  Requested demo  " } });
    expect(response.statusCode).toBe(200);
    expect(response.json().lead.followUp).toMatchObject({ status: "qualified", notes: "Requested demo" });
    expect(response.json().emailSent).toBe(false);
    expect(audit.mock.calls[0]![0]).toMatchObject({ actor: expect.stringMatching(/^[a-f0-9]{64}$/), target: expect.stringMatching(/^[a-f0-9]{64}$/), action: "lead.follow-up-requested" });
    expect(JSON.stringify(audit.mock.calls)).not.toContain(registration.email);
    expect((await app.inject({ url: "/api/admin/leads?status=qualified", headers })).json().leads).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/admin/leads/${lead.id}/follow-up`, headers, payload: { status: "qualified", notes: "x".repeat(1001) } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/admin/leads/${lead.id}/follow-up`, headers, payload: { status: "qualified", sendEmail: true } })).statusCode).toBe(400);
  });
  it("exports every page beyond 1000 leads and neutralizes spreadsheet formulas", async () => {
    const { app, store, headers } = await setup();
    const records = Array.from({ length: 1005 }, row);
    records[0]!.registration = { ...registration, company: "  =DANGEROUS()", name: 'Quoted "name"' };
    for (const lead of records) await store.createLead(lead);
    const pagination = vi.spyOn(store, "paginateLeads");
    const response = await app.inject({ url: "/api/admin/leads/export", headers });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body.trim().split("\r\n")).toHaveLength(1006);
    expect(pagination).toHaveBeenCalledTimes(3);
    expect(response.body).toContain("\"'  =DANGEROUS()\"");
    expect(response.body).toContain('"Quoted ""name"""');
    expect(csvCell("\n@SUM(1)")).toBe("\"'\n@SUM(1)\"");
  });
  it("deletes lead and usage and revokes the active visitor token", async () => {
    const { app, store, headers } = await setup();
    const visitor = (await app.inject({ method: "POST", url: "/api/register", payload: registration })).json();
    const visitorHeaders = { authorization: `Bearer ${visitor.token}` };
    await app.inject({ url: "/api/usage", headers: visitorHeaders });
    expect(await store.listUsage()).toHaveLength(1);
    expect((await app.inject({ method: "DELETE", url: `/api/admin/leads/${visitor.visitorId}`, headers })).statusCode).toBe(200);
    expect(await store.listLeads()).toEqual([]); expect(await store.listUsage()).toEqual([]);
    expect((await app.inject({ url: "/api/demo", headers: visitorHeaders })).statusCode).toBe(401);
  });
  it("requires explicit emergency-stop confirmation and remains stopped if auditing fails", async () => {
    const { app, config, store, headers } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/admin/emergency-stop", headers, payload: {} })).statusCode).toBe(400);
    expect(config.killSwitch).toBe(false);
    expect((await app.inject({ method: "POST", url: "/api/admin/emergency-stop", headers, payload: { confirmed: true } })).json()).toEqual({ killSwitch: true, activeSessions: 0 });
    config.killSwitch = false;
    vi.spyOn(store, "appendAudit").mockRejectedValueOnce(new Error("storage unavailable"));
    expect((await app.inject({ method: "POST", url: "/api/admin/emergency-stop", headers, payload: { confirmed: true } })).statusCode).toBe(503);
    expect(config.killSwitch).toBe(true);
  });
  it("sets the kill switch before awaiting termination of every active voice session", async () => {
    const app = Fastify(), config = configured(), store = new MemoryStore();
    let active = 3;
    const stopAll = vi.fn(async () => { expect(config.killSwitch).toBe(true); active = 0; });
    registerAdminRoutes(app, config, store, { activeSessions: () => active, stopAll, deleteVisitor: async () => {} });
    try {
      const response = await app.inject({ method: "POST", url: "/api/admin/emergency-stop", headers: { authorization: `Bearer ${await token()}` }, payload: { confirmed: true } });
      expect(response.statusCode).toBe(200); expect(stopAll).toHaveBeenCalledOnce();
      expect(response.json()).toEqual({ killSwitch: true, activeSessions: 0 });
    } finally { await app.close(); }
  });
  it("keeps unpriced usage unavailable rather than fabricating a zero total", () => {
    expect(usageSummary([])).toMatchObject({ estimatedUsd: null, source: "application-estimates", invoiceReconciled: false });
  });
  it("never invokes billing until administrator authorization, configuration and date validation succeed", async () => {
    const query = vi.spyOn(CostReader.prototype, "query").mockRejectedValue(new Error("Must not query"));
    const { app, headers } = await setup();
    const url = "/api/admin/billing?from=2026-01-01&to=2026-01-31";
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { authorization: "Bearer invalid" } })).statusCode).toBe(403);
    expect((await app.inject({ url, headers })).statusCode).toBe(503);
    expect((await app.inject({ url: "/api/admin/overview", headers })).json().billingConfigured).toBe(false);
    const enabled = await setup(true);
    for (const range of ["from=2026-01-01&to=2026-02-01", "from=2026-02-30&to=2026-03-01", "from=2026-02-02&to=2026-02-01",
      "from=2099-01-01&to=2099-01-01", "from=2026-01-01", "from=2026-01-01&to=2026-01-02&scope=other"]) {
      expect((await enabled.app.inject({ url: `/api/admin/billing?${range}`, headers: enabled.headers })).statusCode).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("returns a protected provisional scope-level billing report and writes a hashed audit event", async () => {
    const report: CostReport = {
      source: "azure-cost-management", scope: `/subscriptions/${audience}`, from: "2026-01-01", to: "2026-01-31", fetchedAt: new Date().toISOString(),
      rows: [{ date: "2026-01-01", service: "Azure Maps", currency: "USD", cost: 1.25 }], totals: [{ currency: "USD", cost: 1.25 }], finalInvoice: false
    };
    const query = vi.spyOn(CostReader.prototype, "query").mockResolvedValue(report);
    const { app, headers, store } = await setup(true), audit = vi.spyOn(store, "appendAudit");
    expect((await app.inject({ url: "/api/admin/overview", headers })).json().billingConfigured).toBe(true);
    const response = await app.inject({ url: "/api/admin/billing?from=2026-01-01&to=2026-01-31", headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual(report);
    expect(query).toHaveBeenCalledWith("2026-01-01", "2026-01-31");
    expect(audit.mock.calls.at(-1)![0]).toMatchObject({ actor: expect.stringMatching(/^[a-f0-9]{64}$/), action: "billing.read" });
  });
});
