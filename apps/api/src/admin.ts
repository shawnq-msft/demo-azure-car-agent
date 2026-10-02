import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { Config } from "./config.js";
import { ApiError } from "./security.js";
import type { LeadPageQuery, Store, UsageRecord } from "./store.js";
import { CostReader } from "./billing.js";

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const filtersSchema = z.object({
  company: z.string().trim().min(1).max(200).optional(),
  scenario: z.string().trim().min(1).max(500).optional(),
  status: z.enum(["new", "contacted", "qualified", "closed"]).optional()
}).strict();
const pageSchema = filtersSchema.extend({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().min(1).max(16384).optional() });
const followUpSchema = z.object({ status: z.enum(["new", "contacted", "qualified", "closed"]), notes: z.string().trim().max(1000).default("") }).strict();
const idSchema = z.object({ id: z.string().uuid() });
const billingDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
const billingQuerySchema = z.object({ from: billingDate, to: billingDate }).strict().refine(({ from, to }) => {
  const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
  return days >= 1 && days <= 31 && Date.parse(to) <= Date.now();
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function adminPublicConfig(config: Config) {
  if (!config.adminTenant || !guid.test(config.adminTenant) || !config.adminClientId || !guid.test(config.adminClientId) ||
    !config.adminAudience?.trim() || !config.adminScope || !/^(api:\/\/|https:\/\/)[^\s?#]+\/[A-Za-z][A-Za-z0-9_.-]*$/.test(config.adminScope) ||
    config.adminScope.endsWith("/.default") || !config.adminRole.trim()) return null;
  return { tenantId: config.adminTenant, clientId: config.adminClientId, scope: config.adminScope };
}

export function usageSummary(records: UsageRecord[]) {
  const known = records.filter(record => record.usage.estimatedUsd !== null);
  return {
    records: records.length, seconds: records.reduce((sum, record) => sum + record.usage.seconds, 0),
    turns: records.reduce((sum, record) => sum + record.usage.turns, 0),
    partialCountRecords: records.filter(record => record.usage.tokenTurnCoverage === "partial").length,
    estimatedUsd: records.length && known.length === records.length ? known.reduce((sum, record) => sum + (record.usage.estimatedUsd ?? 0), 0) : null,
    knownEstimatedUsd: known.reduce((sum, record) => sum + (record.usage.estimatedUsd ?? 0), 0),
    unpricedRecords: records.length - known.length, currency: "USD", source: "application-estimates", invoiceReconciled: false
  };
}

export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function registerAdminRoutes(app: FastifyInstance, config: Config, store: Store, runtime: {
  activeSessions: () => number; stopAll: () => Promise<void>; deleteVisitor: (id: string) => Promise<void>;
}): void {
  const publicConfig = adminPublicConfig(config);
  const costReader = new CostReader(config.billingScope);
  const jwks = publicConfig ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${publicConfig.tenantId}/discovery/v2.0/keys`)) : null;
  const admin = async (authorization: string | undefined) => {
    if (!publicConfig || !jwks) throw new ApiError("admin-unconfigured", "Complete Entra administrator configuration required", 503);
    if (!authorization?.startsWith("Bearer ")) throw new ApiError("unauthorized", "Entra bearer token required", 401);
    try {
      const { payload } = await jwtVerify(authorization.slice(7), jwks, {
        issuer: `https://login.microsoftonline.com/${publicConfig.tenantId}/v2.0`, audience: config.adminAudience,
        algorithms: ["RS256"], requiredClaims: ["exp", "iat", "sub", "tid", "azp", "scp"]
      });
      const scope = publicConfig.scope.slice(publicConfig.scope.lastIndexOf("/") + 1);
      if (payload.tid !== publicConfig.tenantId || payload.azp !== publicConfig.clientId ||
        !Array.isArray(payload.roles) || !payload.roles.includes(config.adminRole) ||
        typeof payload.scp !== "string" || !payload.scp.split(" ").includes(scope)) throw new Error("authorization");
      return hash(`${payload.tid}:${payload.sub}`);
    } catch { throw new ApiError("forbidden", "Valid Entra administrator role and delegated scope required", 403); }
  };
  const audit = async (actor: string, action: string, target?: string) => store.appendAudit({
    id: randomUUID(), kind: "audit", actor, action, ...(target ? { target: hash(target) } : {}),
    createdAt: new Date().toISOString(), ttl: 30 * 86400
  });
  const filterKey = (query: LeadPageQuery) => hash(JSON.stringify([query.company ?? "", query.scenario ?? "", query.status ?? ""]));
  const signCursor = (cursor: string, query: LeadPageQuery) => {
    const data = Buffer.from(JSON.stringify({ cursor, filters: filterKey(query), expires: Date.now() + 3600000 })).toString("base64url");
    return `${data}.${createHmac("sha256", config.tokenSecret).update(data).digest("base64url")}`;
  };
  const decodeCursor = (cursor: string, query: LeadPageQuery) => {
    try {
      const [data, signature, extra] = cursor.split(".");
      if (!data || !signature || extra) throw new Error("cursor");
      const expected = createHmac("sha256", config.tokenSecret).update(data).digest();
      const received = Buffer.from(signature, "base64url");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("signature");
      const value = z.object({ cursor: z.string().min(1), filters: z.string(), expires: z.number() }).strict().parse(JSON.parse(Buffer.from(data, "base64url").toString()));
      if (value.expires <= Date.now() || value.filters !== filterKey(query)) throw new Error("expired");
      return value.cursor;
    } catch { throw new ApiError("invalid-cursor", "Cursor expired or does not match these filters", 400); }
  };

  app.get("/api/admin/config", async () => publicConfig ? { configured: true, ...publicConfig } : { configured: false });
  app.get("/api/admin/leads", async request => {
    const actor = await admin(request.headers.authorization);
    const query = pageSchema.parse(request.query);
    await audit(actor, "leads.read");
    const page = await store.paginateLeads({ ...query, ...(query.cursor ? { cursor: decodeCursor(query.cursor, query) } : {}) });
    return { leads: page.leads, limit: query.limit, nextCursor: page.nextCursor ? signCursor(page.nextCursor, query) : null };
  });
  app.post("/api/admin/leads/:id/follow-up", async request => {
    const actor = await admin(request.headers.authorization);
    const { id } = idSchema.parse(request.params), followUp = followUpSchema.parse(request.body);
    await audit(actor, "lead.follow-up-requested", id);
    const lead = await store.updateLead(id, { ...followUp, updatedAt: new Date().toISOString() });
    return { lead, emailSent: false };
  });
  app.get("/api/admin/usage", async request => {
    const actor = await admin(request.headers.authorization);
    await audit(actor, "usage.read");
    const records = await store.listUsage();
    return { records: records.slice(0, 1000), limit: 1000, totalRecords: records.length, truncated: records.length > 1000,
      summary: usageSummary(records), source: "application-estimates", invoiceReconciled: false };
  });
  app.get("/api/admin/overview", async request => {
    const actor = await admin(request.headers.authorization);
    await audit(actor, "overview.read");
    return { activeSessions: runtime.activeSessions(), killSwitch: config.killSwitch, billingConfigured: Boolean(config.billingScope), usage: usageSummary(await store.listUsage()) };
  });
  app.get("/api/admin/billing", async request => {
    const actor = await admin(request.headers.authorization);
    const { from, to } = billingQuerySchema.parse(request.query);
    if (!config.billingScope) throw new ApiError("billing-unconfigured", "Configure AZURE_COST_SCOPE and backend Cost Management Reader permissions", 503);
    await audit(actor, "billing.read");
    return costReader.query(from, to);
  });
  app.post("/api/admin/emergency-stop", async request => {
    const actor = await admin(request.headers.authorization);
    z.object({ confirmed: z.literal(true) }).strict().parse(request.body);
    config.killSwitch = true;
    // Safety takes precedence over audit availability; always stop provider sessions.
    const results = await Promise.allSettled([audit(actor, "emergency-stop"), runtime.stopAll()]);
    if (results.some(result => result.status === "rejected")) throw new ApiError("emergency-stop-incomplete", "New calls blocked; stopping sessions or recording audit failed. Verify gateway and provider.", 503);
    return { killSwitch: true, activeSessions: runtime.activeSessions() };
  });
  app.get("/api/admin/leads/export", async (request, reply) => {
    const actor = await admin(request.headers.authorization);
    const filters = filtersSchema.parse(request.query);
    await audit(actor, "leads.export");
    async function* csv() {
      yield "id,createdAt,name,company,email,scenario,phone,timeline,marketingConsent,locale,status,notes,updatedAt\r\n";
      let cursor: string | undefined;
      do {
        const page = await store.paginateLeads({ ...filters, limit: 500, ...(cursor ? { cursor } : {}) });
        for (const lead of page.leads) {
          const r = lead.registration;
          yield [lead.id, lead.createdAt, r.name, r.company, r.email, r.scenario, r.phone, r.timeline, r.marketingConsent, r.locale,
            lead.followUp?.status ?? "new", lead.followUp?.notes ?? "", lead.followUp?.updatedAt ?? ""].map(csvCell).join(",") + "\r\n";
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return reply.type("text/csv; charset=utf-8").header("Content-Disposition", 'attachment; filename="leads.csv"').send(Readable.from(csv()));
  });
  app.delete("/api/admin/leads/:id", async request => {
    const actor = await admin(request.headers.authorization);
    const { id } = idSchema.parse(request.params);
    await audit(actor, "lead.delete-requested", id);
    await runtime.deleteVisitor(id);
    await store.deleteLead(id);
    return { deleted: true };
  });
}
