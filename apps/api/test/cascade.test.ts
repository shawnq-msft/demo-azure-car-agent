import { randomUUID } from "node:crypto";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { actionSchema, type Locale, type ServerEvent } from "@car/contracts";
import { CascadeSession, cascadeLimits, cascadePcmEnergy, cascadeSsml, cascadeVoices, cascadeWav } from "../src/cascade.js";
import { loadConfig, type Config } from "../src/config.js";
import { Budget, Meter } from "../src/budget.js";
import { MemoryStore } from "../src/store.js";
import { Executor } from "../src/executor.js";
import { Adapters } from "../src/adapters.js";

const sessions: CascadeSession[] = [];
const rates = { version: "cascade-test-v1", source: "https://example.test/prices", effectiveAt: "2026-01-01T00:00:00Z", inputText: 1, outputText: 2, sttUsdPerHour: 1, ttsUsdPerMillionCharacters: 15, reservationUsd: 1, maxResponseTokens: 100 };
const makeConfig = () => loadConfig({
  CASCADE_SPEECH_REGION: "eastus", CASCADE_SPEECH_KEY: "test-backend-speech-key",
  CASCADE_RESPONSES_ENDPOINT: "https://cascade-test.openai.azure.com/",
  CASCADE_RESPONSES_KEY: "test-backend-responses-key", CASCADE_DEPLOYMENT: "attested-sol-alias",
  CASCADE_DEPLOYMENT_VERIFIED: "true", CASCADE_RATE_CARD_JSON: JSON.stringify(rates)
});
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const recognition = () => json({ RecognitionStatus: "Success", DisplayText: "Please help.", Offset: "0", Duration: "1000000" });
const message = (text = "Hello & welcome.") => ({ type: "message", id: randomUUID(), role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
const fn = (name: string, args: unknown, callId: string = randomUUID()) => ({ type: "function_call", call_id: callId, name, arguments: JSON.stringify(args), status: "completed" });
const previewAction = (data: unknown) => z.object({ action: actionSchema }).parse(data).action;
const completion = (output: unknown[] = [message()], overrides: Record<string, unknown> = {}) => json({
  id: randomUUID(), model: "gpt-6.1-sol", status: "completed", output,
  usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 10 } }, ...overrides
});
const audio = () => new Response(new Uint8Array(4800), { headers: { "Content-Type": "audio/basic" } });
const fetchMock = vi.fn<typeof fetch>();
const requests = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), init }));
const modelRequests = () => requests().filter(request => request.url.endsWith("/responses")).map(request => JSON.parse(String(request.init?.body)));
const voiceEvents = (events: ServerEvent[], type: string) => events.flatMap(event => event.type === "voice.event" && event.event.type === type ? [event.event] : []);
const actionEvents = (events: ServerEvent[]) => events.flatMap(event => event.type === "action.result" ? [event.result] : []);
const flush = async () => { for (let i = 0; i < 30; i++) await yieldToIo(); };
function pcm(ms: number, value = 4000): Buffer {
  const result = Buffer.alloc(ms * 48);
  for (let i = 0; i < result.length; i += 2) result.writeInt16LE(value, i);
  return result;
}
function utterance(session: CascadeSession): void {
  session.signal({ type: "input_audio_buffer.append", audio: Buffer.concat([pcm(100), pcm(500, 0)]).toString("base64") });
}
async function setup(options: { config?: Config; locale?: Locale; start?: boolean; emit?: (event: ServerEvent) => void } = {}) {
  const config = options.config ?? makeConfig(), store = new MemoryStore(), budget = new Budget(store);
  const meter = new Meter(null), visitorId = randomUUID(), executor = new Executor(visitorId, new Adapters(config, budget));
  const events: ServerEvent[] = [], onEnd = vi.fn();
  const session = new CascadeSession(config, visitorId, budget, meter, executor, event => {
    events.push(structuredClone(event)); options.emit?.(event);
  }, onEnd);
  sessions.push(session);
  if (options.start !== false) await session.start("gpt-6.1-sol", options.locale ?? "en-US", "websocket");
  return { config, store, budget, meter, visitorId, executor, events, onEnd, session };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion() : audio());
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.stop("test-finished")));
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers();
});

