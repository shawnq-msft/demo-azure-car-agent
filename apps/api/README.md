# API operational notes

Run from the workspace root with `npm run dev:api`; build with `npm run build --workspace @car/api`. Node 22+ is required. Default port: 3001. `GET /api/health` is the readiness endpoint. Request logging is disabled; never add body, authorization header, transcript, upstream payload, or lead logging.

Copy `.env.example` to `.env` inside `apps/api` for local configuration. Development uses plain `tsx watch src/index.ts`; the entrypoint loads the optional file through native `process.loadEnvFile`, without forwarding env-file flags through the watcher. Existing process environment variables take precedence. `.env` is Git-ignored. Blank signing-secret placeholders generate an ephemeral random development secret; production still rejects them.

The entrypoint skips local `.env` loading in both production and test mode; development ignores only a missing file and propagates other read errors. The production build explicitly bundles the shared contracts source; actual third-party packages stay external. No TypeScript loader or contracts source is required at runtime. `AUTH_SECRET` is accepted as a development/test alias only; production still requires `TOKEN_SIGNING_SECRET`.

## Configuration and honest gates

Local development defaults to **explicit volatile memory**. Restarting resets demo state and the local budget. Never use this mode for production spending. Production startup requires:

- `NODE_ENV=production`
- `TOKEN_SIGNING_SECRET`: at least 32 random characters
- `PERSISTENCE_MODE=cosmos`, `COSMOS_ENDPOINT`
- `COSMOS_DATABASE` (default `car-demo`), `COSMOS_CONTAINER` (default `records`)
- Cosmos container partition key `/id`, TTL enabled. The recommended default is `defaultTtl: 2592000` (30 days), as provisioned by infrastructure; `-1` is also accepted for per-item-only expiration. Lead items explicitly carry 90-day TTL and daily budget items explicitly carry 30-day TTL.
- Managed identity with Cosmos data-plane access, or server-only `COSMOS_KEY`.
- `ALLOWED_ORIGINS`: comma-separated exact frontend origins.
- Deploy **one replica only**, `MAX_REPLICAS=1`; in-memory fictional demo state is gateway-owned. Cosmos ETag compare-and-swap makes the daily budget reservation durable and race-safe; it does not persist fictional meeting/mail content.

`MAX_CONCURRENT_SESSIONS` defaults to 1. `EMERGENCY_STOP=true` disables new paid capabilities after restart. Limits are immutable: 60-second idle timeout, 600-second session, 1,200 seconds/visitor/UTC day, estimated $2/visitor/day and $50/global/day. Registration is limited to five attempts/IP/hour and has a honeypot. These limits do not provide strong person-level identity; re-registration is not identity verification. Proxies are not blindly trusted, so a reverse proxy may share the registration limit across clients.

### Voice Live WebSocket

Set `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_REGION` and either server-only `VOICE_LIVE_API_KEY` or `VOICE_LIVE_USE_MANAGED_IDENTITY=true` with Cognitive Services access. Only `gpt-realtime-2.1` is implemented. WebSocket uses `2026-04-10`. Pricing must be explicitly supplied as `VOICE_RATE_CARD_JSON`:

```json
{
  "version": "<verified-version>",
  "source": "https://<official-pricing-source>",
  "effectiveAt": "2026-09-30T00:00:00Z",
  "model": "gpt-realtime-2.1",
  "region": "<deployment-region>",
  "currency": "USD",
  "inputAudio": "<positive USD per million tokens: replace with number>",
  "outputAudio": "<positive USD per million tokens: replace with number>",
  "inputText": "<positive USD per million tokens: replace with number>",
  "outputText": "<positive USD per million tokens: replace with number>",
  "reservationUsd": "<positive number <= 2>",
  "maxResponseTokens": "<integer 1..4096>",
  "verifiedUsageSchema": "response.done-token-details-v1"
}
```

This is intentionally **not a usable price sample**. No prices are invented. Verify the actual deployment's billing and event contract before configuring it. The rate card is frozen for the process lifetime. A session reservation must cover at least ten maximum output responses. Full reservation and 600 seconds are durably debited before upstream connection; normal known settlements refund unused reservation/time. Crashes or unreported/unknown usage retain the cost reservation, not a fabricated zero. Events are deduplicated by response ID. The supported response usage has `input_tokens`, `output_tokens`, `input_token_details` and `output_token_details`, each with explicit `audio_tokens` and `text_tokens`. Cached input is conservatively charged at uncached rates and reported with `costBasis:"uncached-upper-bound"` and `cachedInputTokens`; no discount is assumed. Inconsistent token counts remain an error.

