# Security, privacy and public-release conditions

## Identity and access boundaries

Visitor registration is intentionally lightweight and **not identity verification**: no email challenge, no approval and no proof that one registration equals one person. Rate limits and server-issued visitor IDs reduce accidental abuse but do not prevent determined re-registration. Do not market this as strong authentication or expose high-cost public access on this basis.

Collect name, company, work email and scenario/requirements, with optional phone/project timing. Separate required privacy acknowledgment from optional marketing consent; refusing marketing cannot block the demo. Supply the operator's real contact and deletion channel before publication. Do not silently promise a deletion channel that nobody monitors.

Browser credentials should be short-lived and retained in memory. Do not restore another person's identity solely by matching an email address. Administrator access needs independent Entra authentication and a verified app role; never infer administrator rights from visitor-supplied fields.

Exact CORS and WebSocket Origin checks are defense in depth, **not authentication**. Authenticate WSS using the first message with a short deadline, not a token-bearing query URL. Open no paid upstream until visitor admission and durable budget reservation succeed.

## Retention

The current storage adapter uses one Cosmos `records` container, partitioned by `/id`, with a **30-day default TTL**. Leads carry a 90-day item-level override. The larger logical collection design is not provisioned as unused physical containers:

| Data | Default TTL |
| --- | --- |
| Lead record and its embedded registration consent | Item `ttl: 7776000` (90 days) |
| Daily visitor/global budget ledger | Item `ttl: 2592000` (30 days) |
| New records without a TTL override | Container default 2,592,000 seconds (30 days) |
| Latest content-free usage snapshot per visitor | 30 days from snapshot update; Cosmos persists it, local memory does not survive restart |
| Administrator read/export/delete-request audit | 30 days; hashed administrator identity and hashed deletion target, no duplicate lead fields |
| Full sessions, transcripts and Work IQ state | Volatile; not stored |
| Log Analytics workspace | 30 days |
| Application Insights | 30-day configured retention; review inherited table settings |
| Cosmos periodic backups | Configured 8-hour backup retention; confirm regional/service behavior |

**Cosmos TTL is relative to the last modification**, not registration date. For an absolute 90-day policy, the application must compute/update per-item TTL against the original expiry; edits must not extend the promised retention. An individual `ttl = -1` would defeat the container default and must not be written. Background TTL deletion is eventual, so expired records must also be denied by query/access logic.

Check the API storage schema before deployment. Usage snapshots and audit records have explicit 30-day TTL and tests; deleting a lead also removes its usage snapshot after outstanding writes drain. Administrator audit describes attempted deletion, not proof of completion. Budget ledgers retain pseudonymous reservation identifiers for their 30-day accounting window. Do not label these records fully anonymous. Full privacy deletion/recovery behavior still requires real Cosmos validation.

The application must not persist raw audio, verbatim conversations, enterprise/Work IQ content or full tool arguments. Logs must exclude names, email/phone, tokens, authorization headers, secrets, query content and request/response bodies. Mock-entered content may still be sensitive. Inspect logging defaults before enabling any auto-instrumentation.

Audit/export/delete records contain only the minimum operational metadata, not duplicated lead fields. A real deletion workflow must delete the lead and linkable derived records and document the backup recovery window. CSV exports must neutralize formula prefixes. A restored database can reintroduce previously deleted records; maintain a privacy-safe process to replay deletion requests.

Third-party iframe providers and Azure/Microsoft services have their own processing and retention policies; the application's "no audio storage" statement does not override them. Voice Live preview/global routing requires a specific data-residency review. Obtain media consent before loading third-party players.

## Secrets and Azure access

- `.env` files are ignored, and Docker excludes them. Keep a blank/sanitized `.env.example` only.
- Use a random signing secret of at least 32 bytes in a dedicated Key Vault. Store only its **URI** in deployment inputs. Generate/set it using a secure operator process; do not paste a value into commands recorded in chat or Actions logs.
- The API user-assigned identity gets `AcrPull` at its registry, `Key Vault Secrets User` at its dedicated vault, Cosmos data contributor at its application database, and telemetry publisher at its Insights component. It is not subscription Contributor and cannot write Key Vault secrets.
- The OIDC deployment principal is separate from the API identity. Restrict federation to the repository's `azure-demo` environment, protect that environment, and scope deployment authority to a dedicated resource group.
- Cosmos local-key authentication and ACR administrator credentials are disabled. Application Insights local ingestion authentication is disabled; SDK instrumentation must use the managed identity.
- Key Vault purge protection retains deleted secrets for 90 days; this is not the lead-data TTL.
- This small demo uses publicly reachable Azure service endpoints protected by TLS/RBAC. It does **not** deploy private endpoints, a private VNet, a WAF, CAPTCHA or an enterprise network boundary. Make those decisions explicitly before a production release.

## Public-release checklist

Do not mark these passed just because `npm test` succeeds:

- [ ] Real operator identity, privacy text, deletion process and optional marketing consent approved.
- [ ] Entra admin JWT issuer/audience/role checked per request; non-admin reads/exports/deletes denied and audited.
- [ ] Registration abuse/bot controls, per-origin/per-IP and visitor limits reviewed.
- [ ] Durable, atomic visitor/global budgets survive restart, overlap and duplicate/replayed requests.
- [ ] No paid upstream without verified pricing and durable admission; kill-switch actively closes upstreams.
- [ ] Provider credentials remain server-side; no secret appears in static artifacts, URLs or telemetry.
- [ ] Consent precedes media loading; CSP/frame policies and browser permission behavior tested.
- [ ] Confirmation timeout/rejection/replay and tool allowlists tested.
- [ ] Logs sampled for prohibited PII/content; vendor retention and backups reviewed.
- [ ] Data expiry/deletion/export and TTL-on-update verified against real Cosmos.
- [ ] Dependency/health failures are explicit; production never silently changes to mock.

In-memory mock tools and one warm replica are appropriate for a controlled demonstration only. They do not close any of the durable authorization or budget requirements above.