describe("cascade PCM, REST encoding and locale selection", () => {
  it("encodes actual 24 kHz input as 16 kHz mono PCM WAV with exact duration and RIFF sizes", () => {
    const wav = cascadeWav(pcm(1000));
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(32000);
    expect(wav.readInt16LE(100)).toBe(4000);
    expect(cascadePcmEnergy(pcm(20, 0))).toBe(0);
    expect(cascadePcmEnergy(pcm(20))).toBeCloseTo(4000 / 32768);
    expect(() => cascadeWav(Buffer.alloc(1))).toThrow();
    expect(() => cascadeWav(Buffer.alloc(30 * 48000 + 2))).toThrow();
  });
  it("attenuates above-Nyquist input rather than aliasing it into recognition", () => {
    const tone = (hz: number) => {
      const samples = Buffer.alloc(4800);
      for (let i = 0; i < 2400; i++) samples.writeInt16LE(Math.round(10000 * Math.sin(i * 2 * Math.PI * hz / 24000)), i * 2);
      return cascadeWav(samples).subarray(44 + 100, -100);
    };
    expect(cascadePcmEnergy(tone(10000))).toBeLessThan(cascadePcmEnergy(tone(1000)) * 0.03);
  });
  it.each(Object.entries(cascadeVoices))("selects a locale-specific standard Neural voice for %s", (locale, voice) => {
    const ssml = cascadeSsml(`<tag x="a">'&</tag>`, locale as Locale);
    expect(ssml).toContain(`name="${voice}"`);
    expect(ssml).toContain("&lt;tag x=&quot;a&quot;&gt;&apos;&amp;&lt;/tag&gt;");
    expect(ssml).not.toContain("<tag");
    expect(() => cascadeSsml("\u0000", locale as Locale)).toThrow();
    expect(() => cascadeSsml("x".repeat(1201), locale as Locale)).toThrow();
  });
  it("performs only STT -> Responses -> TTS, emits correlated actual output and accounts each stage", async () => {
    const { session, events, meter, budget, visitorId } = await setup({ locale: "ja-JP" });
    utterance(session); await flush();
    expect(requests().map(request => request.url)).toEqual([
      "https://eastus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=ja-JP&format=simple",
      "https://cascade-test.openai.azure.com/openai/v1/responses",
      "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1"
    ]);
    for (const request of requests()) {
      expect(request.init?.redirect).toBe("error");
      expect(request.init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(requests()[0]!.init?.headers).toMatchObject({ "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000" });
    expect(modelRequests()[0]).toMatchObject({ model: "attested-sol-alias", store: false, stream: false, parallel_tool_calls: false, max_output_tokens: 100 });
    expect(modelRequests()[0].tools).toHaveLength(14);
    expect(modelRequests()[0].tools.every((tool: { type: string; name: string }) => tool.type === "function" && tool.name)).toBe(true);
    expect(modelRequests()[0]).not.toHaveProperty("previous_response_id");
    expect(requests()[2]!.init?.headers).toMatchObject({ "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm" });
    expect(requests()[2]!.init?.body).toContain("ja-JP-NanamiNeural");
    const started = voiceEvents(events, "input_audio_buffer.speech_started")[0]!;
    expect(voiceEvents(events, "input_audio_buffer.speech_stopped")[0]?.item_id).toBe(started.item_id);
    expect(voiceEvents(events, "conversation.item.input_audio_transcription.completed")[0]?.item_id).toBe(started.item_id);
    const delta = voiceEvents(events, "response.audio.delta")[0]!;
    expect(Buffer.from(String(delta.delta), "base64").length).toBe(4800);
    expect(voiceEvents(events, "response.audio.done")[0]).toMatchObject({ item_id: delta.item_id, response_id: delta.response_id, source: "server-cascade" });
    expect(voiceEvents(events, "response.done")[0]).toMatchObject({ response: { id: delta.response_id, status: "completed", usage_status: "estimated" } });
    expect(voiceEvents(events, "cascade.usage").map(event => event.stage)).toEqual(["stt", "responses", "tts"]);
    expect(voiceEvents(events, "cascade.usage")[0]).toMatchObject({ durationSeconds: 0.6, rateVersion: rates.version, rateSource: rates.source, source: "server-cascade" });
    expect(meter.summary).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 10, turns: 1, costBasis: "uncached-upper-bound" });
    expect(session.estimatedCost).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("test-backend");
    await session.stop("done");
    expect((await budget.summary(visitorId)).usd).toBeCloseTo(session.estimatedCost);
  });
  it("detects speech independent of network frame boundaries and ignores silence", async () => {
    const { session, events } = await setup();
    session.signal({ type: "input_audio_buffer.append", audio: pcm(300, 0).toString("base64") });
    expect(fetchMock).not.toHaveBeenCalled();
    const speech = pcm(100);
    for (let i = 0; i < speech.length; i += 160) session.signal({ type: "input_audio_buffer.append", audio: speech.subarray(i, i + 160).toString("base64") });
    session.signal({ type: "input_audio_buffer.append", audio: pcm(500, 0).toString("base64") });
    await flush();
    expect(voiceEvents(events, "input_audio_buffer.speech_started")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("rejects WebRTC, native models, absent attestation and client tool/session injection before payment", async () => {
    const { session, budget } = await setup({ start: false });
    const reserve = vi.spyOn(budget, "reserve");
    await expect(session.start("gpt-6.1-sol", "en-US", "webrtc")).rejects.toThrow("WebRTC");
    await expect(session.start("gpt-realtime-2.1", "en-US", "websocket")).rejects.toThrow();
    expect(reserve).not.toHaveBeenCalled();
    const noConfig = await setup({ start: false, config: loadConfig({}) });
    await expect(noConfig.session.start("gpt-6.1-sol", "en-US", "websocket")).rejects.toThrow();
    await session.start("gpt-6.1-sol", "en-US", "websocket");
    expect(() => session.signal({ type: "session.update", tools: [] })).toThrow();
    expect(() => session.signal({ type: "conversation.item.create", item: { type: "function_call_output" } })).toThrow();
    expect(() => session.signal({ type: "input_audio_buffer.append", audio: "AA==" })).toThrow();
    expect(() => session.signal({ type: "input_audio_buffer.append", audio: "AB==" })).toThrow();
  });
});

describe("cascade tools, confirmation and bounded conversation", () => {
  it("awaits only readiness at startup and releases an app-style queue before UI confirmation", async () => {
    let round = 0;
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses")
      ? completion(++round === 1 ? [fn("work_reset", {}, "queued-confirmation")] : [message("The fictional workspace was reset.")]) : audio());
    const { session, executor, events } = await setup({ start: false });
    let queue = Promise.resolve();
    const enqueue = (work: () => void | Promise<void>) => { queue = queue.then(work); return queue; };
    await enqueue(() => session.start("gpt-6.1-sol", "en-US", "websocket"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "voice.started", sessionId: session.id, model: "gpt-6.1-sol", transport: "websocket" });
    await enqueue(() => utterance(session));
    await flush();
    const preview = actionEvents(events)[0]!;
    expect(preview.status).toBe("confirmation-required");
    expect(modelRequests()).toHaveLength(1);
    await enqueue(async () => {
      const action = { ...previewAction(preview.data), confirmationId: preview.confirmationId, confirm: true };
      await session.actionResult(await executor.execute(action));
    });
    await flush();
    expect(modelRequests()).toHaveLength(2);
    expect(voiceEvents(events, "response.done")[0]).toMatchObject({ response: { status: "completed" } });
  });
  it("runs validated tools through Executor and waits for matching UI confirmation without losing input", async () => {
    let round = 0;
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses")
      ? completion(++round === 1 ? [fn("work_sendMail", { to: "alex@example.test", subject: "Mock", body: "Fictional" }, "upstream-mail")] : [message("The simulated mail was added.")]) : audio());
    const { session, executor, events } = await setup();
    utterance(session); await flush();
    const preview = actionEvents(events)[0]!;
    expect(preview.status).toBe("confirmation-required");
    expect(modelRequests()).toHaveLength(1);
    utterance(session); await flush();
    expect(modelRequests()).toHaveLength(1);
    expect(() => session.signal({ type: "input_audio_buffer.commit" })).not.toThrow();
    await session.actionResult({ ...preview, callId: randomUUID(), status: "completed" });
    expect(modelRequests()).toHaveLength(1);
    const action = actionSchema.parse({ ...previewAction(preview.data), confirmationId: preview.confirmationId, confirm: true });
    const result = await executor.execute(action);
    await session.actionResult(result); await flush();
    expect(executor.state.mail.filter(mail => mail.sent)).toHaveLength(1);
    const input = modelRequests()[1].input;
    expect(input[0]).toMatchObject({ role: "user", content: "Please help." });
    expect(input.find((item: { type?: string }) => item.type === "function_call_output")).toMatchObject({ call_id: "upstream-mail" });
    expect(JSON.stringify(input)).toContain("completed");
    expect(voiceEvents(events, "response.done")).toHaveLength(1);
  });
  it("returns validation failures and Spotify restrictions as tool failures, never fabricated success", async () => {
    let round = 0;
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion(
      ++round === 1 ? [fn("vehicle_set", { temperature: 99 }), fn("media_control", { platform: "spotify", command: "play" })] : [message("Those actions are unavailable.")]
    ) : audio());
    const { session, executor, events } = await setup();
    utterance(session); await flush();
    expect(executor.state.vehicle.temperature).toBe(22);
    expect(actionEvents(events).every(event => event.status === "unavailable")).toBe(true);
    expect(modelRequests()[1].input.filter((item: { type?: string }) => item.type === "function_call_output")).toHaveLength(2);
    expect(JSON.stringify(modelRequests()[1])).toContain("Spotify");
  });
  it("passes cancellation to paid adapters while preserving their configuration gates", async () => {
    let round = 0;
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion(
      ++round === 1 ? [fn("navigation_search", { query: "coffee" }), fn("video_search", { query: "cars", platform: "youtube" })] : [message("Provider tools are unavailable.")]
    ) : audio());
    const { session, executor, events } = await setup();
    const execute = vi.spyOn(executor, "execute");
    utterance(session); await flush();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.every(call => call[1] instanceof AbortSignal)).toBe(true);
    expect(actionEvents(events)).toHaveLength(2);
    expect(actionEvents(events).every(result => result.status === "unavailable")).toBe(true);
    expect(requests().some(request => request.url.includes("atlas.microsoft.com"))).toBe(false);
  });
  it("holds media output until a correlated receipt proves the requested outcome", async () => {
    let round = 0;
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion(
      ++round === 1 ? [fn("media_control", { platform: "youtube", command: "play" }, "media-call")] : [message()]
    ) : audio());
    const { session, events } = await setup();
    utterance(session); await flush();
    const request = actionEvents(events)[0]!;
    const receipt = { type: "media.result", callId: request.callId, platform: "youtube", command: "play", outcome: "playing", detail: "player-state" } as const;
    await session.mediaResult({ ...receipt, callId: randomUUID() });
    await session.mediaResult({ ...receipt, detail: "player-ready" });
    expect(modelRequests()).toHaveLength(1);
    await session.mediaResult(receipt); await flush();
    expect(JSON.stringify(modelRequests()[1].input)).toContain('"playbackConfirmed\\":true');
    expect(actionEvents(events).at(-1)?.data).toMatchObject({ playbackConfirmed: true, outcome: "playing" });
  });
  it("reports missing media receipt as unavailable after TTL", async () => {
    let round = 0;
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion(
      ++round === 1 ? [fn("media_control", { platform: "youtube", command: "play" })] : [message()]
    ) : audio());
    const { session, events } = await setup();
    utterance(session); await flush();
    await vi.advanceTimersByTimeAsync(20000); await flush();
    expect(actionEvents(events).at(-1)).toMatchObject({ status: "unavailable", data: { detail: "timeout", playbackConfirmed: false } });
    expect(modelRequests()).toHaveLength(2);
  });
  it("expires confirmation and does not execute the write", async () => {
    let round = 0;
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion(
      ++round === 1 ? [fn("work_reset", {})] : [message("Confirmation expired.")]
    ) : audio());
    const { session, executor, events } = await setup();
    utterance(session); await flush();
    await vi.advanceTimersByTimeAsync(60000); await flush();
    expect(executor.state.revision).toBe(0);
    expect(actionEvents(events).at(-1)?.status).toBe("cancelled");
    expect(modelRequests()).toHaveLength(2);
  });
  it("invalidates pending writes on stop, even if their original confirmation is replayed", async () => {
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : completion([fn("work_reset", {})]));
    const { session, executor, events, onEnd } = await setup();
    utterance(session); await flush();
    const preview = actionEvents(events)[0]!;
    await session.stop("user-stop");
    const replay = await executor.execute(actionSchema.parse({ ...previewAction(preview.data), confirmationId: preview.confirmationId, confirm: true }));
    expect(replay.status).toBe("cancelled");
    expect(executor.state.revision).toBe(0);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(modelRequests()).toHaveLength(1);
    expect(voiceEvents(events, "response.done")[0]).toMatchObject({ response: { status: "cancelled" } });
  });
  it("bounds stateless history and preserves complete recent turns", async () => {
    const { session } = await setup();
    for (let i = 0; i < 8; i++) {
      utterance(session); await flush();
      await vi.advanceTimersByTimeAsync(1100);
    }
    const bodies = modelRequests();
    expect(bodies).toHaveLength(8);
    expect(bodies.at(-1).input.filter((item: { role?: string }) => item.role === "user")).toHaveLength(7);
    expect(bodies.every(body => Buffer.byteLength(JSON.stringify(body)) <= cascadeLimits.requestBytes)).toBe(true);
    expect(bodies.every(body => body.store === false && !body.previous_response_id)).toBe(true);
  });
});