Metering stops the session at 80% of its reservation, unknown usage, stalled responses, UTC rollover, or time limits. This is an estimated spending guard, **not an Azure billing hard cap**: in-flight consumption and unallocated infrastructure costs can exceed estimates. Unpriced services are disabled. Maps/Web IQ request costs are reserved conservatively even if a paid request later fails. Audio appended but not associated with a verified completed response is uncertain and is not refunded.

### Primary WebRTC transport (public preview)

The [official Voice Live WebRTC documentation](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-webrtc) specifies the server control endpoint `/voice-live/realtime/calls?api-version=2026-01-01-preview&model=...`, client event `rtc.call.sdp.create` with `sdp_offer` and `session`, and server event `rtc.call.sdp.created` with `sdp_answer`. This protocol is implemented and tested using an upstream WebSocket stub, but not live-tested without credentials.

Set `VOICE_LIVE_WEBRTC_VERIFIED=true` **only after** confirming the target resource/model supports this preview, delivers authoritative usage and function calls on its server-owned control WebSocket, and terminates RTP media when that control WebSocket is closed. The flag also attests approval of preview/global-standard routing. Credentials and verified pricing are still required. Without this deployment verification, WebRTC fails closed; explicit WebSocket relay remains separately available. Preview has no SLA and is not represented as production-verified.

Flow: authenticate `/ws`, send `voice.start` with `transport:"webrtc"`, receive `voice.started`, then send `{type:"voice.signal",event:{type:"rtc.call.sdp.create",sdp_offer:"..."}}`. The gateway injects its own instructions/tools/session and forwards only `{type:"rtc.call.sdp.created",sdp_answer:"..."}` inside `voice.event`. Browser applies that answer. Alternatively, after starting the same control session, POST `/api/voice/calls` with visitor Bearer token and `{sessionId,sdp_offer}`; the answer still arrives over `/ws`.

SDP must contain only audio media with DTLS fingerprint. **Do not create a browser WebRTC data channel**: `m=application` and video sections are rejected to prevent bypassing server-owned instructions and tools. All non-audio interaction stays on the gateway WebSocket. Client session overrides, duplicate offers and RTP/audio-buffer transport mixing are rejected. Negotiation times out after 15 seconds. The existing idle, session, quota and confirmation controls apply to the control connection. Because final RTP consumption cannot yet be reconciled at disconnect, its reservation is conservatively retained and cost marked unknown after closure rather than refunding uncertain spend.

### Native GPT-Live and Sol cascade

Both adapters are implemented with offline protocol tests but remain gated on actual deployment attestation and rates. Neither is live-Azure verified.

- `gpt-live-1`: Entra-authenticated `/openai/v1/live/sessions`, 24-kHz PCM WebSocket, native events and cumulative billed seconds. Configure `GPT_LIVE_ENDPOINT`, `GPT_LIVE_DEPLOYMENT`, `GPT_LIVE_REGION`, `GPT_LIVE_DEPLOYMENT_VERIFIED=true` and `GPT_LIVE_RATE_CARD_JSON` (version, source, effectiveAt, usdPerHour, reservationUsd). The reservation must cover the maximum session duration. Standalone client delegation cannot supply task arguments; it is declined explicitly, with UI tools still usable.
- `gpt-6.1-sol`: conventional Azure Speech STT -> Sol Responses tools -> Speech TTS, **not Voice Live BYOM**. Configure the `CASCADE_*` settings in the environment example, including verified stage prices. Calls use bounded in-memory context and `store:false`; no audio/transcript persistence. Paid tools and later confirmations inherit their originating turn's cancellation signal.

Both use explicit WebSocket PCM, support the five selected locales, and preserve accumulated visitor usage across sessions. Missing final or stage usage remains unknown, not zero. Provider token/turn counts are unavailable in standalone GPT-Live; its native usage is time-based. See [integration details](../../docs/integrations.md).

For optional native GPT-Live voice tools, set `GPT_LIVE_RESPONSES_DELEGATION_VERIFIED=true` and supply `GPT_LIVE_RESPONSES_RATE_CARD_JSON` with `deployment:"gpt-6.1-sol"`, positive `inputText`/`outputText` USD per million tokens, `maxResponseTokens` (1..4096), `rateVersion`, official HTTPS `source`, and ISO `effectiveAt`. Verify the model is available to managed Responses delegation on the GPT-Live resource. This explicitly disclosed second model handles tools; it is not a silent substitute for native speech. The shared reservation must cover full voice duration plus four maximum backend outputs with additional input headroom. Input/context costs are not a provider billing hard cap. The adapter caps backend responses at four and tools at eight, separately meters voice seconds and backend tokens, and propagates cancellation through pending tools. Counts in mixed/native sessions are shown as lower bounds or unknown because GPT-Live does not report native voice tokens or authoritative turns.

