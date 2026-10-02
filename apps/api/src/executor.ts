import { randomUUID } from "node:crypto";
import type { ActionRequest, ActionResult, DemoState, Meeting } from "@car/contracts";
import { actionSchema } from "@car/contracts";
import { performance } from "node:perf_hooks";
import { Adapters, parseVideoUrl } from "./adapters.js";
import { ApiError, canonical } from "./security.js";
import { toolSchemas } from "./schemas.js";

export const contacts = Object.freeze([
  { name: "Alex Chen", email: "alex@example.test", phone: "+1-202-555-0101" },
  { name: "Mei Tanaka", email: "mei@example.test", phone: "+1-202-555-0102" },
  { name: "Sam Rivera", email: "sam@example.test", phone: "+1-202-555-0103" }
]);
export function seedState(): DemoState {
  return {
    revision: 0, vehicle: { temperature: 22, fan: true, windowOpen: false, seatHeat: false, locked: true, driving: false },
    phone: { connected: false, activeContact: null },
    meetings: [
      { id: "meeting-1", title: "Fictional mobility project review", startsAt: "2026-10-01T09:00:00Z", durationMinutes: 30, attendees: ["alex@example.test", "mei@example.test"], location: "Demo conference room", notes: "Review the simulated cockpit. Alex owns the UX prototype; Mei verifies the test plan." },
      { id: "meeting-2", title: "Fictional partner check-in", startsAt: "2026-10-01T13:00:00Z", durationMinutes: 45, attendees: ["sam@example.test"], location: "Demo office", notes: "Discuss accessibility and multilingual testing; no customer data." }
    ],
    mail: [{ id: "mail-1", from: "alex@example.test", to: "driver@example.test", subject: "Fictional cockpit review", body: "Please review the simulated voice controls before our mock meeting.", sent: false }]
  };
}
interface Entry { fingerprint: string; result?: ActionResult; pending?: { id: string; expires: number }; signal?: AbortSignal; }
export class Executor {
  state = seedState();
  private calls = new Map<string, Entry>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private visitorId: string, private adapters: Adapters, private clock = Date.now) {}
  execute(input: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    const result = this.queue.then(() => this.run(input, signal));
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async run(input: ActionRequest, signal?: AbortSignal): Promise<ActionResult> {
    const started = performance.now();
    const request = actionSchema.parse(input);
    const args = toolSchemas[request.name].parse(request.args) as Record<string, any>;
    const fingerprint = canonical({ name: request.name, args });
    let entry = this.calls.get(request.callId);
    if (entry && entry.fingerprint !== fingerprint) throw new ApiError("call-conflict", "callId is bound to its original arguments", 409);
    if (entry?.result) return structuredClone(entry.result);
    const cancellation = entry?.signal ?? signal;
    if (cancellation?.aborted && request.confirm !== false) throw new ApiError("action-cancelled", "The originating voice turn was cancelled; no new action performed", 409);
    if (!entry) {
      if (this.calls.size >= 1000) throw new ApiError("demo-limit", "Demo action limit reached; register a new demo", 429);
      entry = { fingerprint, signal }; this.calls.set(request.callId, entry);
    }
    const provider: ActionResult["provider"] = request.name.startsWith("navigation.") ? "azure-maps" : request.name === "video.search" ? "web-iq" : request.name === "media.control" ? "client" : "mock";
    const result = (status: ActionResult["status"], message: string, data?: unknown): ActionResult => ({ callId: request.callId, status, provider, message, state: structuredClone(this.state), ...(data === undefined ? {} : { data }), durationMs: performance.now() - started });
    const sensitive = ["phone.call", "work.createMeeting", "work.updateMeeting", "work.sendMail", "work.reset", "navigation.route"].includes(request.name) || (request.name === "vehicle.set" && "locked" in args);
    if (sensitive) {
      if (request.confirmationId || request.confirm !== undefined) {
        if (!entry.pending || request.confirmationId !== entry.pending.id || entry.pending.expires <= this.clock()) throw new ApiError("invalid-confirmation", "Confirmation missing, expired, or bound to a different call", 409);
        if (request.confirm === false) { entry.result = result("cancelled", "Action cancelled; no changes made"); return structuredClone(entry.result); }
        if (request.confirm !== true) throw new ApiError("invalid-confirmation", "Explicit confirmation required", 409);
      } else {
        if (!entry.pending || entry.pending.expires <= this.clock()) entry.pending = { id: randomUUID(), expires: this.clock() + 60000 };
        return { ...result("confirmation-required", provider === "mock" ? "Confirm this simulated change" : "Confirm route request", { action: { callId: request.callId, name: request.name, args }, preview: { name: request.name, args }, expiresAt: new Date(entry.pending.expires).toISOString() }), confirmationId: entry.pending.id };
      }
    } else if (request.confirmationId || request.confirm !== undefined) throw new ApiError("unexpected-confirmation", "This action does not need confirmation", 400);
    let data: unknown;
    try {
      let changed = true;
      switch (request.name) {
        case "vehicle.set": Object.assign(this.state.vehicle, args); break;
        case "phone.connect":
          this.state.phone.connected = args.connected;
          if (!args.connected) this.state.phone.activeContact = null;
          break;
        case "phone.call":
          if (!this.state.phone.connected) throw new ApiError("phone-disconnected", "Connect simulated Bluetooth first", 409);
          if (this.state.phone.activeContact) throw new ApiError("call-active", "End the current simulated call first", 409);
          this.state.phone.activeContact = args.contact; break;
        case "phone.hangup": this.state.phone.activeContact = null; break;
        case "work.query": changed = false; data = args.kind === "contacts" ? { contacts } : args.kind === "mail" ? { mail: structuredClone(this.state.mail) } : { meetings: structuredClone(this.state.meetings) }; break;
        case "work.createMeeting": {
          const meeting = { id: `meeting-${request.callId}`, ...args } as Meeting;
          this.checkMeeting(meeting); this.state.meetings.push(meeting); data = { meeting }; break;
        }
        case "work.updateMeeting": {
          const index = this.state.meetings.findIndex(meeting => meeting.id === args.id);
          if (index < 0) throw new ApiError("not-found", "Fictional meeting not found", 404);
          const meeting = { ...this.state.meetings[index]!, ...args } as Meeting;
          this.checkMeeting(meeting); this.state.meetings[index] = meeting; data = { meeting }; break;
        }
        case "work.sendMail": {
          const mail = { id: `mail-${request.callId}`, from: "driver@example.test", to: args.to, subject: args.subject, body: args.body, sent: true };
          this.state.mail.push(mail); data = { mail, delivery: "mock-sent-folder-only" }; break;
        }
        case "work.summarize": {
          changed = false;
          const meeting = this.state.meetings.find(item => item.id === args.id);
          if (!meeting) throw new ApiError("not-found", "Fictional meeting not found", 404);
          data = { id: meeting.id, title: meeting.title, startsAt: meeting.startsAt, participants: meeting.attendees, summary: meeting.notes || "No fictional meeting notes.", source: "deterministic mock meeting notes", actions: [] }; break;
        }
        case "work.reset": { const seed = seedState(); this.state.meetings = seed.meetings; this.state.mail = seed.mail; break; }
        case "navigation.search": changed = false; data = await this.adapters.search(this.visitorId, toolSchemas["navigation.search"].parse(request.args), cancellation); break;
        case "navigation.route": changed = false; data = await this.adapters.route(this.visitorId, toolSchemas["navigation.route"].parse(request.args), cancellation); break;
        case "video.search": changed = false; data = await this.adapters.videos(this.visitorId, toolSchemas["video.search"].parse(request.args), cancellation); break;
        case "media.control": {
          changed = false;
          if (args.platform === "spotify") throw new ApiError("spotify-policy", "Spotify policy restricts voice control and multi-service streaming. No documented exception covers this demo; use an explicit user-clicked external Spotify link. No playback or volume command was sent.", 503);
          if (this.state.vehicle.driving && !["stop", "pause"].includes(args.command)) throw new ApiError("driving-lock", "Video disabled during simulated driving", 409);
          if (args.platform === "bilibili" && !["open", "stop"].includes(args.command)) throw new ApiError("unavailable", "Bilibili playback controls are not verified; use the official player", 503);
          const video = args.url ? parseVideoUrl(args.url) : null;
          if (args.url && (!video || video.platform !== args.platform)) throw new ApiError("invalid-video", "Video URL must match the requested platform", 400);
          if (args.command === "open" && (!video || video.platform !== args.platform)) throw new ApiError("invalid-video", "A valid allowlisted video URL is required", 400);
          if (args.command === "volume" && args.volume === undefined) throw new ApiError("invalid-volume", "Volume is required", 400);
          data = { request: { platform: args.platform, command: args.command, ...(video ? { url: video.url, videoId: video.videoId } : {}), ...(args.volume === undefined ? {} : { volume: args.volume }) }, execution: "requested", playbackConfirmed: false }; break;
        }
      }
      if (changed) this.state.revision++;
      entry.result = result("completed", provider === "mock" ? "Simulated operation completed; no real hardware, calls or email" : provider === "client" ? "Frontend media action requested; playback is not confirmed" : "Provider data retrieved", data);
    } catch (error) {
      // Cache provider failures too: retries must not duplicate paid calls or uncertain writes.
      if (error instanceof ApiError) entry.result = result("unavailable", error.message, { code: error.code });
      else entry.result = result("unavailable", "Operation failed safely", { code: "operation-failed" });
    }
    return structuredClone(entry.result);
  }
  private checkMeeting(meeting: Meeting): void {
    const start = Date.parse(meeting.startsAt), end = start + meeting.durationMinutes * 60000;
    if (!Number.isFinite(start) || start < Date.UTC(2020, 0, 1) || start > Date.UTC(2100, 0, 1)) throw new ApiError("invalid-date", "Meeting date must be between 2020 and 2100");
    if (new Set(meeting.attendees).size !== meeting.attendees.length) throw new ApiError("duplicate-attendees", "Duplicate fictional attendees");
    if (this.state.meetings.some(other => other.id !== meeting.id && Date.parse(other.startsAt) < end && Date.parse(other.startsAt) + other.durationMinutes * 60000 > start)) throw new ApiError("meeting-conflict", "Fictional meeting overlaps an existing meeting", 409);
  }
}
