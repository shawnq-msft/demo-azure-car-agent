import type { UsageSummary } from "@car/contracts";
import { z } from "zod";
import { limits, type RateCard } from "./config.js";
import { ApiError } from "./security.js";
import type { Store, VisitorBudget } from "./store.js";

const tokenDetails = z.object({ audio_tokens: z.number().int().nonnegative(), text_tokens: z.number().int().nonnegative(), cached_tokens: z.number().int().nonnegative().optional() }).passthrough();
const usageSchema = z.object({
  input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative(),
  input_token_details: tokenDetails, output_token_details: tokenDetails
}).passthrough();
const chargeSchema = z.object({
  cost: z.number().finite().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  rateVersion: z.string().min(1).max(200),
  cachedInputTokens: z.number().int().nonnegative().optional()
}).strict();
export function parseUsage(value: unknown, rate: RateCard): { cost: number; input: number; output: number; cachedInput: number } {
  const parsed = usageSchema.safeParse(value);
  if (!parsed.success) throw new ApiError("unknown-usage", "Upstream usage is missing or not a verified token schema", 503);
  const usage = parsed.data;
  const input = usage.input_token_details, output = usage.output_token_details;
  if ((input.cached_tokens ?? 0) > usage.input_tokens || (output.cached_tokens ?? 0) !== 0 || input.audio_tokens + input.text_tokens !== usage.input_tokens || output.audio_tokens + output.text_tokens !== usage.output_tokens) throw new ApiError("unknown-usage", "Unpriced or inconsistent token usage; stopping consumption", 503);
  return {
    cost: (input.audio_tokens * rate.inputAudio + input.text_tokens * rate.inputText + output.audio_tokens * rate.outputAudio + output.text_tokens * rate.outputText) / 1_000_000,
    input: usage.input_tokens, output: usage.output_tokens, cachedInput: input.cached_tokens ?? 0
  };
}
const fresh = (): VisitorBudget => ({ usd: 0, seconds: 0, reservation: 0, activeUntil: 0 });
export class Budget {
  constructor(private store: Store) {}
  async reserveRequest(visitorId: string, amount: number, now = Date.now()): Promise<{ settle: (cost: number, known: boolean) => Promise<void> }> {
    await this.charge(visitorId, amount, now);
    const day = new Date(now).toISOString().slice(0, 10);
    let settlement: Promise<void> | undefined;
    return {
      settle: (cost, known) => {
        if (!Number.isFinite(cost) || cost < 0) return Promise.reject(new ApiError("unknown-usage", "Invalid request settlement", 503));
        if (settlement) return settlement;
        settlement = this.store.transact(day, ledger => {
          const visitor = ledger.visitors[visitorId];
          if (!visitor) throw new ApiError("budget-missing", "Durable request reservation missing", 503);
          const adjustment = Math.max(0, cost - amount) - (known ? Math.max(0, amount - cost) : 0);
          ledger.usd += adjustment;
          visitor.usd += adjustment;
        });
        return settlement;
      }
    };
  }
  async charge(visitorId: string, amount: number, now = Date.now()): Promise<void> {
    if (!Number.isFinite(amount) || amount <= 0) throw new ApiError("unknown-price", "Verified request price required", 503);
    await this.store.transact(new Date(now).toISOString().slice(0, 10), ledger => {
      const visitor = ledger.visitors[visitorId] ?? fresh();
      if (visitor.usd + amount > limits.visitorUsd || ledger.usd + amount > limits.globalUsd) throw new ApiError("quota-exceeded", "Daily estimated USD limit reached", 429);
      ledger.usd += amount; visitor.usd += amount; ledger.visitors[visitorId] = visitor;
    });
  }
  async reserve(visitorId: string, amount: number, now = Date.now()): Promise<Reservation> {
    if (!Number.isFinite(amount) || amount <= 0 || amount > limits.visitorUsd) throw new ApiError("invalid-reservation", "Reservation must be positive and within the visitor USD cap", 503);
    const day = new Date(now).toISOString().slice(0, 10);
    await this.store.transact(day, ledger => {
      const visitor = ledger.visitors[visitorId] ?? fresh();
      if (visitor.activeUntil > now) throw new ApiError("already-active", "Only one active voice session per visitor", 409);
      if (visitor.seconds + limits.sessionSeconds > limits.dailySeconds || visitor.usd + amount > limits.visitorUsd || ledger.usd + amount > limits.globalUsd) throw new ApiError("quota-exceeded", "Daily time or estimated USD limit reached", 429);
      // Debit the entire reservation before opening upstream. A crash never refunds uncertain spend.
      ledger.usd += amount; visitor.usd += amount; visitor.seconds += limits.sessionSeconds;
      visitor.reservation = amount; visitor.activeUntil = now + limits.sessionSeconds * 1000;
      ledger.visitors[visitorId] = visitor;
    });
    let settlement: Promise<void> | undefined;
    return {
      day, amount, started: now,
      settle: (cost, seconds, known) => {
        if (settlement) return settlement;
        settlement = this.store.transact(day, ledger => {
          const visitor = ledger.visitors[visitorId];
          if (!visitor) throw new ApiError("budget-missing", "Durable reservation missing", 503);
          const refund = known ? Math.max(0, amount - cost) : 0;
          const excess = Math.max(0, cost - amount);
          ledger.usd += excess - refund; visitor.usd += excess - refund;
          visitor.seconds -= Math.max(0, limits.sessionSeconds - Math.ceil(Math.min(limits.sessionSeconds, Math.max(0, seconds))));
          visitor.reservation = 0; visitor.activeUntil = 0;
        });
        return settlement;
      }
    };
  }
  async summary(visitorId: string, now = Date.now()): Promise<{ usd: number; seconds: number }> {
    return this.store.transact(new Date(now).toISOString().slice(0, 10), ledger => {
      const visitor = ledger.visitors[visitorId] ?? fresh();
      const active = visitor.activeUntil > now;
      return { usd: visitor.usd - (active ? visitor.reservation : 0), seconds: Math.max(0, Math.ceil(visitor.seconds - (active ? (visitor.activeUntil - now) / 1000 : 0))) };
    });
  }
}
export interface Reservation {
  day: string; amount: number; started: number;
  settle(cost: number, seconds: number, known: boolean): Promise<void>;
}
export class Meter {
  summary: UsageSummary;
  knownCost = 0;
  private externalCost = 0;
  private uncertain = false;
  get usageUncertain(): boolean { return this.uncertain; }
  private responses = new Set<string>();
  constructor(public rate: RateCard | null) {
    this.summary = { seconds: 0, estimatedUsd: rate ? 0 : null, currency: "USD", inputTokens: 0, outputTokens: 0, turns: 0, latencySamples: [], rateVersion: rate?.version ?? null, externalCostsIncluded: false, costBasis: "configured-rates", cachedInputTokens: 0 };
  }
  record(responseId: string, usage: unknown): number {
    if (this.responses.has(responseId)) return 0;
    if (!this.rate || !responseId) throw new ApiError("unknown-usage", "No verified pricing or response ID", 503);
    const parsed = parseUsage(usage, this.rate);
    return this.recordCharge(responseId, {
      cost: parsed.cost, inputTokens: parsed.input, outputTokens: parsed.output, turns: 1,
      rateVersion: this.rate.version, cachedInputTokens: parsed.cachedInput
    });
  }
  recordCharge(id: string, charge: z.infer<typeof chargeSchema>): number {
    return this.recordPricedUsage(id, charge, false);
  }
  recordExternalCharge(id: string, charge: z.infer<typeof chargeSchema>): number {
    return this.recordPricedUsage(id, charge, true);
  }
  private recordPricedUsage(id: string, charge: z.infer<typeof chargeSchema>, external: boolean): number {
    if (!id || id.length > 300) throw new ApiError("unknown-usage", "A bounded usage event ID is required", 503);
    if (this.responses.has(id)) return 0;
    const parsed = chargeSchema.safeParse(charge);
    if (!parsed.success || (parsed.data.cachedInputTokens ?? 0) > (parsed.data.inputTokens ?? 0)) {
      throw new ApiError("unknown-usage", "Invalid priced usage event", 503);
    }
    const value = parsed.data;
    this.summary.rateVersion = this.responses.size && this.summary.rateVersion !== value.rateVersion ? "mixed-rate-versions" : value.rateVersion;
    this.responses.add(id);
    this.summary.inputTokens += value.inputTokens ?? 0;
    this.summary.outputTokens += value.outputTokens ?? 0;
    this.summary.turns += value.turns ?? 0;
    this.summary.cachedInputTokens = (this.summary.cachedInputTokens ?? 0) + (value.cachedInputTokens ?? 0);
    if (value.cachedInputTokens) this.summary.costBasis = "uncached-upper-bound";
    if (external) this.externalCost += value.cost;
    else this.knownCost += value.cost;
    this.summary.estimatedUsd = this.uncertain ? null : this.knownCost + this.externalCost;
    return value.cost;
  }
  markUnknown(): void { this.uncertain = true; this.summary.estimatedUsd = null; }
}
