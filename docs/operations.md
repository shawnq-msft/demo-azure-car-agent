# Operating the demonstration

## Before a demonstration

1. Confirm registration/privacy text and clear **simulation** badges. Work IQ uses fictional data; do not enter confidential content.
2. Check `GET /api/health` and the application's capabilities view. Health success does not mean Voice Live, Maps, Web IQ, Spotify or admin access is ready.
3. Check actual requested model, provider status and transport. Three distinct adapters are implemented, but each paid path remains disabled until its credentials, deployment attestation and rates are configured; no silent fallback.
4. Verify secrets have not reached the client bundle, logs or URLs. Keep browser tools/screenshots free of user tokens and lead data.
5. Confirm paid-service pricing/admission and emergency procedures. In-memory local storage is not a public paid-service budget.
6. Test a read-only mock calendar query, a proposed simulated send, reject/confirm, and reset. Verify no real mail is sent.
7. Test a permitted video through an official player, explicit play interaction and external-link fallback. Demonstrate native-only Bilibili controls honestly.
8. Test language change, stop/idle/hidden-page cleanup, network error and quota denial with no continuing upstream audio.

## Budget and concurrency limitations

The intended demo limits are 10 minutes/session, 60 seconds idle, 20 minutes or estimated US$2 per visitor/day, estimated US$50/site/day, with UTC daily boundaries. These are **application estimate/admission limits, not Azure billing caps**. They cannot cover every infrastructure cost or stop every charge instantly.

The API's Cosmos adapter uses ETag conditional replacement for a daily ledger containing visitor and global amounts. This provides a foundation for atomic admission; cloud failure/race/restart behavior still needs integration validation. A single daily document also has Cosmos document-size/hot-partition limits: do not claim unlimited visitors or production scalability. Local memory mode does not survive restart. Per-process mock sessions, confirmation state, connection ownership and concurrency counts are not distributed.

Do not enable paid public access until tests show:
- Concurrent/duplicate reservations, rejection and settlement preserve global and visitor invariants.
- Restart/timeout/aborted response/UTC midnight do not reset or undercount outstanding authorized spending.
- Failed admission never opens a chargeable upstream; missing usage fails closed.
- In-flight cost reservation is conservative for actual rate units and output limits.
- Identity/rate limits and bot controls handle repeated registrations appropriately.
- Emergency stop denies new paid activity **and actively terminates ongoing upstreams**.

Keep `minReplicas=1`, `maxReplicas=1` and one active revision, but do not infer that revision transitions never overlap. No hard financial guarantee is made. Azure Cost Management alerts supplement, rather than replace, application admission and service shutdown.

## Pricing: unknown is not zero

| Component | Reporting rule |
| --- | --- |
| Voice Live/model/BYOM | Verified model, region, API mode and official billing units; avoid double-counting included components |
| Maps and official Web IQ | Verified request/unit prices and source/version; disabled paid path if unknown |
| Work IQ Mockup | External Work IQ service calls/cost are zero; speech, compute and storage are not zero |
| ACA, ACR, Cosmos, telemetry | Infrastructure cost, separately reported; not falsely attributed to a specific token/turn |
| Spotify | User subscription/platform requirements, not fabricated Azure or per-track charges |
| Video embeds | External platform behavior; no invented per-play fee |

Label separately: **estimated**, **usage pending**, **unknown/not included**, and **reconciled to bill**. Missing usage is not free usage. Rate cards require official source URL, effective time, currency, region, model and version. There are no trustworthy universal default rates in this repository. Cached input is conservatively priced at the configured uncached input rate; the UI labels this upper-bound estimate and does not invent cache discounts.

