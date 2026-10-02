# Deployment guide

## Validation status

The official Bicep CLI compiles `infra/main.bicep` with **zero warnings**. Workflow YAML parsing, API environment/schema mappings and the esbuild contracts-bundling check are local checks only; they do not validate Azure permissions, resource availability or service integration.

The Docker CLI is not installed in the development environment, so an actual container build/smoke test remains unverified. No Azure deployment or live cloud-provider acceptance test has been performed. ARM what-if and deployed runtime checks still require the operator's repository, subscription and authorized configuration.

## What is and is not deployed

`infra/main.bicep` creates a Basic ACR, user-assigned API identity, Container Apps consumption environment, serverless Cosmos account/database/`records` container, dedicated RBAC Key Vault, Log Analytics and workspace-based Application Insights. An optional module creates the public HTTPS API on port `3001`.

It does **not** create Voice Live/model deployments, Azure Maps, Web IQ access, Spotify approval, Microsoft 365 integration, DNS/custom certificates, a WAF/bot service, Entra app registrations or media Blob storage. Do not treat "deployment succeeded" as provider approval or successful real-time audio.

Cosmos uses `/id` partitioning and TTL enabled, matching the current API storage adapter. Leads specify 90-day TTL; the default and daily budget ledger use 30 days. Local key authentication is disabled; the API uses `DefaultAzureCredential` and its user-assigned identity.

The API has **one warm replica, maximum one**, one active revision, and a conservative one-session admission setting. Warm compute costs money when idle. One-replica scaling is not a mutex: revisions can overlap, process restarts lose mock state and live-session ownership is not distributed. Do not increase replica/concurrency settings without load, race, crash-recovery and durable-budget tests.

## Prerequisites

1. A repository containing a current `package-lock.json`; Node.js 22+, npm and passing root checks.
2. GitHub Pages configured with **GitHub Actions** as its source.
3. An Azure subscription and a dedicated existing resource group in an approved region. Check Container Apps, Cosmos **serverless**, ACR and Log Analytics availability and quotas in that region.
4. Required resource providers registered by the subscription operator: `Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.ManagedIdentity`, `Microsoft.KeyVault`, `Microsoft.DocumentDB`, `Microsoft.OperationalInsights`, `Microsoft.Insights`.
5. Current Azure CLI with Bicep installed for a local preview; the deployment workflow installs Bicep on its runner.
6. An Entra workload identity/application with a GitHub federated credential:
   - Issuer: `https://token.actions.githubusercontent.com`
   - Subject: `repo:OWNER/REPOSITORY:environment:azure-demo`
   - Audience: `api://AzureADTokenExchange`
7. Protect the GitHub `azure-demo` environment with allowed deployment branches and reviewer approval. Repository administrators must configure these rules; YAML cannot guarantee them.
8. Set environment variables `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` in that environment. They are identifiers, not client secrets. **Do not configure an Azure client secret.**

Scope the deployment identity to this resource group. It needs resource deployment/ACR build permissions plus role-assignment authority to bootstrap the scoped API roles. Ordinary Contributor cannot create the role assignments. Prefer an operator-managed bootstrap and a restricted custom deployment role, or conditional Role Based Access Control Administrator restricted to the exact role definitions/principals this template creates. Do not solve this with subscription Owner. Role propagation can take time; inspect authorization errors rather than broadening scopes automatically.

The runtime API roles are narrowly scoped:

| Permission | Scope |
| --- | --- |
| AcrPull | Dedicated registry |
| Key Vault Secrets User | Dedicated API vault |
| Cosmos DB Built-in Data Contributor | `car-demo` database data plane |
| Monitoring Metrics Publisher | Application Insights component |

The runtime identity cannot create resources or write/delete vault secrets. Cosmos data contributor can mutate all records in this application database; it is not suitable for a vault/database shared with unrelated applications.

## Manual GitHub OIDC workflow

The Azure workflow triggers **only** through `workflow_dispatch`. Nothing deploys to Azure on a push/PR. Inputs are non-secret:

- `operation`: `what-if` (default), `foundation`, or `deploy`.
- `resource_group`: existing dedicated resource group.
- `location`: approved Azure region.
- `name_prefix`: stable 3–12 lowercase alphanumeric characters, beginning with a letter.
- `allowed_origins`: comma-separated exact HTTPS origins, with no path/trailing slash, e.g. `https://YOUR-ORG.github.io`.
- `auth_secret_uri`: URI of a `TOKEN_SIGNING_SECRET` stored in **this deployment's** Key Vault, never its value.

