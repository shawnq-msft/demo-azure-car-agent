import { z } from "zod";
export type { DiagnosticObservation, DiagnosticPhase, DiagnosticSession, DiagnosticSnapshot } from "./diagnostics";

export const locales = ["en-US", "zh-CN", "ja-JP", "ko-KR", "de-DE"] as const;
export type Locale = (typeof locales)[number];
export const modelIds = ["gpt-realtime-2.1", "gpt-live-1", "gpt-6.1-sol"] as const;
export type ModelId = (typeof modelIds)[number];
export type CapabilityStatus = "ready" | "mock" | "unconfigured" | "pending-verification" | "unavailable";
export interface Capability {
  status: CapabilityStatus;
  reason: string;
}
export interface ModelCapability extends Capability {
  id: ModelId;
  mode: "realtime" | "cascade";
  actualModel?: string;
}
export interface Capabilities {
  persistence: "memory" | "cosmos";
  voiceTransports?: { webrtc: Capability; websocket: Capability };
  models: ModelCapability[];
  maps: Capability;
  spotify: Capability;
  webIq: Capability;
  workIq: Capability;
  limits: { sessionSeconds: number; idleSeconds: number; dailySeconds: number; visitorUsd: number; globalUsd: number };
}
export const registrationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  company: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(254),
  scenario: z.string().trim().min(3).max(1000),
  phone: z.string().trim().max(40).optional(),
  timeline: z.string().trim().max(120).optional(),
  privacyConsent: z.literal(true),
  marketingConsent: z.boolean(),
  locale: z.enum(locales),
  website: z.string().max(0).optional()
}).strict();
export type Registration = z.infer<typeof registrationSchema>;
export interface RegistrationResult {
  token: string;
  expiresAt: string;
  visitorId: string;
  demo: DemoState;
}
export interface Meeting {
  id: string;
  title: string;
  startsAt: string;
  durationMinutes: number;
  attendees: string[];
  location: string;
  notes: string;
}
export interface Mail {
  id: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  sent: boolean;
}
export interface DemoState {
  revision: number;
  vehicle: { temperature: number; fan: boolean; windowOpen: boolean; seatHeat: boolean; locked: boolean; driving: boolean };
  phone: { connected: boolean; activeContact: string | null };
  meetings: Meeting[];
  mail: Mail[];
}
export const actionNames = [
  "vehicle.set", "phone.connect", "phone.call", "phone.hangup",
  "work.query", "work.createMeeting", "work.updateMeeting", "work.sendMail", "work.summarize", "work.reset",
  "navigation.search", "navigation.route", "video.search", "media.control"
] as const;
export type ActionName = (typeof actionNames)[number];
export const actionSchema = z.object({
  callId: z.string().uuid(),
  name: z.enum(actionNames),
  args: z.record(z.unknown()),
  confirmationId: z.string().uuid().optional(),
  confirm: z.boolean().optional()
}).strict();
export type ActionRequest = z.infer<typeof actionSchema>;
export interface Citation { title: string; url: string }
export interface VideoResult extends Citation {
  platform: "youtube" | "bilibili";
  videoId: string;
}
export const mediaCommandSchema = z.enum(["open", "play", "pause", "stop", "volume"]);
export const mediaResultSchema = z.object({
  type: z.literal("media.result"),
  callId: z.string().uuid(),
  platform: z.enum(["youtube", "bilibili"]),
  command: mediaCommandSchema,
  outcome: z.enum(["opened", "playing", "paused", "stopped", "volume-changed", "blocked", "unavailable"]),
  detail: z.enum(["player-ready", "player-state", "player-volume", "unmounted", "gesture-required", "timeout", "player-error", "no-selection", "platform-mismatch", "unsupported", "driving", "hidden", "audio-focus", "superseded"])
}).strict();
export type MediaResultEvent = z.infer<typeof mediaResultSchema>;
export interface MediaRequest {
  callId: string;
  platform: MediaResultEvent["platform"];
  command: MediaResultEvent["command"];
  url?: string;
  videoId?: string;
  volume?: number;
}
export interface ActionResult {
  callId: string;
  status: "completed" | "confirmation-required" | "cancelled" | "unavailable";
  provider: "mock" | "azure-maps" | "web-iq" | "client";
  message: string;
  confirmationId?: string;
  state?: DemoState;
  data?: unknown;
  durationMs: number;
}
export interface UsageSummary {
  seconds: number;
  estimatedUsd: number | null;
  currency: "USD";
  inputTokens: number;
  outputTokens: number;
  turns: number;
  latencySamples: number[];
  rateVersion: string | null;
  externalCostsIncluded: boolean;
  costBasis?: "configured-rates" | "uncached-upper-bound";
  cachedInputTokens?: number;
  latencyBasis?: "browser-vad-receipt-to-audio-output";
  tokenTurnCoverage?: "partial";
}
export type ServerEvent =
  | { type: "authenticated"; demo: DemoState }
  | { type: "voice.started"; sessionId: string; transport: "webrtc" | "websocket"; model: string }
  | { type: "voice.event"; event: Record<string, unknown> }
  | { type: "voice.ended"; reason: string }
  | { type: "action.result"; result: ActionResult }
  | { type: "usage"; usage: UsageSummary }
  | { type: "error"; code: string; message: string };
export const clientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth"), token: z.string().min(1).max(4096) }).strict(),
  z.object({ type: z.literal("voice.start"), model: z.enum(modelIds), locale: z.enum(locales), transport: z.enum(["webrtc", "websocket"]) }).strict(),
  z.object({ type: z.literal("voice.signal"), event: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal("voice.stop") }).strict(),
  z.object({ type: z.literal("action"), action: actionSchema }).strict(),
  mediaResultSchema,
  z.object({ type: z.literal("metrics"), latencyMs: z.number().min(0).max(120000), basis: z.literal("browser-vad-receipt-to-audio-output").optional() }).strict()
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;
