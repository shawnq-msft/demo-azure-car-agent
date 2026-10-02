# Azure car assistant demo

A multilingual React/Vite cockpit with a Node.js/Fastify gateway. The deployment target is **GitHub Pages + Azure Container Apps**. This is a software demonstration, not a vehicle controller, telephone service, or production identity system.

**Status:** deployment artifacts are provided; no Azure deployment, model availability, platform approval, live speech performance, or billing accuracy is claimed verified. Local simulations must remain visibly labeled. Cloud resource provisioning does not enable the gated integrations below.

## Verified locally and remaining work

- TypeScript checks and frontend/API production builds pass.
- 457 unit/integration tests are covered by successful local runs (456 in the full suite, followed by 119 native/gateway tests including one added regression). All 5 Chromium end-to-end tests pass. Coverage includes speech protocols, cancellation, registration without marketing consent, five-language selection, confirmed operations, media acknowledgements, admin gating, diagnostics export and mobile layout.
- Bicep compiles with zero warnings. No container engine was available for an actual image build; no cloud resources or GitHub Pages site have been deployed.
- Work IQ Mockup's 100-query local sample had server execution P95 below 1ms, excluding network and speech-model latency.
- Official Web IQ MCP discovery and Responses-mediated video search are implemented with offline tests. Search requires an explicit reviewed read-only tool allowlist, enabled credentials and prices, and validates every result against successful MCP source output. Filling a key alone cannot enable it. See [setup instructions](docs/web-iq.md).
- Voice-to-video acknowledgements, the five-language administrator console/follow-up workflow, content-free session diagnostics and provisional Azure Cost Management queries are implemented. Distributed traces and final-invoice reconciliation are not implemented.
- All three requested speech paths are implemented with offline protocol tests; actual Azure deployments remain unverified and disabled without configuration. Spotify is external-link-only for the policy reasons below.

## Run locally

Use Node.js **22 or later** and npm from the repository root:

```powershell
npm ci
Copy-Item apps\api\.env.example apps\api\.env
npm run dev:api
# In another terminal:
npm run dev
```

Read the API environment example before configuring integrations. Use `apps\api\.env` for backend secrets; `.env` files are Git-ignored. **Never put keys in chat, `VITE_*` variables, screenshots, logs, or the repository.** Restart the API after changing its environment.

The API defaults to port `3001`; Vite defaults to `5173`. Configure `ALLOWED_ORIGINS` to match the exact local browser origin, including host and port. `localhost` and `127.0.0.1` are different origins.

```powershell
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Browser tests require Playwright's Chromium browser. CI installs that browser; local installation is a separate prerequisite. These commands do not establish that cloud integrations work.

`npm run test:e2e` builds and starts the compiled API (rather than a watch process), then starts Vite. Test mode does not load the developer's `.env`; real provider tests are a separate explicit activity. If Chromium is missing, run `npx playwright install chromium`.

## Capability and configuration matrix

| Capability | Default / release gate | Required before claiming real operation |
| --- | --- | --- |
| Simulated cockpit and phone | Explicit simulation | Never represents actual hardware or a real call |
| Work IQ | **Mockup only** | Fictional identity/data; read, write preview/confirmation, simulated sent mail, reset; never real Microsoft 365 mail |
| `gpt-realtime-2.1` | Configurable target, not a deployment guarantee | Approved Voice Live resource, region/protocol, five-language audio/tool tests and durable usage admission |
| `gpt-live-1` | Native PCM/Entra adapter and optional Sol Responses tool delegation implemented; configuration-gated | Verified GPT-Live resource/hourly pricing; tool mode additionally requires an explicitly disclosed, attested Sol deployment and token rates. Standalone client delegation cannot run voice tools |
| `gpt-6.1-sol` | Speech STT / Responses / Speech TTS cascade implemented; configuration-gated | Verified Speech and Sol Responses deployments, stage prices and five-language tests; explicitly not Voice Live BYOM |
| Azure Maps | Unconfigured until explicitly connected | Server-side credentials, actual search/route verification and rate limits; no long-lived map key in the browser |
| Official Web IQ | Implemented; disabled until configured | Enabled credential, gpt-6.1-sol Responses deployment, reviewed read-only tool allowlist and pricing; source-backed canonical video results |
| Spotify | User-clicked external link only | No Web API, Playback SDK, or voice control in this release; dedicated permission covering this use case required for expansion |
| YouTube / Bilibili | Official embeds or external links, subject to platform restrictions | Validated URLs/IDs, user gesture/consent, real platform availability; no downloaded or proxied media |
| Persistence | Optional Cosmos for supported data paths | Managed identity + verified container schema; provisioning Cosmos alone is **not** proof of durable budget enforcement |
| Administrator features | Implemented at `#/admin`; fails closed if unconfigured | Entra issuer/audience/client/delegated-scope/app-role validation; visitor registration is not admin access |

