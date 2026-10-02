# Integration gates and verification

An environment variable or provisioned Azure resource is not proof of a working provider. Preserve separate states such as `mock`, `unconfigured`, `unauthorized`, `unavailable`, `pending-verification` and `ready`. Do not substitute a provider or target model silently.

## Voice and target models

| Requested model | Intended path | Release evidence |
| --- | --- | --- |
| `gpt-realtime-2.1` | Voice Live real-time speech | Actual resource/model/region, protocol/API version, audio input/output, interruption, five languages, function-call round trip, usage and forced disconnect |
| `gpt-live-1` | Implemented native Azure GPT-Live PCM/Entra adapter | Disabled until deployment/rates are configured. `/openai/v1/live/sessions` is not the Voice Live realtime endpoint |
| `gpt-6.1-sol` | Implemented Speech STT -> Sol Responses -> Speech TTS | Disabled until Speech/Responses credentials, target attestation and stage prices are supplied. This conventional cascade is not Voice Live chat-completion BYOM |

Development-tool model availability is not Azure subscription availability. Do not map an unsupported request to another model and label it successful.

The plan targets Voice Live WebRTC audio with a server-side control channel and an explicit WebSocket fallback. Implementing UI states or issuing a session ID is not implementation of that transport. WebRTC is preview and can use global-standard routing: an Azure resource's region is not a promise that all processing remains in that region.

The current API implements both the explicit WebSocket relay and the [documented WebRTC preview signaling](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-webrtc). WebRTC is upstream-stub tested, not live-Azure tested, and fails closed without `VOICE_LIVE_WEBRTC_VERIFIED=true`, credentials and verified pricing. Set that flag only after verifying target-resource authoritative usage/tool events on the server control channel, RTP termination when that channel closes, and approval of preview/global-standard routing. Neither transport has been validated against a paid Azure resource in this implementation.

WebRTC negotiation starts through the authenticated gateway WebSocket, followed by an audio-only SDP offer. The backend injects the session instructions/tools; browsers cannot override them. No browser RTC data channel is permitted. The alternate authenticated `/api/voice/calls` POST accepts `{sessionId,sdp_offer}` for that existing control session; the answer still arrives over the gateway WebSocket. Negotiation times out after 15 seconds. Final uncertain RTP usage retains its budget reservation rather than receiving a fabricated refund. See the [API operational notes](../apps/api/README.md) for exact event and rate-card contracts.

Official examples use WebSocket API version `2026-04-10` and WebRTC `2026-01-01-preview`. Verify versions against the chosen resource and current official protocol documentation rather than interchanging them. Browser speech synthesis or an OS microphone permission prompt is not Azure Voice Live.

For each enabled target, verify `en-US`, `zh-CN`, `ja-JP`, `ko-KR`, `de-DE`; request/actual model and mode must remain visible. Confirm stop/disconnect on 60-second idle, 10-minute session limit, hidden page, lost connection, quota exhaustion and model/language change. Never send an Azure long-lived key to the browser.

