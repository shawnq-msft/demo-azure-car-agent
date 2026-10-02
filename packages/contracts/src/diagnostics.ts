import type { Locale, ModelId } from "./index";

export type DiagnosticPhase = "connection" | "vad-end" | "first-text" | "audio-arrival" | "response-complete" | "tool" | "client-playback-latency" | "session-end";
export interface DiagnosticObservation {
  sequence: number;
  traceId: string;
  offsetMs: number;
  phase: DiagnosticPhase;
  source: "gateway" | "browser";
  durationMs?: number;
  success?: boolean;
  tool?: string;
  provider?: string;
}
export interface DiagnosticSession {
  traceId: string;
  model: ModelId;
  locale: Locale;
  transport: "webrtc" | "websocket";
  startedAt: string;
}
export interface DiagnosticSnapshot {
  sessions: DiagnosticSession[];
  observations: DiagnosticObservation[];
  latency: { count: number; p50Ms: number | null; p95Ms: number | null };
  tools: { count: number; failed: number; p50Ms: number | null; p95Ms: number | null };
  retention: "current-demo-memory";
  clockPolicy: "separate-browser-and-gateway-monotonic-clocks";
  cloudStages: "not-exposed";
}
