# ARIA cockpit frontend

React 19 / Vite / TypeScript. Run from the repository root:

```sh
npm run dev --workspace @car/web
npm run build --workspace @car/web
npx vitest run apps/web/src/utils.test.ts apps/web/src/audio.test.ts apps/web/src/components.test.ts
```

`VITE_API_BASE_URL` defaults to `http://localhost:3001`. `VITE_BASE_PATH` sets the GitHub Pages repository base, for example `/demo-azure-car-agent/`. Both are build-time, nonsecret values. Never put AI/provider credentials in Vite variables. Allow `http://127.0.0.1:5173` on the development API CORS allowlist.

Registration bearer tokens and conversations remain in memory. Reloading requires registration again. The frontend uses shared registration/action contracts, and all state changes come from the API. Confirmation dialogs replay the exact original call ID, action and arguments.

## Voice

The current backend advertises **WebSocket relay** support, so the selectable transport is explicitly labeled fallback. AudioWorklet captures microphone input, resamples 44.1/48 kHz to mono 24 kHz PCM16, and sends 100 ms chunks after `voice.started`. WebAudio schedules actual server audio, clears it on interruption, and reports heard duration through `conversation.item.truncate`. Hidden pages, transport/model/language changes, idle timeout, connection failures, cancellation and unmount stop media tracks, worklets, audio contexts and peer connections. No audio is recorded to storage.

Both WebRTC and the explicit PCM WebSocket fallback are implemented. The backend forwards `/calls` SDP under its target-resource verification gate; the frontend enables WebRTC only when `voiceTransports.webrtc.status` is `ready`, never by interpreting explanatory text. WebSocket is usable when the model's configured capability is ready. Verified official documentation: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/voice-live-webrtc . The client sends `rtc.call.sdp.create` with `sdp_offer`, and applies `rtc.call.sdp.created.sdp_answer`. The backend injects trusted session configuration and uses `2026-01-01-preview` at `/voice-live/realtime/calls`; no key is sent to the browser. The client reports connected only after peer connectivity, not merely receipt of an SDP answer. No live Azure audio validation was possible without configured credentials.

## External capabilities

- Maps display real provider search results and route geometry/data, not a fake map or live position.
- Spotify is user-clicked external links only, per the approved platform-permission boundary. There is no SDK, OAuth, fake playing state, voice control, mixing, or auto-ducking.
- Video searches use only backend Web IQ results. Validated video IDs reconstruct allowlisted platform URLs. YouTube uses the official IFrame API; Bilibili states clearly that playback status/remote control are unavailable. Videos stop on voice start, driving, tab changes and hidden pages.
- Direct video URLs can be opened through server validation without pretending they are Web IQ search results. Client media requests are **not** claimed as executed. The current shared protocol has no media acknowledgement event; `open` selects a validated player and `stop` unmounts it. Other voice playback requests require explicit user player interaction; a complete voice-to-player acknowledgement loop remains unfinished.
- Work IQ uses the backend's allowlisted fictional contacts and requires server-bound confirmation for sends, meeting changes and reset.

### Spotify integration blocker

For the current version, **external user-clicked Spotify links are the definite scope**, not a temporary setting awaiting credentials. The user cannot provide the required scenario-specific exception.

[Spotify Developer Policy](https://developer.spotify.com/policy) III.3 prohibits voice-enabled control, III.5 prohibits integration with other service streams, and III.7 prohibits overlapping audio. Premium, a developer allowlist, or generic commercial approval is not a sufficient exception. Full Spotify integration remains **blocked, not complete** unless a separate documented exception explicitly covers this particular voice-assistant and multi-service scenario. There is deliberately no credential-based enable switch.

The client rejects Spotify `media.control` requests with a localized policy explanation rather than executing them. Opening Spotify is an explicit user link click and stops the embedded video. An external Spotify tab is outside this application's playback control; the application does not claim to pause or synchronize it. Any future separately approved integrated mode would need to pause Spotify fully before voice or other media, never merely duck its volume or overlap audio.

### Web IQ protocol verification blocker

The user cannot currently supply the official Web IQ endpoint and integration documentation. Web IQ must remain **unconfigured**, and the frontend disables video search unless the backend reports a genuinely verified ready capability. There is no fabricated result list or substitute search provider.

The browser's `/api/actions` request with `video.search` is the application's internal contract, not a claim about an official Web IQ API. Before a backend adapter can be enabled, its actual official endpoint, request and response schemas, authentication, limited-access entitlement, and pricing must be verified against provided official documentation. An API key or a locally invented adapter protocol is insufficient. This live integration remains blocked, not complete.

Local validation covers the production build and 20 utility/audio/component tests, including PCM capture/playback/confirmation gating/teardown, documented SDP fields, connection-state reporting, and exact registration/confirmation selectors. Browser checks verified registration, actual mock vehicle state, create-meeting confirmation, simulated-send confirmation, and responsive/localized UI. Configured Azure, Web IQ, YouTube/Bilibili network playback require separate live-environment verification.

Stable E2E selectors include `registration-form`, `register-name`, `register-company`, `register-email`, `register-scenario`, `register-privacy`, `register-marketing`, `register-submit`, `cockpit`, `locale-select`, `vehicle-temperature`, `work-tab`, `work-create-meeting`, `work-send-mail`, `action-confirm`, and `action-cancel`. The two Work action selectors open their respective forms; the mail opener is visible in the Mail subtab. The temperature selector identifies the rendered server value, including its degree symbol. Locale follows supported browser languages and otherwise defaults to English (`en-US`).