Recommended first deployment:

1. Dispatch **what-if**. It previews foundation resources without creating/updating them. It does not preview the API module or build an image. ARM what-if may show provider-calculated values as unknown.
2. Review costs, region, networking, role scopes, retention and resource names. Dispatch **foundation** only after approval. This creates billable resources but no API.
3. An authorized operator creates a random signing secret of at least 32 bytes in the new vault. Use a secure input mechanism or Azure portal; never commit or print the value. Save only its secret URI for the workflow.
4. Dispatch **deploy** with the same group/region/prefix, exact frontend origins and secret URI. It runs the existing checks, deploys the foundation incrementally, builds the Dockerfile with ACR Tasks, resolves the image to a digest, previews the full deployment, then deploys it. This full what-if is informational within an already approved deployment job, **not a second approval pause**.
5. The workflow checks `/api/health`. That proves HTTP reachability only, not provider readiness, quotas or durable fail-closed behavior. Perform the acceptance checklist separately.
6. Record the API URL from the deployment output/job summary. Do not include a trailing slash or path in `VITE_API_BASE_URL`.

No keys or secret values are workflow inputs or outputs. `auth_secret_uri` is non-secret metadata. The workflow rejects a signing-secret URI outside the dedicated vault. Versioned secret URIs give explicit rotation; versionless references follow the platform's refresh behavior. After rotation, verify actual token/signing behavior and plan invalidation of existing visitor tokens.

First deployment has live integrations disabled because their configuration/rate cards are absent. Configuring endpoint/key alone does not satisfy every integration gate. Do not use `NODE_ENV` changes to bypass production persistence validation.

Optional administrator/billing environment variables are `ADMIN_TENANT_ID`, `ADMIN_AUDIENCE`, `ADMIN_CLIENT_ID`, `ADMIN_SCOPE`, `ADMIN_ROLE` (default `Lead.Admin`) and `AZURE_COST_SCOPE`. The workflow passes them to the corresponding Bicep parameters when deploying the API. Configure Entra app registrations/roles separately; these identifiers do not grant access. For billing, an operator must separately grant **Cost Management Reader** to the output `identityPrincipalId` at exactly the configured billing scope; the template does not automatically grant subscription access.

The console route is `#/admin`. Register the SPA redirect URI as `<web-origin>/<base-path>?admin-auth=1` (for example, `https://YOUR-ORG.github.io/YOUR-REPO/?admin-auth=1`). The MSAL v5 redirect bridge is eagerly imported; do not replace this callback with the hash route. Expose the delegated API scope, authorize the SPA to request it, assign `Lead.Admin` to the intended administrators and issue v2 access tokens for the configured API audience. A visitor registration or a successful Microsoft sign-in without role/scope does not authorize access.

## Retrieve a local Voice Live key safely

Use a separate Azure CLI configuration directory if the machine is already signed in with another account:

```powershell
$env:AZURE_CONFIG_DIR = Join-Path $env:LOCALAPPDATA 'car-demo-azure-cli'
az login --use-device-code --allow-no-subscriptions --output none
# Complete the interactive login with the intended account, then inspect its subscriptions.
az account list --query "[].{id:id,name:name,user:user.name}" --output table
.\scripts\configure-voice-azure.ps1 -SubscriptionId YOUR-SUBSCRIPTION-ID `
  -ResourceGroup YOUR-RESOURCE-GROUP -ResourceName YOUR-AZURE-AI-RESOURCE `
  -ExpectedUser YOUR-ACCOUNT-UPN
```

Keep `AZURE_CONFIG_DIR` set for all related commands. The script checks the requested account and resource kind before retrieving an existing key, confirms the backend `.env` is ignored by Git, and stores the key without printing it. It does not rotate keys, create resources, populate rates or enable a model. Existing unrelated environment values are preserved. Do not run it under PowerShell transcription, tracing or a debugger that captures variables. Production should use managed identity or Key Vault instead.

An Azure AI/Speech resource key is **not evidence of Web IQ access**. Web IQ uses its documented MCP service and an independently enabled credential. Do not copy a generic resource key into Web IQ configuration and assume it grants access.

## Optional local Bicep preview

These commands require an already authenticated, authorized Azure CLI and an operator-approved existing resource group:

