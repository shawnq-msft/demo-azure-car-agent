import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryStore } from "../src/store.js";
import { verifyToken } from "../src/security.js";
import { VoiceSession } from "../src/voice.js";
import { GptLiveSession } from "../src/gpt-live.js";
import { CascadeSession } from "../src/cascade.js";

const registration = { name: "Example", company: "Example Company", email: "visitor@example.test", scenario: "Testing a simulated cockpit", privacyConsent: true, marketingConsent: false, locale: "en-US" };
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
async function setup() {
  const config = loadConfig({ TOKEN_SIGNING_SECRET: "test-secret-long-enough-for-test-only" });
  const app = await buildApp({ config, store: new MemoryStore() }); apps.push(app);
  return { app, config };
}
describe("API integration", () => {
  it("registers with consent, authenticates and exposes honest capability/usage gates", async () => {
    const { app, config } = await setup();
    expect((await app.inject("/api/health")).statusCode).toBe(200);
    expect((await app.inject("/api/demo")).statusCode).toBe(401);
    const response = await app.inject({ method: "POST", url: "/api/register", payload: registration });
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(verifyToken(result.token, config.tokenSecret)).toBe(result.visitorId);
    const headers = { authorization: `Bearer ${result.token}` };
    expect((await app.inject({ url: "/api/demo", headers })).json().vehicle.temperature).toBe(22);
    expect((await app.inject({ url: "/api/usage", headers })).json().estimatedUsd).toBeNull();
    const capabilities = (await app.inject("/api/capabilities")).json();
    expect(capabilities.workIq.status).toBe("mock");
    expect(capabilities.spotify.status).toBe("unavailable");
    expect(capabilities.voiceTransports.webrtc.status).toBe("pending-verification");
    expect(capabilities.voiceTransports.websocket.status).toBe("unconfigured");
    expect(capabilities.models.every((model: any) => model.status !== "ready")).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/actions", headers, payload: { callId: randomUUID(), name: "vehicle.set", args: { temperature: 25 } } })).json().state.vehicle.temperature).toBe(25);
  });
  it("enforces honeypot, consent, rate limiting and strict parameters", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "POST", url: "/api/register", payload: { ...registration, website: "bot.example" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/register", payload: { ...registration, privacyConsent: false } })).statusCode).toBe(400);
    for (let i = 0; i < 3; i++) expect((await app.inject({ method: "POST", url: "/api/register", payload: registration })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/register", payload: registration })).statusCode).toBe(429);
  });
  it("defaults omitted marketing consent to false without relaxing privacy consent", async () => {
    const store = new MemoryStore();
    const app = await buildApp({ config: loadConfig({}), store }); apps.push(app);
    const { marketingConsent: _optional, ...payload } = registration;
    expect((await app.inject({ method: "POST", url: "/api/register", payload })).statusCode).toBe(200);
    expect((await store.listLeads())[0]?.registration.marketingConsent).toBe(false);
    const { privacyConsent: _required, ...invalid } = payload;
    expect((await app.inject({ method: "POST", url: "/api/register", payload: invalid })).statusCode).toBe(400);
  });
  it("requires first-message websocket auth and receives shared state", async () => {
    const { app } = await setup();
    const registered = (await app.inject({ method: "POST", url: "/api/register", payload: registration })).json();
    await app.ready();
    const socket = await app.injectWS("/ws");
    const next = () => new Promise<any>(resolve => socket.once("message", data => resolve(JSON.parse(data.toString()))));
    let message = next(); socket.send(JSON.stringify({ type: "auth", token: registered.token }));
    expect((await message).type).toBe("authenticated");
    message = next(); socket.send(JSON.stringify({ type: "action", action: { callId: randomUUID(), name: "vehicle.set", args: { temperature: 24 } } }));
    expect((await message).result.state.vehicle.temperature).toBe(24);
    message = next(); socket.send(JSON.stringify({ type: "voice.start", model: "gpt-live-1", locale: "en-US", transport: "websocket" }));
    expect((await message).code).toBe("voice-unconfigured");
    socket.close();
  });
  it("does not treat visitor authentication as administrator access", async () => {
    const { app } = await setup();
    expect((await app.inject("/api/admin/leads")).statusCode).toBe(503);
    expect((await app.inject("/api/admin/usage")).statusCode).toBe(503);
  });
  it("routes authenticated media acknowledgements to the active voice session", async () => {
    vi.spyOn(VoiceSession.prototype, "start").mockResolvedValue();
    vi.spyOn(VoiceSession.prototype, "stop").mockResolvedValue();
    const acknowledge = vi.spyOn(VoiceSession.prototype, "mediaResult").mockResolvedValue();
    const { app } = await setup();
    const registered = (await app.inject({ method: "POST", url: "/api/register", payload: registration })).json();
    await app.ready();
    const socket = await app.injectWS("/ws");
    const next = () => new Promise<unknown>(resolve => socket.once("message", data => resolve(JSON.parse(data.toString()))));
    let message = next();
    socket.send(JSON.stringify({ type: "auth", token: registered.token }));
    await message;
    const result = { type: "media.result", callId: randomUUID(), platform: "youtube", command: "play", outcome: "playing", detail: "player-state" };
    vi.spyOn(VoiceSession.prototype, "hasPendingAction").mockImplementation(callId => callId === result.callId);
    message = next();
    socket.send(JSON.stringify({ type: "voice.start", model: "gpt-realtime-2.1", locale: "en-US", transport: "websocket" }));
    socket.send(JSON.stringify(result));
    socket.send(JSON.stringify({ type: "action", action: { callId: randomUUID(), name: "vehicle.set", args: { temperature: 23 } } }));
    await message;
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(result);
    socket.close();
  });
  it("authenticates diagnostic access and exposes no lead or tool content", async () => {
    const { app } = await setup();
    expect((await app.inject("/api/diagnostics")).statusCode).toBe(401);
    const registered = (await app.inject({ method: "POST", url: "/api/register", payload: registration })).json();
    const headers = { authorization: `Bearer ${registered.token}` };
    const action = await app.inject({ method: "POST", url: "/api/actions", headers, payload: { callId: randomUUID(), name: "work.query", args: { kind: "contacts" } } });
    expect(action.json().status).toBe("completed");
    expect(action.body).toContain("Alex Chen");
    const diagnostics = await app.inject({ url: "/api/diagnostics", headers });
    expect(diagnostics.statusCode).toBe(200);
    expect(diagnostics.body).not.toContain("Alex Chen");
    expect(diagnostics.body).not.toContain(registration.email);
    expect(diagnostics.json().retention).toBe("current-demo-memory");
    expect(diagnostics.json().tools.count).toBe(1);
  });
  it("persists de-identified usage without registration or conversation contents", async () => {
    const store = new MemoryStore();
    const app = await buildApp({ config: loadConfig({}), store }); apps.push(app);
    const registered = (await app.inject({ method: "POST", url: "/api/register", payload: registration })).json();
    const response = await app.inject({ url: "/api/usage", headers: { authorization: `Bearer ${registered.token}` } });
    expect(response.statusCode).toBe(200);
    const records = await store.listUsage();
    expect(records).toHaveLength(1);
    expect(records[0]?.ttl).toBe(30 * 86400);
    expect(JSON.stringify(records)).not.toContain(registration.email);
    expect(records[0]?.usage.estimatedUsd).toBeNull();
  });
  it("includes separately charged Maps estimates in the persisted administrator summary", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ results: [{
      id: "place-1", poi: { name: "Test destination" }, position: { lat: 47.6, lon: -122.3 }
    }] }), { status: 200 }));
    const store = new MemoryStore();
    const app = await buildApp({ config: loadConfig({ AZURE_MAPS_KEY: "test-key", AZURE_MAPS_REQUEST_USD: "0.01" }), store });
    apps.push(app);
    const registered = (await app.inject({ method: "POST", url: "/api/register", payload: registration })).json();
    const headers = { authorization: `Bearer ${registered.token}` };
    const action = await app.inject({ method: "POST", url: "/api/actions", headers, payload: { callId: randomUUID(), name: "navigation.search", args: { query: "Test destination" } } });
    expect(action.json().status).toBe("completed");
    expect((await app.inject({ url: "/api/usage", headers })).json().estimatedUsd).toBeCloseTo(0.01);
    expect((await store.listUsage())[0]?.usage.estimatedUsd).toBeCloseTo(0.01);
  });
  it.each(["gpt-live-1", "gpt-6.1-sol"] as const)("selects the %s adapter and preserves the expected PCM signal format", async model => {
    const prototype = model === "gpt-live-1" ? GptLiveSession.prototype : CascadeSession.prototype;
    const start = vi.spyOn(prototype, "start").mockResolvedValue();
    vi.spyOn(prototype, "stop").mockResolvedValue();
    const signal = vi.spyOn(prototype, "signal").mockImplementation(() => {});
    const actionResult = vi.spyOn(prototype, "actionResult");
    const oldStart = vi.spyOn(VoiceSession.prototype, "start");
    const { app } = await setup();
    const registered = (await app.inject({ method: "POST", url: "/api/register", payload: registration })).json();
    await app.ready();
    const socket = await app.injectWS("/ws");
    const next = () => new Promise<unknown>(resolve => socket.once("message", data => resolve(JSON.parse(data.toString()))));
    let message = next();
    socket.send(JSON.stringify({ type: "auth", token: registered.token }));
    await message;
    message = next();
    socket.send(JSON.stringify({ type: "voice.start", model, locale: "en-US", transport: "websocket" }));
    socket.send(JSON.stringify({ type: "voice.signal", event: { type: "input_audio_buffer.append", audio: "AAA=" } }));
    socket.send(JSON.stringify({ type: "action", action: { callId: randomUUID(), name: "vehicle.set", args: { temperature: 24 } } }));
    await message;
    expect(start).toHaveBeenCalledExactlyOnceWith(model, "en-US", "websocket");
    expect(oldStart).not.toHaveBeenCalled();
    expect(actionResult).not.toHaveBeenCalled();
    expect(signal).toHaveBeenCalledExactlyOnceWith({ type: model === "gpt-live-1" ? "session.input_audio.append" : "input_audio_buffer.append", audio: "AAA=" });
    socket.close();
  });
});
