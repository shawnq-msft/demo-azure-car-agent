import { CosmosClient, type Container } from "@azure/cosmos";
import { DefaultAzureCredential } from "@azure/identity";
import type { Registration, UsageSummary } from "@car/contracts";
import type { Config } from "./config.js";
import { ApiError } from "./security.js";

export type FollowUpStatus = "new" | "contacted" | "qualified" | "closed";
export interface FollowUp { status: FollowUpStatus; notes: string; updatedAt: string }
export interface Lead { id: string; kind: "lead"; createdAt: string; ttl: number; expiresAt?: string; registration: Omit<Registration, "website">; followUp?: FollowUp }
export interface LeadPageQuery { limit: number; cursor?: string; company?: string; scenario?: string; status?: FollowUpStatus }
export interface LeadPage { leads: Lead[]; nextCursor: string | null }
export interface VisitorBudget { usd: number; seconds: number; reservation: number; activeUntil: number }
export interface Ledger { id: string; kind: "budget"; ttl: number; usd: number; visitors: Record<string, VisitorBudget>; _etag?: string }
export interface UsageRecord {
  id: string; kind: "usage"; visitorId: string; createdAt: string; ttl: number; usage: UsageSummary;
}
export interface AuditRecord {
  id: string; kind: "audit"; actor: string; action: string; target?: string; createdAt: string; ttl: number;
}
export interface Store {
  createLead(lead: Lead): Promise<void>;
  listLeads(): Promise<Lead[]>;
  paginateLeads(query: LeadPageQuery): Promise<LeadPage>;
  updateLead(id: string, followUp: FollowUp): Promise<Lead>;
  deleteLead(id: string): Promise<void>;
  saveUsage(record: UsageRecord): Promise<void>;
  listUsage(): Promise<UsageRecord[]>;
  appendAudit(record: AuditRecord): Promise<void>;
  transact<T>(day: string, change: (ledger: Ledger) => T): Promise<T>;
}
function empty(day: string): Ledger { return { id: `budget:${day}`, kind: "budget", ttl: 30 * 86400, usd: 0, visitors: {} }; }
function leadExpiry(lead: Lead): number { return Math.min(Date.parse(lead.createdAt) + 90 * 86400000, lead.expiresAt ? Date.parse(lead.expiresAt) : Date.parse(lead.createdAt) + lead.ttl * 1000); }
function checkPage(query: LeadPageQuery): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000) throw new ApiError("invalid-page", "Page size must be between 1 and 1000", 400);
}
export class MemoryStore implements Store {
  private leads = new Map<string, Lead>();
  private ledgers = new Map<string, Ledger>();
  private usage = new Map<string, UsageRecord>();
  private audit = new Map<string, AuditRecord>();
  async createLead(lead: Lead): Promise<void> {
    for (const [id, stored] of this.leads) if (leadExpiry(stored) <= Date.now()) this.leads.delete(id);
    this.leads.set(lead.id, structuredClone(lead));
  }
  async listLeads(): Promise<Lead[]> {
    for (const [id, lead] of this.leads) if (leadExpiry(lead) <= Date.now()) this.leads.delete(id);
    return structuredClone([...this.leads.values()]);
  }
  async paginateLeads(query: LeadPageQuery): Promise<LeadPage> {
    checkPage(query);
    const rows = (await this.listLeads()).filter(lead =>
      (!query.company || lead.registration.company.toLowerCase().includes(query.company.toLowerCase())) &&
      (!query.scenario || lead.registration.scenario.toLowerCase().includes(query.scenario.toLowerCase())) &&
      (!query.status || (lead.followUp?.status ?? "new") === query.status)
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    let after: { createdAt: string; id: string } | undefined;
    if (query.cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (!value || typeof value !== "object" || !("createdAt" in value) || !("id" in value) || typeof value.createdAt !== "string" || typeof value.id !== "string") throw new Error("cursor");
        after = { createdAt: value.createdAt, id: value.id };
      } catch { throw new ApiError("invalid-cursor", "Invalid pagination cursor", 400); }
    }
    const filtered = after ? rows.filter(lead => lead.createdAt < after.createdAt || (lead.createdAt === after.createdAt && lead.id < after.id)) : rows;
    const leads = filtered.slice(0, query.limit), last = leads.at(-1);
    return { leads, nextCursor: filtered.length > leads.length && last ? Buffer.from(JSON.stringify({ createdAt: last.createdAt, id: last.id })).toString("base64url") : null };
  }
  async updateLead(id: string, followUp: FollowUp): Promise<Lead> {
    const lead = this.leads.get(id);
    if (!lead || leadExpiry(lead) <= Date.now()) { this.leads.delete(id); throw new ApiError("lead-not-found", "Lead not found", 404); }
    const updated = { ...lead, expiresAt: new Date(leadExpiry(lead)).toISOString(), followUp: structuredClone(followUp) };
    this.leads.set(id, updated);
    return structuredClone(updated);
  }
  async deleteLead(id: string): Promise<void> { this.leads.delete(id); this.usage.delete(`usage:${id}`); }
  async saveUsage(record: UsageRecord): Promise<void> { this.usage.set(record.id, structuredClone(record)); }
  async listUsage(): Promise<UsageRecord[]> {
    for (const [id, record] of this.usage) if (Date.parse(record.createdAt) + record.ttl * 1000 <= Date.now()) this.usage.delete(id);
    return structuredClone([...this.usage.values()]);
  }
  async appendAudit(record: AuditRecord): Promise<void> {
    for (const [id, stored] of this.audit) if (Date.parse(stored.createdAt) + stored.ttl * 1000 <= Date.now()) this.audit.delete(id);
    this.audit.set(record.id, structuredClone(record));
  }
  async transact<T>(day: string, change: (ledger: Ledger) => T): Promise<T> {
    for (const [id] of this.ledgers) if (Date.parse(id) + 30 * 86400000 < Date.now()) this.ledgers.delete(id);
    const ledger = structuredClone(this.ledgers.get(day) ?? empty(day));
    const result = change(ledger);
    this.ledgers.set(day, ledger);
    return result;
  }
}
export class CosmosStore implements Store {
  constructor(private container: Container) {}
  async createLead(lead: Lead): Promise<void> { await this.container.items.create(lead); }
  async listLeads(): Promise<Lead[]> {
    const leads: Lead[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.paginateLeads({ limit: 1000, ...(cursor ? { cursor } : {}) });
      leads.push(...page.leads); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return leads;
  }
  async paginateLeads(query: LeadPageQuery): Promise<LeadPage> {
    checkPage(query);
    let asOf = new Date().toISOString(), continuationToken: string | undefined;
    if (query.cursor) {
      try {
        const value: unknown = JSON.parse(Buffer.from(query.cursor, "base64url").toString());
        if (!value || typeof value !== "object" || !("asOf" in value) || !("continuationToken" in value) ||
          typeof value.asOf !== "string" || !Number.isFinite(Date.parse(value.asOf)) || typeof value.continuationToken !== "string" || !value.continuationToken) throw new Error("cursor");
        asOf = value.asOf; continuationToken = value.continuationToken;
      } catch { throw new ApiError("invalid-cursor", "Invalid pagination cursor", 400); }
    }
    const clauses = ["c.kind = @kind", "c.createdAt > @cutoff", "(NOT IS_DEFINED(c.expiresAt) OR c.expiresAt > @now)"];
    const parameters: { name: string; value: string }[] = [
      { name: "@kind", value: "lead" }, { name: "@cutoff", value: new Date(Date.parse(asOf) - 90 * 86400000).toISOString() },
      { name: "@now", value: asOf }
    ];
    for (const field of ["company", "scenario"] as const) if (query[field]) {
      clauses.push(`CONTAINS(c.registration.${field}, @${field}, true)`);
      parameters.push({ name: `@${field}`, value: query[field]! });
    }
    if (query.status) {
      clauses.push(query.status === "new" ? "(NOT IS_DEFINED(c.followUp.status) OR c.followUp.status = @status)" : "c.followUp.status = @status");
      parameters.push({ name: "@status", value: query.status });
    }
    const result = await this.container.items.query<Lead>({ query: `SELECT * FROM c WHERE ${clauses.join(" AND ")} ORDER BY c.createdAt DESC`, parameters },
      { maxItemCount: query.limit, continuationTokenLimitInKB: 4, ...(continuationToken ? { continuationToken } : {}) }).fetchNext();
    return { leads: result.resources.filter(lead => leadExpiry(lead) > Date.now()),
      nextCursor: result.continuationToken ? Buffer.from(JSON.stringify({ asOf, continuationToken: result.continuationToken })).toString("base64url") : null };
  }
  async updateLead(id: string, followUp: FollowUp): Promise<Lead> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { resource } = await this.container.item(id, id).read<Lead & { _etag: string }>();
      if (!resource || resource.kind !== "lead" || leadExpiry(resource) <= Date.now()) throw new ApiError("lead-not-found", "Lead not found", 404);
      const expires = leadExpiry(resource);
      const remaining = Math.floor((expires - Date.now()) / 1000);
      if (remaining < 1) throw new ApiError("lead-not-found", "Lead expired", 404);
      const updated: Lead = { id: resource.id, kind: "lead", createdAt: resource.createdAt, registration: resource.registration,
        expiresAt: new Date(expires).toISOString(), ttl: remaining, followUp: structuredClone(followUp) };
      try {
        await this.container.item(id, id).replace(updated, { accessCondition: { type: "IfMatch", condition: resource._etag } });
        return updated;
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (code === 404) throw new ApiError("lead-not-found", "Lead not found", 404);
        if (code !== 412) throw error;
      }
    }
    throw new ApiError("lead-busy", "Lead changed concurrently; reload and retry", 409);
  }
  async deleteLead(id: string): Promise<void> {
    try { await this.container.item(id, id).delete(); } catch (error) { if ((error as { code?: number }).code !== 404) throw error; }
    const metricId = `usage:${id}`;
    try { await this.container.item(metricId, metricId).delete(); } catch (error) { if ((error as { code?: number }).code !== 404) throw error; }
  }
  async saveUsage(record: UsageRecord): Promise<void> { await this.container.items.upsert(record); }
  async listUsage(): Promise<UsageRecord[]> {
    const { resources } = await this.container.items.query<UsageRecord>({
      query: "SELECT * FROM c WHERE c.kind = @kind ORDER BY c.createdAt DESC",
      parameters: [{ name: "@kind", value: "usage" }]
    }).fetchAll();
    return resources.filter(record => Date.parse(record.createdAt) + record.ttl * 1000 > Date.now());
  }
  async appendAudit(record: AuditRecord): Promise<void> { await this.container.items.create(record); }
  async transact<T>(day: string, change: (ledger: Ledger) => T): Promise<T> {
    const id = `budget:${day}`;
    for (let attempt = 0; attempt < 8; attempt++) {
      const { resource } = await this.container.item(id, id).read<Ledger>();
      const ledger = resource ?? empty(day);
      const result = change(ledger);
      try {
        if (resource) await this.container.item(id, id).replace(ledger, { accessCondition: { type: "IfMatch", condition: resource._etag! } });
        else await this.container.items.create(ledger);
        return result;
      } catch (error) { if (![409, 412].includes((error as { code: number }).code)) throw error; }
    }
    throw new ApiError("budget-busy", "Durable budget authorization unavailable", 503);
  }
}
export async function createStore(config: Config): Promise<Store> {
  if (config.persistence === "memory") return new MemoryStore();
  const client = new CosmosClient(config.cosmosKey ? { endpoint: config.cosmosEndpoint!, key: config.cosmosKey } : { endpoint: config.cosmosEndpoint!, aadCredentials: new DefaultAzureCredential() });
  const container = client.database(config.cosmosDatabase).container(config.cosmosContainer);
  const { resource } = await container.read();
  if (resource?.partitionKey?.paths?.join() !== "/id" || resource.defaultTtl === undefined) throw new Error("Cosmos container must use /id partition key and TTL enabled");
  return new CosmosStore(container);
}