describe("cascade cancellation and fail-closed accounting", () => {
  it("preserves elapsed time across consecutive sessions sharing a visitor meter", async () => {
    const { session, config, budget, meter, visitorId, executor } = await setup();
    await vi.advanceTimersByTimeAsync(3000);
    await session.stop("user-ended");
    expect(meter.summary.seconds).toBe(3);
    const next = new CascadeSession(config, visitorId, budget, meter, executor, () => {}, () => {});
    sessions.push(next);
    await next.start("gpt-6.1-sol", "en-US", "websocket");
    await vi.advanceTimersByTimeAsync(2000);
    await next.stop("user-ended");
    expect(meter.summary.seconds).toBe(5);
  });
  it("refuses startup with uncertain shared usage before reserving funds", async () => {
    const { session, budget, meter } = await setup({ start: false });
    const reserve = vi.spyOn(budget, "reserve");
    meter.markUnknown();
    await expect(session.start("gpt-6.1-sol", "en-US", "websocket")).rejects.toThrow("uncertain");
    expect(reserve).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("aborts in-flight paid work when the parent meter becomes uncertain and retains the reservation", async () => {
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const { session, meter, budget, visitorId, events } = await setup();
    utterance(session); await flush();
    meter.markUnknown();
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(signal?.aborted).toBe(true);
    expect(meter.usageUncertain).toBe(true);
    expect((await budget.summary(visitorId)).usd).toBe(1);
    expect(events).toContainEqual({ type: "voice.ended", reason: "unknown-usage" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("never settles shared uncertain usage as known when stopping between paid stages", async () => {
    const { session, meter, budget, visitorId } = await setup();
    meter.markUnknown();
    await session.stop("user-stop");
    expect((await budget.summary(visitorId)).usd).toBe(1);
    expect(meter.summary.estimatedUsd).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["stt", "responses", "tts"])("aborts an in-flight %s request on stop, retains reservation, and never emits successful output", async stage => {
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (url, init) => {
      const current = String(url).includes(".stt.") ? "stt" : String(url).endsWith("/responses") ? "responses" : "tts";
      if (current !== stage) return current === "stt" ? recognition() : completion();
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const { session, meter, budget, visitorId, events } = await setup();
    utterance(session); await flush();
    await session.stop("user-stop");
    expect(signal?.aborted).toBe(true);
    expect(meter.summary.estimatedUsd).toBeNull();
    expect((await budget.summary(visitorId)).usd).toBe(1);
    expect(voiceEvents(events, "response.audio.done")).toHaveLength(0);
    expect(voiceEvents(events, "response.done").some(event => (event.response as { status: string }).status === "completed")).toBe(false);
  });
  it("new detected speech aborts paid work without starting a concurrent paid turn", async () => {
    let signal: AbortSignal | null | undefined;
    fetchMock.mockImplementation(async (_url, init) => {
      signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const { session, meter } = await setup();
    utterance(session); await flush();
    session.signal({ type: "input_audio_buffer.append", audio: pcm(100).toString("base64") });
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meter.summary.estimatedUsd).toBeNull();
  });
  it("times out bounded paid requests and never retries", async () => {
    fetchMock.mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("timeout")), { once: true })));
    const { session, events } = await setup();
    utterance(session); await flush();
    await vi.advanceTimersByTimeAsync(30000); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ type: "voice.ended", reason: "unknown-usage" });
  });
  it.each([
    ["missing usage", () => completion([message()], { usage: null })],
    ["inconsistent usage", () => completion([message()], { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 99 } })],
    ["oversized body", () => new Response("{}", { headers: { "content-length": "9999999" } })],
    ["HTTP failure", () => new Response("", { status: 429 })],
    ["failed response", () => completion([message()], { status: "failed" })],
    ["wrong model", () => completion([message()], { model: "another-model" })]
  ])("retains all reserved funds for %s", async (_name, failure) => {
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : failure());
    const { session, meter, budget, visitorId, events } = await setup();
    utterance(session); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(meter.summary.estimatedUsd).toBeNull();
    expect((await budget.summary(visitorId)).usd).toBe(1);
    expect(voiceEvents(events, "response.audio.delta")).toHaveLength(0);
  });
  it("does not claim completion or execute tools for incomplete model responses with known usage", async () => {
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : completion([fn("vehicle_set", { temperature: 25 })], { status: "incomplete" }));
    const { session, executor, meter, budget, visitorId } = await setup();
    utterance(session); await flush();
    expect(executor.state.vehicle.temperature).toBe(22);
    expect(meter.summary.estimatedUsd).not.toBeNull();
    expect((await budget.summary(visitorId)).usd).toBeCloseTo(session.estimatedCost);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("recognition NoMatch charges only verified submitted duration, not model or TTS", async () => {
    fetchMock.mockResolvedValue(json({ RecognitionStatus: "NoMatch", Offset: 0, Duration: 0 }));
    const { session, events } = await setup();
    utterance(session); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(voiceEvents(events, "conversation.item.input_audio_transcription.failed")).toHaveLength(1);
    expect(session.estimatedCost).toBeCloseTo(0.6 / 3600);
  });
  it("rejects invalid PCM TTS receipt without success or a known settlement", async () => {
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion() : new Response(new Uint8Array(3), { headers: { "Content-Type": "audio/basic" } }));
    const { session, meter, events } = await setup();
    utterance(session); await flush();
    expect(meter.summary.estimatedUsd).toBeNull();
    expect(voiceEvents(events, "response.audio.delta")).toHaveLength(0);
  });
  it("keeps the request deadline active while reading a stalled TTS body", async () => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes(".stt.")) return recognition();
      if (String(url).endsWith("/responses")) return completion();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(100));
          init!.signal!.addEventListener("abort", () => controller.error(new Error("body aborted")), { once: true });
        }
      }), { headers: { "Content-Type": "audio/basic" } });
    });
    const { session, meter, events } = await setup();
    utterance(session); await flush();
    await vi.advanceTimersByTimeAsync(30000); await flush();
    expect(meter.summary.estimatedUsd).toBeNull();
    expect(voiceEvents(events, "response.audio.delta")).toHaveLength(0);
    expect(events).toContainEqual({ type: "voice.ended", reason: "unknown-usage" });
  });
  it("rejects oversized streamed JSON without trusting content-length", async () => {
    const cancel = vi.fn();
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(128001)); },
      cancel
    })));
    const { session, meter } = await setup();
    utterance(session); await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(meter.summary.estimatedUsd).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("rejects unsafe reservations before reserve and guards remaining prospective turn cost", async () => {
    const config = makeConfig();
    config.cascade!.rates = { ...rates, reservationUsd: 0.01 };
    const unsafe = await setup({ config, start: false });
    const reserve = vi.spyOn(unsafe.budget, "reserve");
    await expect(unsafe.session.start("gpt-6.1-sol", "en-US", "websocket")).rejects.toThrow("worst-case");
    expect(reserve).not.toHaveBeenCalled();
    const { session, meter, events } = await setup();
    meter.recordCharge("other-known-consumption", { cost: 0.95, rateVersion: rates.version });
    utterance(session); await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toContainEqual({ type: "voice.ended", reason: "quota-exceeded" });
  });
  it("does not continue after metering throws or refund uncertain settlement", async () => {
    const { session, meter, budget, visitorId } = await setup();
    vi.spyOn(meter, "recordCharge").mockImplementation(() => { throw new Error("meter unavailable"); });
    utterance(session); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(meter.summary.estimatedUsd).toBeNull();
    expect((await budget.summary(visitorId)).usd).toBe(1);
  });
  it("accounts Han speech with a character upper bound that covers Azure double billing", async () => {
    const text = "\u4f60\u597d".repeat(100);
    fetchMock.mockImplementation(async url => String(url).includes(".stt.") ? recognition() : String(url).endsWith("/responses") ? completion([message(text)]) : audio());
    const { session, events } = await setup({ locale: "zh-CN" });
    utterance(session); await flush();
    const usage = voiceEvents(events, "cascade.usage").find(event => event.stage === "tts")!;
    expect(usage.chargedCharacters).toBeGreaterThanOrEqual(text.length * 2);
    expect(usage.basis).toBe("ssml-utf8-byte-upper-bound");
  });
  it("distinguishes canceled browser delivery from successful output without discarding verified charges", async () => {
    const { session, events, meter, budget, visitorId } = await setup({
      emit: event => {
        if (event.type === "voice.event" && event.event.type === "response.audio.delta") session.signal({ type: "response.cancel" });
      }
    });
    utterance(session); await flush();
    expect(voiceEvents(events, "response.audio.delta")).toHaveLength(1);
    expect(voiceEvents(events, "response.audio.done")).toHaveLength(0);
    expect(voiceEvents(events, "response.done")[0]).toMatchObject({ response: { status: "cancelled", usage_status: "estimated" } });
    expect(meter.summary.turns).toBe(0);
    expect(meter.summary.estimatedUsd).not.toBeNull();
    await session.stop("done");
    expect((await budget.summary(visitorId)).usd).toBeCloseTo(session.estimatedCost);
  });
  it("marks settlement failures uncertain instead of presenting a successful refund", async () => {
    const { session, budget, meter, events } = await setup({ start: false });
    const realReserve = budget.reserve.bind(budget);
    vi.spyOn(budget, "reserve").mockImplementation(async (...args) => {
      const reservation = await realReserve(...args);
      return { ...reservation, settle: async () => { throw new Error("durable store unavailable"); } };
    });
    await session.start("gpt-6.1-sol", "en-US", "websocket");
    await session.stop("done");
    expect(meter.summary.estimatedUsd).toBeNull();
    expect(events).toContainEqual({ type: "voice.ended", reason: "budget-settlement-uncertain" });
  });
  it.each(["idle", "session", "utc"])("enforces %s lifetime limits without unnecessary paid requests", async mode => {
    const { session, events } = await setup();
    if (mode === "utc") vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    if (mode === "session") vi.setSystemTime(new Date("2026-10-01T12:10:00Z"));
    await vi.advanceTimersByTimeAsync(mode === "idle" ? 60000 : 1000);
    await flush();
    expect(events).toContainEqual({ type: "voice.ended", reason: mode === "idle" ? "idle-timeout" : "session-limit" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(() => session.signal({ type: "input_audio_buffer.append", audio: pcm(20).toString("base64") })).toThrow();
  });
  it("caps actual utterances at 30 seconds and rejects abusive PCM transmission rates", async () => {
    const { session } = await setup();
    for (let i = 0; i < 30; i++) {
      session.signal({ type: "input_audio_buffer.append", audio: pcm(500).toString("base64") });
      session.signal({ type: "input_audio_buffer.append", audio: pcm(500).toString("base64") });
      await vi.advanceTimersByTimeAsync(1000);
    }
    await flush();
    const sttCall = requests().find(request => request.url.includes(".stt."))!;
    expect(sttCall.init?.body).toBeInstanceOf(Uint8Array);
    expect((sttCall.init!.body as Uint8Array).byteLength).toBe(30 * 32000 + 44);
    const abusive = await setup();
    for (let i = 0; i < 4; i++) abusive.session.signal({ type: "input_audio_buffer.append", audio: pcm(500, 0).toString("base64") });
    expect(() => abusive.session.signal({ type: "input_audio_buffer.append", audio: pcm(20).toString("base64") })).toThrow("rate");
  });
});