```powershell
Copy-Item infra\main.bicepparam.example infra\local.bicepparam
# Edit non-secret parameters. Keep deployApi=false for a foundation preview.
az bicep build --file infra\main.bicep --stdout
az deployment group what-if --resource-group YOUR-RESOURCE-GROUP --parameters infra\local.bicepparam
```

The parameter example contains no secret. Do not put keys into a Bicep parameter file. The local copy is operator-owned configuration; review it before any commit and remove it when no longer needed. A compiled template or what-if is not proof of a successful deployment. No live Azure deployment is verified by this repository's local tests.

## Runtime configuration

Use `apps/api/.env.example` and the [API operational notes](../apps/api/README.md) for the exact supported configuration/schema. The API reads its ignored `.env` through its development startup configuration; do not bake it into an image. Container Apps supplies environment values and Key Vault secret references directly.

| Variable | Purpose / default |
| --- | --- |
| `NODE_ENV` | `production` in image/ACA; production requires Cosmos and a signing secret |
| `PORT` | `3001` |
| `ALLOWED_ORIGINS` | Exact comma-separated browser origins; no wildcard production origin |
| `TOKEN_SIGNING_SECRET` | Backend-only 32+ character random signing secret, Key Vault reference |
| `PERSISTENCE_MODE` | `memory` for local tests; **`cosmos` in ACA** |
| `COSMOS_ENDPOINT` | Cosmos account HTTPS endpoint |
| `COSMOS_DATABASE`, `COSMOS_CONTAINER` | `car-demo`, `records` |
| `COSMOS_KEY` | Optional local credential fallback; **not configured by this deployment**, whose account disables local auth |
| `AZURE_CLIENT_ID` | Runtime user-assigned identity client ID, injected by Bicep; distinct from the GitHub deploy identity |
| `MAX_REPLICAS` | `1`; runtime guard, not a replacement for ACA scale configuration |
| `MAX_CONCURRENT_SESSIONS` | `1`; do not increase without validation |
| `EMERGENCY_STOP` | `true` disables configured paid capabilities; verify in-flight shutdown, do not assume config change alone closes every session |
| `VOICE_LIVE_ENDPOINT`, `VOICE_LIVE_REGION` | Approved resource endpoint and actual region |
| `VOICE_LIVE_API_KEY` / `VOICE_LIVE_USE_MANAGED_IDENTITY` | Backend-only credential or explicit `true` identity mode; resource-level service role not provisioned by this template |
| `VOICE_LIVE_WEBRTC_VERIFIED` | Default off; `true` attests verified target preview usage/tool events, RTP shutdown on control-channel close and approved global routing; credentials/rates still required |
| `VOICE_RATE_CARD_JSON` | Validated immutable model/region/unit/version/source rate card; no invented defaults |
| `GPT_LIVE_ENDPOINT`, `GPT_LIVE_DEPLOYMENT`, `GPT_LIVE_REGION`, `GPT_LIVE_DEPLOYMENT_VERIFIED`, `GPT_LIVE_RATE_CARD_JSON` | Native GPT-Live Entra/PCM deployment and time-pricing attestation; disabled by default |
| `GPT_LIVE_RESPONSES_DELEGATION_VERIFIED`, `GPT_LIVE_RESPONSES_RATE_CARD_JSON` | Optional separately disclosed Sol Responses delegation; explicitly attested deployment, token rates/evidence and combined reservation headroom |
| `CASCADE_SPEECH_REGION`, `CASCADE_SPEECH_KEY`, `CASCADE_RESPONSES_ENDPOINT`, `CASCADE_RESPONSES_KEY`, `CASCADE_DEPLOYMENT`, `CASCADE_DEPLOYMENT_VERIFIED`, `CASCADE_RATE_CARD_JSON` | Conventional Speech/Sol/Speech cascade with independent stage costs; disabled by default |
| `AZURE_MAPS_KEY`, `AZURE_MAPS_REQUEST_USD` | Server-side Maps credential and verified positive per-request rate |
| `WEB_IQ_ENDPOINT`, `WEB_IQ_API_KEY` | Official documented endpoint and Key Vault-backed key |
| `WEB_IQ_CONTRACT`, `WEB_IQ_VERIFICATION_URL`, `WEB_IQ_AUTH_HEADER`, `WEB_IQ_REQUEST_USD` | Compatibility configuration only; these cannot enable the new adapter |
| `WEB_IQ_RESPONSES_ENDPOINT`, `WEB_IQ_RESPONSES_KEY`, `WEB_IQ_RESPONSES_DEPLOYMENT`, `WEB_IQ_READONLY_TOOLS_JSON`, `WEB_IQ_SEARCH_VERIFIED`, `WEB_IQ_SEARCH_RATE_CARD_JSON` | Official Responses/MCP video search with reviewed tools, independent source validation and separate request reservation |
| `ADMIN_TENANT_ID`, `ADMIN_AUDIENCE`, `ADMIN_ROLE` | Explicit Entra admin token validation; role defaults to `Lead.Admin` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING`, `APPLICATIONINSIGHTS_AUTHENTICATION_STRING` | Supplied by Bicep for AAD telemetry configuration; provisioned resource/config is **not proof of SDK instrumentation** |

The template has explicit environment/secret mappings for all three speech paths, Maps and official Web IQ search. It does not accept arbitrary environment overrides or raw secrets. In the GitHub environment use `VOICE_LIVE_API_KEY_SECRET_URI`, `CASCADE_SPEECH_KEY_SECRET_URI`, `CASCADE_RESPONSES_KEY_SECRET_URI`, `AZURE_MAPS_KEY_SECRET_URI`, `WEB_IQ_API_KEY_SECRET_URI` and `WEB_IQ_RESPONSES_KEY_SECRET_URI` for secret references in this deployment's dedicated vault, never key values. GPT-Live uses Entra; separately assign the runtime identity the required service-level role. Re-running the workflow reapplies declared configuration; do not rely on undocumented portal edits.

The template maps `VOICE_LIVE_WEBRTC_VERIFIED` with a default of `false`. WebRTC signaling is implemented and upstream-stub tested, but no live Azure validation is claimed. Set the flag only after its resource-specific verification criteria pass, not merely to bypass the runtime gate.

## Publish the frontend

1. Set repository variable `VITE_API_BASE_URL` to the verified HTTPS API **origin**.
2. Optional `VITE_BASE_PATH` overrides the Pages base:
   - Project site: `/REPOSITORY/` (workflow default).
   - `OWNER.github.io` repository: `/` (detected automatically).
   - Custom domain serving the site root: explicitly `/`.
3. Dispatch **Publish frontend to Pages**. It checks types/tests and builds `@car/web`, then publishes `apps/web/dist`.
4. Add the actual Pages/custom-domain **origin** to backend `ALLOWED_ORIGINS`. A project path is not part of an origin. Rebuild frontend when public `VITE_*` configuration changes.
5. Test the project URL, refresh, asset paths, registration and HTTPS API access in the deployed browser. Pages is static: there is no server-side fallback routing or secret storage.

Every `VITE_*` value is public build output. No API keys, client secrets, Cosmos keys or server signing secrets belong there.

## Docker and deployment validation

The multi-stage Dockerfile installs the locked workspaces, builds `@car/api` with esbuild and an explicit alias that bundles raw TypeScript contracts, then runs `npm prune --omit=dev`. The final image contains root and API-local runtime dependencies, API `dist/index.js` and the contracts workspace needed by workspace links, and runs as non-root. It does not rely on Node's version-specific raw TypeScript loader; `npm prune` itself does not compile TypeScript.

The `.dockerignore` excludes environment files, local modules, tests, generated artifacts and repository metadata. No media content is included. ACR Tasks builds the image in the manual workflow, so a local Docker daemon is not required.

Validate a release's real image entrypoint, health check, Cosmos identity access and graceful termination before promoting it. Local Node builds are not a substitute for that container smoke test. This implementation does not claim the image or cloud deployment was tested where those tools/resources are absent.

## Rollback and cleanup

Keep the previous image digest and compatible Bicep/config version. For rollback, apply the reviewed template with that prior `apiImage`; do not roll back only the image across incompatible contracts/data shapes. End active sessions before a planned release; revision overlap can temporarily exceed one process.

Foundation deployment uses ARM incremental mode; `deployApi=false` does **not delete** an existing API. To stop a deployed API, use the operator's explicit Container Apps stop/update procedure and verify paid upstreams are closed. To remove the entire dedicated environment, obtain approval, export only permitted data, honor deletion/retention obligations, then delete the dedicated resource group through an authorized operator. Key Vault purge protection intentionally prevents immediate permanent purge.
