import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { registrationSchema, actionSchema, clientEventSchema, type RegistrationResult, type ServerEvent } from "@car/contracts";
import { type Config, capabilities, loadConfig } from "./config.js";
import { ApiError, RateLimiter, signToken, verifyToken } from "./security.js";
import { type Store, createStore } from "./store.js";
import { Budget, Meter } from "./budget.js";
import { Adapters } from "./adapters.js";
import { Executor } from "./executor.js";
import { VoiceSession } from "./voice.js";
import { GptLiveSession } from "./gpt-live.js";
import { CascadeSession } from "./cascade.js";
import { Diagnostics } from "./diagnostics.js";
import { registerAdminRoutes } from "./admin.js";

type ActiveVoice = Pick<VoiceSession, "id" | "estimatedCost" | "start" | "signal" | "hasPendingAction" | "actionResult" | "mediaResult" | "stop">;
interface Visitor {
  id: string; expires: number; executor: Executor; meter: Meter;
  voice?: ActiveVoice; sockets: Set<(event: ServerEvent) => void>; metricsWrites: Promise<void>; diagnostics: Diagnostics;
}
const apiRegistrationSchema = registrationSchema.extend({ marketingConsent: z.boolean().default(false) });
export async function buildApp(options: { config?: Config; store?: Store } = {}) {
  const config = options.config ?? loadConfig();
  const store = options.store ?? await createStore(config);
  const budget = new Budget(store);
  const visitors = new Map<string, Visitor>();
  const adapters = new Adapters(config, budget, (visitorId, id, cost, rateVersion, inputTokens, outputTokens, cachedInputTokens, uncertain) => {
    const visitor = visitors.get(visitorId);
    if (visitor) {
      visitor.meter.recordExternalCharge(id, { cost, rateVersion, inputTokens, outputTokens, cachedInputTokens });
      if (uncertain) visitor.meter.markUnknown();
    }
  });
  const registerLimiter = new RateLimiter(5, 60 * 60 * 1000);
  const actionLimiter = new RateLimiter(120, 60000);
  const connectionLimiter = new RateLimiter(30, 60000);
  const voiceLimiter = new RateLimiter(10, 60000);
  const app = Fastify({ logger: false, bodyLimit: 32768, trustProxy: false, requestTimeout: 15000 });
  await app.register(cors, { origin: config.origins, methods: ["GET", "POST", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type"] });
  await app.register(websocket, { options: { maxPayload: 100000 } });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store").header("X-Content-Type-Options", "nosniff");
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ code: "invalid-request", message: "Request does not match the required schema" });
    if (error instanceof ApiError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    const status = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : 500;
    return reply.code(status >= 400 && status < 500 ? status : 500).send({ code: "request-failed", message: "Request could not be completed safely" });
  });
  const findVisitor = (token: string): Visitor => {
    const id = verifyToken(token, config.tokenSecret);
    const visitor = visitors.get(id);
    if (!visitor || visitor.expires <= Date.now()) throw new ApiError("demo-expired", "Demo state expired or gateway restarted. Register again; previous state is not restored.", 401);
    return visitor;
  };
  const authenticate = (header: string | undefined): Visitor => {
    if (!header?.startsWith("Bearer ")) throw new ApiError("unauthorized", "Bearer visitor token required", 401);
    return findVisitor(header.slice(7));
  };
  const broadcast = (visitor: Visitor, event: ServerEvent) => {
    visitor.diagnostics.event(event);
    for (const send of visitor.sockets) send(event);
  };
  const persistUsage = (visitor: Visitor) => {
    const record = {
      id: `usage:${visitor.id}`, kind: "usage", visitorId: visitor.id,
      createdAt: new Date().toISOString(), ttl: 30 * 86400,
      usage: structuredClone(visitor.meter.summary)
    } as const;
    const write = () => store.saveUsage(record);
    // A later snapshot can retry after a reported storage error, but never overtake an earlier write.
    visitor.metricsWrites = visitor.metricsWrites.then(write, write);
    return visitor.metricsWrites;
  };
  const execute = async (visitor: Visitor, body: unknown) => {
    actionLimiter.take(visitor.id);
    const action = actionSchema.parse(body);
    const result = await visitor.executor.execute(action);
    visitor.diagnostics.tool(result, action.name);
    broadcast(visitor, { type: "action.result", result });
    if (visitor.voice?.hasPendingAction(result.callId)) await visitor.voice.actionResult(result);
    await persistUsage(visitor);
    return result;
  };
  const cleanup = setInterval(() => {
    for (const [id, visitor] of visitors) if (visitor.expires <= Date.now()) { void visitor.voice?.stop("demo-expired"); visitors.delete(id); }
  }, 60000);
  cleanup.unref();
  app.addHook("onClose", async () => { clearInterval(cleanup); adapters.stop(); await Promise.all([...visitors.values()].map(visitor => visitor.voice?.stop("server-shutdown"))); });
  app.get("/api/health", async () => ({ status: "ok", persistence: config.persistence, mock: true }));
  app.get("/api/capabilities", async () => capabilities(config));
  app.post("/api/register", async request => {
    registerLimiter.take(request.ip);
    if (visitors.size >= 1000) throw new ApiError("capacity", "Demo capacity reached; try later", 503);
    const registration = apiRegistrationSchema.parse(request.body);
    const id = randomUUID(), signed = signToken(id, config.tokenSecret);
    const { website: _honeypot, ...fields } = registration;
    await store.createLead({ id, kind: "lead", createdAt: new Date().toISOString(), ttl: 90 * 86400, registration: fields });
    const visitor: Visitor = { id, expires: Date.parse(signed.expiresAt), executor: new Executor(id, adapters), meter: new Meter(config.rates), sockets: new Set(), metricsWrites: Promise.resolve(), diagnostics: new Diagnostics() };
    visitors.set(id, visitor);
    return { ...signed, visitorId: id, demo: visitor.executor.state } satisfies RegistrationResult;
  });
  app.get("/api/demo", async request => authenticate(request.headers.authorization).executor.state);
  app.get("/api/diagnostics", async request => authenticate(request.headers.authorization).diagnostics.snapshot());
  app.get("/api/usage", async request => {
    const visitor = authenticate(request.headers.authorization);
    const daily = await budget.summary(visitor.id);
    await persistUsage(visitor);
    return { ...visitor.meter.summary, seconds: daily.seconds, estimatedUsd: visitor.meter.usageUncertain ? null : config.rates || config.gptLive || config.cascade || config.mapsPrice || config.webIqSearch ? daily.usd + (visitor.voice?.estimatedCost ?? 0) : null };
  });
  app.post("/api/actions", async request => execute(authenticate(request.headers.authorization), request.body));
  app.post("/api/voice/calls", async request => {
    const visitor = authenticate(request.headers.authorization);
    if (!config.webRtcVerified) throw new ApiError("webrtc-unverified", "Target-resource WebRTC control and metering verification required", 503);
    const body = z.object({ sessionId: z.string().uuid(), sdp_offer: z.string().min(20).max(60000) }).strict().parse(request.body);
    if (!visitor.voice || visitor.voice.id !== body.sessionId) throw new ApiError("voice-inactive", "Start an authenticated WebRTC control session on /ws first", 409);
    visitor.voice.signal({ type: "rtc.call.sdp.create", sdp_offer: body.sdp_offer });
    return { accepted: true, sessionId: body.sessionId, answerDelivery: "websocket-voice.event" };
  });
  app.get("/ws", { websocket: true, preValidation: async request => {
    connectionLimiter.take(request.ip);
    if (request.headers.origin && !config.origins.includes(request.headers.origin)) throw new ApiError("origin-denied", "WebSocket origin not permitted", 403);
  } }, (socket) => {
    let visitor: Visitor | undefined;
    let received = 0, pendingMessages = 0, windowStart = Date.now(), queue: Promise<void> = Promise.resolve();
    const send = (event: ServerEvent) => {
      if (socket.readyState === socket.OPEN) {
        if (socket.bufferedAmount > 1024000) { socket.close(1008, "Slow client"); return; }
        socket.send(JSON.stringify(event));
      }
    };
    const timeout = setTimeout(() => socket.close(1008, "Authentication timeout"), 5000);
    timeout.unref();
    socket.on("message", raw => {
      if (Date.now() - windowStart >= 1000) { received = 0; windowStart = Date.now(); }
      if (++received > 80) { socket.close(1008, "Message rate exceeded"); return; }
      if (++pendingMessages > 64) { socket.close(1008, "Message queue exceeded"); return; }
      queue = queue.then(async () => {
        if (socket.readyState !== socket.OPEN) return;
        const event = clientEventSchema.parse(JSON.parse(raw.toString()));
        if (!visitor) {
          if (event.type !== "auth") { socket.close(1008, "Authentication must be first"); return; }
          visitor = findVisitor(event.token);
          if (visitor.sockets.size >= 3) { socket.close(1008, "Too many connections"); return; }
          clearTimeout(timeout); visitor.sockets.add(send);
          send({ type: "authenticated", demo: visitor.executor.state }); return;
        }
        if (visitor.expires <= Date.now() || visitors.get(visitor.id) !== visitor) { socket.close(1008, "Visitor token expired or revoked"); return; }
        if (event.type === "auth") throw new ApiError("already-authenticated", "Connection already authenticated");
        if (event.type === "action") { await execute(visitor, event.action); return; }
        if (event.type === "metrics") { visitor.meter.summary.latencySamples.push(event.latencyMs); visitor.meter.summary.latencySamples = visitor.meter.summary.latencySamples.slice(-50); if (event.basis) visitor.meter.summary.latencyBasis = event.basis; visitor.diagnostics.playback(event.latencyMs); await persistUsage(visitor); return; }
        if (event.type === "media.result") {
          if (visitor.voice?.hasPendingAction(event.callId)) await visitor.voice.mediaResult(event);
          else app.log.debug({ code: "media-result-without-voice" }, "UI-only or late media acknowledgement");
          return;
        }
        if (event.type === "voice.stop") { await visitor.voice?.stop("user-stop"); return; }
        if (event.type === "voice.signal") {
          if (!visitor.voice) throw new ApiError("voice-inactive", "Start a configured voice session first", 409);
          const signal = visitor.voice instanceof GptLiveSession && event.event.type === "input_audio_buffer.append"
            ? { ...event.event, type: "session.input_audio.append" } : event.event;
          visitor.voice.signal(signal); return;
        }
        if (event.type === "voice.start") {
          voiceLimiter.take(visitor.id);
          if (visitor.voice) throw new ApiError("already-active", "Only one active voice session per visitor", 409);
          if ([...visitors.values()].filter(item => item.voice).length >= config.maxConcurrent) throw new ApiError("capacity", "Voice session capacity reached", 429);
          const current = visitor;
          current.diagnostics.start(event.model, event.locale, event.transport);
          const Session = event.model === "gpt-live-1" ? GptLiveSession : event.model === "gpt-6.1-sol" ? CascadeSession : VoiceSession;
          const voice: ActiveVoice = new Session(config, current.id, budget, current.meter, current.executor, event => {
            broadcast(current, event);
            if (event.type === "usage") void persistUsage(current).catch(() => {
              broadcast(current, { type: "error", code: "metrics-persistence-failed", message: "Usage could not be persisted; the displayed live values are not a durable report." });
            });
          }, () => { if (current.voice === voice) current.voice = undefined; });
          current.voice = voice;
          try { await voice.start(event.model, event.locale, event.transport); }
          catch (error) { if (current.voice === voice) current.voice = undefined; throw error; }
        }
      }).catch(error => {
        if (!visitor) socket.close(1008, "Authentication failed");
        else send({ type: "error", code: error instanceof ApiError ? error.code : "invalid-request", message: error instanceof ApiError ? error.message : "Invalid event; operation not performed" });
      }).finally(() => { pendingMessages--; });
    });
    socket.on("close", () => {
      clearTimeout(timeout);
      if (visitor) { visitor.sockets.delete(send); void visitor.voice?.stop("client-disconnected"); }
    });
    socket.on("error", () => { socket.close(); });
  });
  registerAdminRoutes(app, config, store, {
    activeSessions: () => [...visitors.values()].filter(visitor => visitor.voice).length,
    stopAll: async () => {
      adapters.stop();
      const results = await Promise.allSettled([...visitors.values()].map(visitor => visitor.voice?.stop("emergency-stop")));
      if (results.some(result => result.status === "rejected")) throw new Error("Some voice sessions could not stop");
    },
    deleteVisitor: async id => {
      const visitor = visitors.get(id);
      visitors.delete(id);
      await visitor?.voice?.stop("lead-deleted");
      await visitor?.metricsWrites;
    }
  });
  return app;
}