Use [Azure Pricing Calculator](https://azure.microsoft.com/pricing/calculator/) with the selected region and expected traffic to estimate deployment cost. Reconcile actual daily service totals with [Azure Cost Management](https://learn.microsoft.com/azure/cost-management-billing/costs/overview-cost-management). Cosmos serverless, one warm ACA replica, ACR storage/builds, telemetry and networking can charge while nobody is speaking. Log Analytics' configured daily ingestion cap is not an overall spending cap and can suppress useful diagnostics.

## Observability and latency

Infrastructure includes Log Analytics and Application Insights, but creating these resources and passing a connection string does not instrument the API. Verify SDK/AAD support and explicit redaction before enabling collection. Latest content-free usage snapshots are stored with a 30-day TTL and exposed to authorized administrators at `GET /api/admin/usage`; read/export/delete requests are audited. These are not full-session analytics or distributed tracing.

The diagnostics panel and authenticated `GET /api/diagnostics` expose a bounded in-memory ring of 200 observations and 20 session headers per visitor. Connection, VAD, first text/audio arrival, tool outcome and browser playback-duration observations contain no conversation content. Export is explicit and local to the browser. The ring is lost on restart and does not imply visibility into internal service STT/LLM/TTS stages.

The Azure Cost Management reader uses the official `2025-03-01` Query API for daily `ActualCost` / `PreTaxCost` grouped by service, preserving each currency. Reports cover at most 31 UTC days, are cached for five minutes and are **provisional scope-level costs, not final invoices or per-visitor attribution**. Configure `AZURE_COST_SCOPE` and grant the backend identity **Cost Management Reader** at that exact resource-group or subscription scope. No role is automatically granted by this template. Billing access can be delayed or unavailable depending on the subscription agreement and permissions; errors remain visible.

Useful content-free signals: requests/errors, lifecycle codes, model/mode/region, pseudonymous session/turn IDs, tool names/status/duration, authoritative usage totals, admission denials and remaining reservations. Never collect audio, transcripts, full parameters, request bodies, email addresses, phone numbers, tokens or Work IQ contents.

Measure end-to-end latency on a single browser monotonic clock: end of user speech to first actually playable/observed output audio. Text arrival is not audio playback. Server durations use a server-local monotonic clock; do not subtract unsynchronized browser/server timestamps. For WebRTC expose real RTT/jitter/loss where available; do not invent stage timing.

The current instrumented PCM playback sample is deliberately narrower: **receipt
of the speech-end event in the browser to the Web Audio device output timestamp**.
It uses `AudioContext.getOutputTimestamp()`, not the scheduled playback time, and
does not include server VAD detection or uplink delay. Unsupported output timing,
cancelled playback and GPT-Live's missing authoritative speech-end events produce
no fabricated sample. Full acoustic end-to-end latency still requires a separate
live measurement. Do not compare this narrower metric directly against the
engineering end-to-end targets below.

Engineering targets, **not service promises**:
- Warm pure conversation: P50 ≤ 1.5s / P95 ≤ 3s under specified network/resource conditions.
- At least 30 valid turns per enabled model/language before comparative claims; report sample count/errors and cold starts separately.
- Work IQ deterministic mock execution: P95 ≤ 50ms over at least 100 operations, **excluding** network, confirmation wait and speech-model latency.
- Web IQ live search is measured separately. Never substitute mock timings.

Local acceptance measured 100 real `work.query` HTTP actions against the running mock executor: server execution P50 0.14ms, P95 0.23ms, maximum 0.32ms. This meets the mock-only 50ms target; it excludes network, user confirmation and Voice Live latency and is not a cloud performance guarantee. The UI reports observed mean/P50/P95 and sample count; missing samples remain unknown.

## Failures and emergency response

| Symptom | First safe action |
| --- | --- |
| Cloud API fails startup | Check signing-secret reference, identity propagation, Cosmos mode/database/container `/id` + TTL; never bypass production durability |
| Registration fails from Pages | Check exact CORS origin and HTTPS API build variable; do not replace CORS with `*` |
| Provider remains unconfigured | Inspect capability reason and missing approval/contract/rate gates; do not mark verified merely to enable it |
| Cosmos contention/unavailable | Deny admission; preserve outstanding reservations; do not fall back to volatile budgets |
| Usage reports missing | Stop further paid activity and surface unknown usage; no zero-cost assumption |
| Video not playing | Show explicit button/error/external link; respect platform policy and autoplay limits |
| Budget/abuse incident | Deny new paid sessions, explicitly close active upstreams, verify provider metrics, preserve only redacted audit evidence |
| Process/revision restart | Expect volatile mock state to reset; verify existing reservations remain protected and old upstreams close |

Changing `EMERGENCY_STOP` normally requires process configuration/revision refresh. Do not assume that flag alone instantly interrupts an already running process. If the application kill path is not proven, operators must terminate/stop the affected API instances and verify service-side activity has ceased. Avoid restoring paid access until the root cause and accounting state are reviewed.

## Acceptance evidence

Record date, source commit/image digest, environment/region, tested model and actual provider, language, browser/network, test/sample count and pass/fail. Keep non-sensitive artifacts only. Unit tests, mocked fixtures, Bicep compilation, ARM what-if, container startup, live service integration and performance acceptance are **different levels of evidence**. Never report one as another.