**Other deployment blockers:** Spotify remains external-link-only: OAuth, SDK playback, and voice controls are **not implemented or advertised as ready**, regardless of generic Premium/whitelist status.

### Spotify policy restriction

The [Spotify Developer Policy](https://developer.spotify.com/policy) section III.3 prohibits voice-enabled Spotify control, III.5 restricts integration with other services' streams, and III.7 prohibits overlapping Spotify audio with other audio. Premium, development allowlisting, or generic commercial approval does **not** grant an exception for this voice-assistant/multi-service scenario. A separate documented exception covering this exact use case is required before considering any full integration. No such exception is configured.

Only an explicit user click may open an external Spotify link/search. Every Spotify `media.control` request, including open, pause, stop, and volume, returns `status:"unavailable"` with `data.code:"spotify-policy"`; the voice executor never sends Spotify commands or opens its links. There is no auto-ducking or mixing implementation. Any future specifically approved in-app mode must fully pause playback before assistant speech, not overlap or duck it. The application cannot guarantee control of audio in an external Spotify tab; the user must pause it manually. Full Spotify integration is an external blocker, not a completed feature.

### Maps and Web IQ

Azure Maps uses actual `atlas.microsoft.com/search/poi/json` and `/route/directions/json`, API version 1.0. Enable with server-only `AZURE_MAPS_KEY` and verified positive `AZURE_MAPS_REQUEST_USD`. Destination confirmation is required for route requests. Path progression is a **simulation**, not a navigation engine.

**Web IQ video search is implemented and configuration-gated.** Official samples document the MCP endpoint `https://api.microsoft.ai/v3/mcp` and `x-apikey` authentication. The Responses-mediated adapter invokes only operator-reviewed read-only tools and accepts normalized video URLs only when supported by successful MCP output. Tool names, access and applicable prices still require live review. See [Web IQ setup](../../docs/web-iq.md). An enabled Web IQ credential is separate from an arbitrary Azure AI resource key.

`WEB_IQ_CONTRACT`, `WEB_IQ_VERIFICATION_URL` and `WEB_IQ_REQUEST_USD` remain reserved compatibility fields, not activation switches. Use the separate `WEB_IQ_RESPONSES_*`, `WEB_IQ_READONLY_TOOLS_JSON`, `WEB_IQ_SEARCH_VERIFIED` and `WEB_IQ_SEARCH_RATE_CARD_JSON` settings for the implemented adapter. Without these settings, search fails before a network request or charge. No fallback search engine or guessed raw REST request is used.

## HTTP and WebSocket contract

Public: `GET /api/health`, `GET /api/capabilities`, `POST /api/register` (shared `Registration` → `RegistrationResult`).

The HTTP registration boundary defaults omitted `marketingConsent` to `false`; explicit privacy consent remains mandatory. Persisted records always include the resolved boolean.

Visitor Bearer token: `GET /api/demo` → `DemoState`, `GET /api/usage` → `UsageSummary`, `POST /api/actions` (`ActionRequest` → `ActionResult`). Costs remain `null` when unconfigured/unknown, not zero. Token expiry is 24 hours, and gateway-owned demo state must still exist. No credentials or transcripts are persisted in that state.

WSS `/ws` requires `{ "type": "auth", "token": "..." }` as its first message within five seconds. Rejects unapproved browser origins. Then uses shared `clientEventSchema`. Upstream sessions, tools, instructions, and credentials are exclusively server-owned. Relay audio is PCM16; only audio append/commit/clear, one validated audio-only WebRTC SDP offer, response cancel, and bounded conversation truncation pass through. Arbitrary session changes, tool outputs, URLs, models, and client-created responses are rejected.

All actions require a UUID `callId`; reuse with different parameters is rejected. Confirmations expire after 60 seconds and bind to the same call, action name and normalized arguments. Resubmit the **original action** plus `confirmationId` and `confirm: true/false`. Repeated completed calls return the original result without repeated effects or paid calls. A voice tool waiting for confirmation resumes only after that matching action result.

Confirmation results include `data.action: {callId,name,args}` (normalized arguments), `data.preview`, and `data.expiresAt`. The frontend can replay `data.action` plus the result's `confirmationId` and `confirm` for voice-originated actions that have no locally retained request.

Parameter reference:

| Action | `args` |
| --- | --- |
| `vehicle.set` | Partial `{temperature:16..30, fan:boolean, windowOpen:boolean, seatHeat:boolean, locked:boolean, driving:boolean}`; lock changes require confirmation |
| `phone.connect` | `{connected:boolean}` |
| `phone.call` | `{contact:"Alex Chen" \| "Mei Tanaka" \| "Sam Rivera"}`; confirmation required |
| `phone.hangup` | `{}` |
| `work.query` | `{kind:"meetings" \| "mail" \| "contacts"}` |
| `work.createMeeting` | `{title, startsAt:offset-aware-ISO, durationMinutes:5..480, attendees:fictional-email[], location, notes?:string}` |
| `work.updateMeeting` | `{id, ...changed meeting fields}` |
| `work.sendMail` | `{to:fictional-email, subject, body}` |
| `work.summarize` | `{id:meeting-id}` |
| `work.reset` | `{}`; resets only fictional Work IQ data, requires confirmation |
| `navigation.search` | `{query, near?:{latitude,longitude}}` |
| `navigation.route` | `{start:{lat,lon}, end:{lat,lon}}` or `{origin:{latitude,longitude}, destination:{latitude,longitude}}`; confirmation required |
| `video.search` | `{query, platform:"all" \| "youtube" \| "bilibili"}`; official Responses/Web IQ search, unavailable until reviewed tools, credentials and prices are configured |
| `media.control` | `{platform, command:"open" \| "play" \| "pause" \| "stop" \| "volume", url?, volume?:0..100}` |

Fictional email addresses: `alex@example.test`, `mei@example.test`, `sam@example.test`. Writes require confirmation; no outbound mail occurs. Meeting dates/time zones, duplicate attendees, overlaps and IDs are validated deterministically.

Maps search `data`: `{places:[{id,name,address,latitude,longitude}], fetchedAt, source}`. Route `data`: `{distanceMeters,durationSeconds,arrivalTime?,points:[{latitude,longitude}],origin,destination,simulatedProgression:true,fetchedAt,source}`. Video `data`: `{videos:[{title,url,platform,videoId}],citations:[{title,url}],fetchedAt,source,contentIsUntrusted:true}`.

Media `data`: `{request:{platform,command,url?,videoId?,volume?},execution:"requested",playbackConfirmed:false}`. The frontend must perform it and use real player callbacks before showing successful playback. Bilibili only supports open/unload requests; Spotify controls are unavailable. During simulated driving, new video playback/open/volume requests are blocked.

Voice-originated media requests wait for the authenticated `media.result` event with matching `callId`, platform and command. The server validates outcome/evidence, deduplicates acknowledgements and enforces a 20-second TTL before continuing the model tool loop. A final `action.result` reports the actual acknowledged outcome or timeout; its duration measures dispatch-to-acknowledgement time. Opening is not playing, and only YouTube's observed playing state confirms playback.

`durationMs` uses server `performance.now()` around actual executor work for **this request**, excluding user confirmation waiting and model/network voice latency. Tests measure the real 100-call mock query sample's p95 against 50 ms; no delay, fixed fake duration, or whole-turn latency claim.

## Administrator API

Set `ADMIN_TENANT_ID`, `ADMIN_AUDIENCE`, `ADMIN_CLIENT_ID`, `ADMIN_SCOPE` (a delegated API scope, not `.default`) and `ADMIN_ROLE` (default `Lead.Admin`). Every private route validates an RS256 Entra JWT's exact issuer/audience/tenant, authorized client (`azp`), delegated scope, expiry and role. Demo tokens are not administrator tokens. The browser console is `#/admin`; register the MSAL v5 SPA callback `<web-origin>/<base-path>?admin-auth=1`. Authentication and lead data stay in browser memory.

- `GET /api/admin/config`: public non-secret readiness and login identifiers; no lead data.
- `GET /api/admin/leads`: company/scenario/status filters, limit 1–200, signed filter-bound cursor, `{leads,limit,nextCursor}`.
- `GET /api/admin/leads/export`: filtered streaming CSV across pages, spreadsheet-formula escaped.
- `POST /api/admin/leads/:id/follow-up`: status/notes only; preserves original 90-day expiry and sends no email.
- `DELETE /api/admin/leads/:id`: deletes lead and usage, stops voice and revokes active demo state.
- `GET /api/admin/overview`, `/api/admin/usage`: application estimates, never represented as an invoice.
- `POST /api/admin/emergency-stop`: explicit confirmation; blocks new paid work and attempts to stop all live sessions even if audit storage fails. Resume requires restarting with emergency stop disabled.
- `GET /api/admin/billing?from=YYYY-MM-DD&to=YYYY-MM-DD`: provisional Azure scope costs, inclusive 1–31 UTC days, only when `AZURE_COST_SCOPE` and identity permissions are configured.

Admin operations emit content-free hashed audits. Visitor `GET /api/diagnostics` exposes a bounded, content-free in-memory event ring; its browser durations and server offsets use separate clocks.

No Microsoft 365, Spotify tokens or raw audio/transcripts are stored. Lead listing/export is sensitive and must remain administrator-only. Infrastructure costs and Azure billing reconciliation are not represented as verified per-turn costs.