The API implements **Voice Live WebRTC preview signaling and an explicit WebSocket relay**. WebRTC signaling has upstream-stub tests, but neither transport has been verified against a live Azure resource. WebRTC remains gated by `VOICE_LIVE_WEBRTC_VERIFIED=true` plus credentials and verified pricing; that flag must attest actual target-resource usage/tool events, media termination on control-channel close, and preview/global-routing approval. It is not a substitute for those checks. See [API configuration and protocol notes](apps/api/README.md); local tests do not validate a paid provider.

**Full Spotify integration is blocked, not complete.** [Spotify Developer Policy](https://developer.spotify.com/policy/) III.3 prohibits voice-enabled Spotify control, III.5 prohibits integration with other services' streams, and III.7 prohibits overlapping other audio. Premium, a developer allowlist or generic commercial approval does **not** override those restrictions. The default is explicit user-clicked external Spotify links/search only: no in-app streaming, voice control or Spotify auto-ducking. A separate documented exception covering **this voice-assistant/multi-service scenario** is required before expanding that scope.

Any separately approved future mode must fully pause Spotify before assistant speech or other audio, not mix or duck it. Full browser playback would also require Premium; development mode permits at most **five allowlisted users**, and public/commercial access needs the relevant approval. Those additional prerequisites are not the policy exception itself. The app cannot pause external Spotify windows; users must do that themselves.

Video discovery uses **official Web IQ** through Azure Responses when its reviewed tools, access and pricing are configured. No search request is made while unconfigured. Results must be backed by successful MCP output and canonical YouTube/Bilibili video URLs before becoming official embeds. Direct validated video URLs remain distinct from search. There is no fallback to Bing, scraping, or pretend search results. Bilibili has no verified general playback-control/status API here: use its native controls; do not claim voice pause, volume, or confirmed playback. External Spotify playback cannot be stopped by this app.

YouTube voice controls wait for correlated browser state/volume acknowledgements; dispatch alone is not playback success. A missing acknowledgement times out after 20 seconds. Assistant audio pauses video; WebRTC conservatively retains audio focus for the voice session. The administrator console provides filtering, pagination, follow-up records, CSV export, deletion, emergency stop and provisional billing. See [deployment configuration](docs/deployment.md) for Entra callback and Azure permissions.

## Deployment and safety

- [Deployment guide](docs/deployment.md): Azure prerequisites, OIDC, Key Vault, Pages base path, Docker and rollback.
- [Integration gates](docs/integrations.md): model verification, official API requirements and platform restrictions.
- [Security and privacy](docs/security-privacy.md): identity limits, retention and public-release checklist.
- [Operations and pricing](docs/operations.md): budget limitations, measurement, health checks and cost reporting.

The Bicep default provisions **foundation only**, not a running API. Once deployed, the API uses one warm replica (`minReplicas = maxReplicas = 1`). This limits scale but does not make in-memory sessions or budgets restart-safe; revisions can overlap. Do not open paid/public access until durable atomic budget admission, bot controls, administrator kill-switch and live shutdown paths are verified.

Lead retention is **90 days**, de-identified metrics **30 days**. Registration does not verify the email or a unique natural person. Raw audio, transcripts and Work IQ contents must not be persisted or logged. Third-party service processing/retention requires separate review.

No media Blob storage is created. Warm compute, ACR, Cosmos, telemetry and external services can incur charges even with no active user. Displayed cost estimates are not Azure invoice totals or hard spending caps.

## Layout

```text
apps/web             React, Vite, cockpit and localization
apps/api             Fastify gateway and server-side integration gates
packages/contracts   Shared TypeScript contracts
infra                Bicep foundation and single-replica API
.github/workflows    Checks, manually dispatched Pages and Azure deployment
tests                Local browser acceptance tests
docs                 Deployment, limitations, privacy and operating guide
```
