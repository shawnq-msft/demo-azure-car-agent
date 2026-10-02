import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class ApiError extends Error {
  constructor(public code: string, message: string, public statusCode = 400) { super(message); }
}
const claimsSchema = z.object({ sub: z.string().uuid(), exp: z.number().int(), aud: z.literal("car-demo"), jti: z.string().uuid() }).strict();
export function signToken(visitorId: string, secret: string, now = Date.now()): { token: string; expiresAt: string } {
  const exp = Math.floor(now / 1000) + 24 * 60 * 60;
  const payload = Buffer.from(JSON.stringify({ sub: visitorId, exp, aud: "car-demo", jti: randomUUID() })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return { token: `${payload}.${signature}`, expiresAt: new Date(exp * 1000).toISOString() };
}
export function verifyToken(token: string, secret: string, now = Date.now()): string {
  if (token.length > 4096) throw new ApiError("unauthorized", "Invalid or expired visitor token", 401);
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) throw new ApiError("unauthorized", "Invalid or expired visitor token", 401);
  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ApiError("unauthorized", "Invalid or expired visitor token", 401);
  try {
    const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    if (claims.exp * 1000 <= now) throw new Error("expired");
    return claims.sub;
  } catch { throw new ApiError("unauthorized", "Invalid or expired visitor token", 401); }
}
export class RateLimiter {
  private windows = new Map<string, { count: number; expires: number }>();
  constructor(private max: number, private windowMs: number) {}
  take(key: string, now = Date.now()): void {
    for (const [id, value] of this.windows) if (value.expires <= now) this.windows.delete(id);
    const value = this.windows.get(key) ?? { count: 0, expires: now + this.windowMs };
    if (value.count >= this.max || (!this.windows.has(key) && this.windows.size >= 10000)) throw new ApiError("rate-limited", "Too many requests; try again later", 429);
    value.count++;
    this.windows.set(key, value);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}
