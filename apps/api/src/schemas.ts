import { z } from "zod";
import type { ActionName } from "@car/contracts";

const coordinate = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }).strict();
const shortCoordinate = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).strict();
const meetingFields = {
  title: z.string().trim().min(1).max(160),
  startsAt: z.string().datetime({ offset: true }),
  durationMinutes: z.number().int().min(5).max(480),
  attendees: z.array(z.enum(["alex@example.test", "mei@example.test", "sam@example.test"])).min(1).max(3),
  location: z.string().trim().min(1).max(200),
  notes: z.string().max(2000).default("")
};
export const toolSchemas: Record<ActionName, z.ZodTypeAny> = {
  "vehicle.set": z.object({
    temperature: z.number().min(16).max(30).optional(), fan: z.boolean().optional(),
    windowOpen: z.boolean().optional(), seatHeat: z.boolean().optional(), locked: z.boolean().optional(),
    driving: z.boolean().optional()
  }).strict().refine(value => Object.keys(value).length > 0, "At least one vehicle property required"),
  "phone.connect": z.object({ connected: z.boolean() }).strict(),
  "phone.call": z.object({ contact: z.enum(["Alex Chen", "Mei Tanaka", "Sam Rivera"]) }).strict(),
  "phone.hangup": z.object({}).strict(),
  "work.query": z.object({ kind: z.enum(["meetings", "mail", "contacts"]).default("meetings") }).strict(),
  "work.createMeeting": z.object(meetingFields).strict(),
  "work.updateMeeting": z.object({ id: z.string().min(1).max(100), ...Object.fromEntries(Object.entries(meetingFields).map(([key, value]) => [key, value.optional()])) }).strict().refine(value => Object.keys(value).length > 1, "Meeting changes required"),
  "work.sendMail": z.object({ to: z.enum(["alex@example.test", "mei@example.test", "sam@example.test"]), subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) }).strict(),
  "work.summarize": z.object({ id: z.string().min(1).max(100) }).strict(),
  "work.reset": z.object({}).strict(),
  "navigation.search": z.object({ query: z.string().trim().min(2).max(200), near: coordinate.optional() }).strict(),
  "navigation.route": z.union([
    z.object({ origin: coordinate, destination: coordinate }).strict(),
    z.object({ start: shortCoordinate, end: shortCoordinate }).strict().transform(({ start, end }) => ({
      origin: { latitude: start.lat, longitude: start.lon }, destination: { latitude: end.lat, longitude: end.lon }
    }))
  ]),
  "video.search": z.object({ query: z.string().trim().min(2).max(200), platform: z.enum(["all", "youtube", "bilibili"]) }).strict(),
  "media.control": z.object({ platform: z.enum(["youtube", "bilibili", "spotify"]), command: z.enum(["open", "play", "pause", "stop", "volume"]), url: z.string().url().max(2048).optional(), volume: z.number().min(0).max(100).optional() }).strict()
};
// OpenAI-style JSON schemas are explicitly controlled by the server, not accepted from the browser.
export const voiceTools = [
  { name: "vehicle_set", description: "Simulate vehicle controls; never real hardware.", parameters: { type: "object", properties: { temperature: { type: "number", minimum: 16, maximum: 30 }, fan: { type: "boolean" }, windowOpen: { type: "boolean" }, seatHeat: { type: "boolean" }, locked: { type: "boolean" }, driving: { type: "boolean" } }, additionalProperties: false } },
  { name: "phone_connect", description: "Simulate Bluetooth connection.", parameters: { type: "object", properties: { connected: { type: "boolean" } }, required: ["connected"], additionalProperties: false } },
  { name: "phone_call", description: "Simulated call to fictional contact; requires UI confirmation.", parameters: { type: "object", properties: { contact: { type: "string", enum: ["Alex Chen", "Mei Tanaka", "Sam Rivera"] } }, required: ["contact"], additionalProperties: false } },
  { name: "phone_hangup", description: "End simulated call.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "work_query", description: "Query fictional Work IQ mock data.", parameters: { type: "object", properties: { kind: { type: "string", enum: ["meetings", "mail", "contacts"] } }, required: ["kind"], additionalProperties: false } },
  { name: "work_createMeeting", description: "Create fictional meeting after user confirmation; offset-aware ISO dates.", parameters: { type: "object", properties: { title: { type: "string" }, startsAt: { type: "string", format: "date-time" }, durationMinutes: { type: "integer", minimum: 5, maximum: 480 }, attendees: { type: "array", items: { type: "string", enum: ["alex@example.test", "mei@example.test", "sam@example.test"] } }, location: { type: "string" }, notes: { type: "string" } }, required: ["title", "startsAt", "durationMinutes", "attendees", "location"], additionalProperties: false } },
  { name: "work_updateMeeting", description: "Modify fictional meeting after confirmation.", parameters: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, startsAt: { type: "string", format: "date-time" }, durationMinutes: { type: "integer", minimum: 5, maximum: 480 }, attendees: { type: "array", items: { type: "string", enum: ["alex@example.test", "mei@example.test", "sam@example.test"] } }, location: { type: "string" }, notes: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "work_sendMail", description: "Add fictional mail to mock sent folder after confirmation; never sends email.", parameters: { type: "object", properties: { to: { type: "string", enum: ["alex@example.test", "mei@example.test", "sam@example.test"] }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "subject", "body"], additionalProperties: false } },
  { name: "work_summarize", description: "Deterministic summary of fictional meeting.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
  { name: "work_reset", description: "Reset fictional Work IQ state after confirmation.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "navigation_search", description: "Search actual Azure Maps POIs.", parameters: { type: "object", properties: { query: { type: "string" }, near: { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" } }, required: ["latitude", "longitude"], additionalProperties: false } }, required: ["query"], additionalProperties: false } },
  { name: "navigation_route", description: "Get actual Azure Maps route after confirmation. Never imply real turn-by-turn navigation.", parameters: { type: "object", properties: Object.fromEntries(["origin", "destination"].map(key => [key, { type: "object", properties: { latitude: { type: "number" }, longitude: { type: "number" } }, required: ["latitude", "longitude"], additionalProperties: false }])), required: ["origin", "destination"], additionalProperties: false } },
  { name: "video_search", description: "Web IQ search is unavailable until its official protocol is documented and implemented; never invent search results or use a substitute service.", parameters: { type: "object", properties: { query: { type: "string" }, platform: { type: "string", enum: ["all", "youtube", "bilibili"] } }, required: ["query", "platform"], additionalProperties: false } },
  { name: "media_control", description: "Request frontend media control; result is only a request, never evidence of successful playback. Spotify controls unavailable.", parameters: { type: "object", properties: { platform: { type: "string", enum: ["youtube", "bilibili", "spotify"] }, command: { type: "string", enum: ["open", "play", "pause", "stop", "volume"] }, url: { type: "string" }, volume: { type: "number", minimum: 0, maximum: 100 } }, required: ["platform", "command"], additionalProperties: false } }
].map(tool => ({ type: "function" as const, ...tool }));
