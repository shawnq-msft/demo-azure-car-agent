import { randomUUID } from "node:crypto";
import type { ActionResult, DiagnosticObservation, DiagnosticSession, DiagnosticSnapshot, Locale, ModelId, ServerEvent } from "@car/contracts";

function rank(values: number[], percentile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percentile) - 1]!;
}
export class Diagnostics {
  private observations: DiagnosticObservation[] = [];
  private sessions: DiagnosticSession[] = [];
  private traceId = randomUUID();
  private epoch: number;
  private sequence = 0;
  private toolsSeen = new Set<string>();
  private firstText = false;
  private firstAudio = false;
  constructor(private clock: () => number = () => performance.now()) { this.epoch = clock(); }
  start(model: ModelId, locale: Locale, transport: "webrtc" | "websocket"): void {
    this.traceId = randomUUID(); this.epoch = this.clock(); this.firstText = false; this.firstAudio = false;
    this.sessions.push({ traceId: this.traceId, model, locale, transport, startedAt: new Date().toISOString() });
    this.sessions = this.sessions.slice(-20);
    this.record("connection", "gateway");
  }
  private record(phase: DiagnosticObservation["phase"], source: DiagnosticObservation["source"], detail: Partial<Pick<DiagnosticObservation, "durationMs" | "success" | "tool" | "provider">> = {}): void {
    this.observations.push({ sequence: ++this.sequence, traceId: this.traceId, offsetMs: Math.max(0, this.clock() - this.epoch), phase, source, ...detail });
    this.observations = this.observations.slice(-200);
  }
  playback(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 120000) throw new RangeError("Invalid playback latency");
    this.record("client-playback-latency", "browser", { durationMs: latencyMs });
  }
  tool(result: ActionResult, name?: string): void {
    if (result.status === "confirmation-required" || this.toolsSeen.has(result.callId)) return;
    if (result.provider === "client" && result.data && typeof result.data === "object" && "execution" in result.data && result.data.execution === "requested") return;
    this.toolsSeen.add(result.callId);
    if (this.toolsSeen.size > 1000) this.toolsSeen.delete(this.toolsSeen.values().next().value!);
    this.record("tool", "gateway", {
      durationMs: Math.max(0, result.durationMs), success: result.status === "completed",
      provider: result.provider, ...(name && /^[A-Za-z]+\.[A-Za-z]+$/.test(name) ? { tool: name } : {})
    });
  }
  event(event: ServerEvent): void {
    if (event.type === "action.result") this.tool(event.result);
    if (event.type === "voice.ended") this.record("session-end", "gateway", { success: ["user-stop", "idle-timeout", "session-limit"].includes(event.reason) });
    if (event.type !== "voice.event") return;
    switch (event.event.type) {
      case "input_audio_buffer.speech_stopped": this.record("vad-end", "gateway"); break;
      case "response.created": this.firstText = false; this.firstAudio = false; break;
      case "response.text.delta":
      case "response.audio_transcript.delta":
      case "response.output_audio_transcript.delta":
      case "session.output_transcript.delta":
        if (!this.firstText) { this.firstText = true; this.record("first-text", "gateway"); }
        break;
      case "response.audio.delta":
      case "response.output_audio.delta":
      case "session.output_audio.delta":
        if (!this.firstAudio) { this.firstAudio = true; this.record("audio-arrival", "gateway"); }
        break;
      case "response.done": this.record("response-complete", "gateway"); break;
    }
  }
  snapshot(): DiagnosticSnapshot {
    const latencies = this.observations.filter(item => item.phase === "client-playback-latency").map(item => item.durationMs!);
    const tools = this.observations.filter(item => item.phase === "tool");
    const durations = tools.map(item => item.durationMs!);
    return structuredClone({
      sessions: this.sessions, observations: this.observations,
      latency: { count: latencies.length, p50Ms: rank(latencies, 0.5), p95Ms: rank(latencies, 0.95) },
      tools: { count: tools.length, failed: tools.filter(item => !item.success).length, p50Ms: rank(durations, 0.5), p95Ms: rank(durations, 0.95) },
      retention: "current-demo-memory", clockPolicy: "separate-browser-and-gateway-monotonic-clocks", cloudStages: "not-exposed"
    });
  }
}