References:
- [Voice Live overview](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live)
- [Voice Live supported models](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-models-regions)
- [Voice Live reference](https://learn.microsoft.com/azure/ai-services/speech-service/voice-live-api-reference)
- [GPT-Live event reference](https://learn.microsoft.com/en-us/azure/foundry/openai/gpt-live-reference)
- [GPT-Live delegation](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/gpt-live-delegation)
- [Azure model catalog](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure#gpt-61)

Verified GPT-Live differences: start with `session.start`, wait for `session.started`, send `session.input_audio.append`, and consume `session.output_audio.delta` (24 kHz mono PCM16). Usage is **cumulative seconds**, including silence/backend work, with intermediate `session.usage.updated` snapshots and final `session.closed` usage. Never sum those snapshots or parse them as Voice Live token usage. Transcript fragments are not authoritative turn boundaries. The inspected reference does not define Realtime-style VAD, output truncation or response-cancel commands; do not forward those commands unchanged.

GPT-Live client delegation supplies metadata, not function arguments/task text; standalone mode explicitly declines it rather than inventing a task. Optional Responses delegation is implemented through nested function calls in `response.event`, correlated tool outputs and confirmations. It explicitly discloses `gpt-live-1 + gpt-6.1-sol (tools)` and requires separate Sol model pricing and deployment verification. Limits are four backend responses and eight tool calls per voice session; ambiguous concurrent delegation stops rather than misrouting an unscoped continuation. Missing backend usage retains the reservation. Public model listing does not prove the exact combination is enabled in this subscription.

The Sol cascade uses server energy VAD, antialiased 24-to-16-kHz PCM conversion, short-audio Speech recognition, stateless `store:false` Responses with bounded in-memory context, and escaped SSML with five locale-specific Neural voices. It propagates per-turn cancellation through confirmed tools, Maps and Web IQ. Aborting uncertain paid speech/model work conservatively ends the session and retains its reservation. Session time, STT seconds, Responses tokens and TTS characters are measured separately; Han TTS characters use a conservative double-billing upper bound.

Native GPT-Live and the conventional cascade support WebSocket PCM only. Observed browser latency is speech-end-event receipt to actual audio-output timestamp, excluding VAD/uplink; unavailable boundaries are not fabricated. GPT-Live transcript fragments do not supply authoritative token or turn counts, and its absence of a documented output-done event requires media audio focus for the entire session.

Public pricing research found GPT-Realtime-2.1 Global East US model token prices on the [Azure OpenAI pricing page](https://azure.microsoft.com/en-us/pricing/details/azure-openai/), and Live 1 hourly meters in the [Azure Retail Prices API](https://prices.azure.com/api/retail/prices). These are not automatically Voice Live tier prices or proof of the selected deployment-to-meter mapping. No retrieved number has been silently installed as a rate card.

## Official Web IQ: documented contract required

Web IQ is a limited-access service. Microsoft's [official pinned sample](https://github.com/Azure-Samples/azure-openai-responses-api-samples/blob/5e1d5cec3467280bb85066fb218392bfb3735890/python/responses-webiq-aoai-v1.py) documents remote MCP at `https://api.microsoft.ai/v3/mcp`, authenticated with `x-apikey`. A separate sample documents Entra access to `https://api.microsoft.ai/.default`. Neither establishes that an arbitrary Azure AI key/application has Web IQ permission.

**Current implementation:** the Responses-mediated search adapter is implemented with offline tests. It uses the documented MCP connection, an operator-reviewed read-only tool allowlist, strict application-owned normalization and independent URL evidence from successful MCP output. The old reserved contract flags cannot enable it. Actual access/tool review and the separate search rate card are required; see [configuration and limits](web-iq.md). Live YouTube/Bilibili acceptance remains unverified without credentials.

1. Use the documented MCP connection for authenticated read-only tool discovery (see [discovery instructions](web-iq.md)); obtain the video-tool request/response schema, timeout/rate-limit behavior and pricing from actual discovery/onboarding documentation. Do not invent a `/search` endpoint.
2. Put `WEB_IQ_API_KEY` only in the API's ignored local `.env`, or an API-dedicated Key Vault secret. Put the endpoint in `WEB_IQ_ENDPOINT`. Do not ask anyone to paste the key into chat.
3. Review the discovered read-only tools, configure the implemented Responses-mediated adapter, and verify the actual gpt-6.1-sol deployment and all prices. An endpoint/key pair alone does not enable search.
4. Test authorized search, denied credentials, throttling, timeouts and source extraction. Save only non-sensitive verification evidence.
5. Include site-constrained video searches for `youtube.com` / `youtu.be` and `bilibili.com`; validate returned canonical URLs and IDs again on the server. Missing titles or thumbnails remain missing.

No generic web-search provider or fixture may masquerade as official Web IQ. Search-result text is untrusted data, not system instructions or permission to invoke tools. Do not accept arbitrary callback URLs, iframe URLs, media streams or model-selected hosts.

## Work IQ Mockup

This release is deliberately **not** the official Work IQ service. It needs no Microsoft 365 login and performs no real mail/calendar access. Demo personas are fictional, isolated from lead-registration email addresses.

- Queries and meeting summaries use deterministic fictional data.
- Meeting creation/modification and simulated sending require a preview and explicit confirmation.
- Rejected/expired confirmation cannot mutate state. Repeating a call ID must not repeat a mutation.
- Sending adds to a simulated sent list only. Never show a real Microsoft source link or claim delivery.
- Reset restores the fictional dataset; ending the session discards its volatile state.
- Do not enter real business confidential content. A "mock" label does not make user-entered data non-sensitive.

Provider interfaces are expansion points, not implemented M365 authorization, OBO, or production write permissions.

## Spotify: external links only

The current deliverable is a **user-clicked link to Spotify**. It neither controls nor observes playback there. Do not automatically open it from a voice command or report "playing", "paused" or a successful volume change based on opening a URL.

Before any future Web API/Playback SDK implementation, obtain specific permission covering voice-assistant control, integration with other streaming services and the proposed commercial demonstration. A generic commercial approval, Premium subscription or developer allowlist does not automatically exempt [Spotify Developer Policy](https://developer.spotify.com/policy/) III.3/III.5/III.7.

Specifically, III.3 prohibits voice-enabled Spotify control, III.5 prohibits integrating other services' streams, and III.7 prohibits overlapping other audio. **Full Spotify integration remains an external blocker, not a completed feature.** Only a separate documented exception covering this voice-assistant/multi-service scenario could change the default.

Do not route voice `media.control` actions to Spotify: return an explicit policy-restriction result, not an apparent playback success or a silently opened external window. There is no Spotify auto-ducking. In any separately approved future mode, pause playback fully before assistant speech or other audio; lowering volume while overlapping is not a substitute. External Spotify is outside this app's control: ask users to pause it manually.

For a separately approved future feature:
- Full browser playback requires [Spotify Premium](https://developer.spotify.com/documentation/web-playback-sdk).
- [Development mode](https://developer.spotify.com/documentation/web-api/concepts/quota-modes) has a maximum of five allowlisted users; public audience needs applicable access approval.
- Use separate user OAuth authorization-code + PKCE, exact redirect URI/state validation and minimal scopes. Keep refresh tokens server-side with expiry/revocation and encrypted temporary storage.
- Never download, cache, transcode, analyze with AI, or proxy Spotify audio/lyrics. Do not mix Spotify audio with video or assistant speech.

## Official video players

- **YouTube:** allowlist canonical IDs and use its [IFrame Player API](https://developers.google.com/youtube/iframe_api_reference). Set the actual browser origin when enabling the API. A command is not proof of playback: observe documented state/error events. Respect origin/referrer requirements, autoplay restrictions and embedding, age, copyright and region denials.
- **Bilibili:** use the [official external player](https://player.bilibili.com/) and native controls. No unverified `postMessage` protocol. Opening/switching is supported conceptually; generalized remote pause, volume and reliable playback status remain unsupported until documented and tested.
- Offer explicit click-to-load/play and an external link on failure. Do not bypass advertisements, authentication, paid content, DRM, copyright or region restrictions.
- Stop/unmount videos during simulated driving. Where Bilibili audio cannot be controlled, unmount before voice interaction and require an explicit user action to restore. Do not automatically resume after a user pause.
- No media downloads, Blob mirror, stream extraction or proxy.

## Maps and administrator access

Azure Maps must use server-side search/route access or a verified short-lived scoped token design; do not put a long-lived subscription key in a Vite bundle. Real route search does not make simulated location progression real navigation.

Admin functionality requires separate Microsoft Entra authentication, exact issuer/audience validation and an administrator app role checked for every request. A local configuration token is not equivalent to production Entra RBAC. Do not publish lead listing, export or deletion endpoints until the authorization and audit tests pass.
