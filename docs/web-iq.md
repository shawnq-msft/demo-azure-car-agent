# Web IQ: discovery and source-validated video search

## Verified sources

The [official Azure sample pinned at `5e1d5cec3467280bb85066fb218392bfb3735890`](https://github.com/Azure-Samples/azure-openai-responses-api-samples/blob/5e1d5cec3467280bb85066fb218392bfb3735890/python/responses-webiq-aoai-v1.py)
uses this Azure OpenAI Responses tool configuration:

```json
{
  "type": "mcp",
  "server_label": "WebIQ",
  "server_url": "https://api.microsoft.ai/v3/mcp",
  "require_approval": "never",
  "headers": { "x-apikey": "<Web IQ key>" }
}
```

The placeholder is not a real key. The sample reads `WEBIQ_API_KEY`; this
application deliberately uses **`WEB_IQ_API_KEY`** instead. The sample's
`require_approval: "never"` is evidence of its configuration, not a recommendation
to automatically invoke unknown tools. Search only invokes an explicit,
operator-reviewed read-only tool allowlist after separate deployment and price configuration.

Transport and discovery follow the official MCP **2025-06-18** specifications:
[Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
[initialization/version negotiation](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle),
[tools/list and tool schemas](https://modelcontextprotocol.io/specification/2025-06-18/server/tools),
and [opaque cursor pagination](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/pagination).

**Not verified:** actual Web IQ tool names, input/output schemas, search result
semantics, video-search support, URL/media suitability, pricing, billing units,
and quotas. No authenticated service call was made while implementing this layer.
Do not invent a `/search` endpoint or bind an unknown tool to video search.
The implemented search adapter instead uses the documented Azure Responses
remote-MCP integration; it remains disabled until access, tool review and prices
are configured.

## Responses-mediated video search

`apps/api/src/webiq-search.ts` calls the Azure Responses API with `store:false`,
the fixed Microsoft Web IQ MCP endpoint, a mandatory `allowed_tools` list and
approval exemption scoped only to those names. The request caps built-in tool
calls at two, disables parallel calls, bounds output tokens, and uses a 30-second
deadline and 1 MB response limit. It never falls back to a different search engine.

The model normalizes results into an application-owned JSON shape, not a claimed
Web IQ tool schema. A returned video must also occur in the output of a successful
Web IQ MCP call and pass the canonical YouTube/Bilibili URL parser. Model text,
annotations, tool arguments or tool definitions alone cannot authorize a URL.
Missing/malformed evidence and incomplete responses fail explicitly. Provenance
does not establish relevance, truth, platform availability or permission to embed.

Configure these backend-only variables:

- `WEB_IQ_API_KEY`: enabled Web IQ credential.
- `WEB_IQ_RESPONSES_ENDPOINT`, `WEB_IQ_RESPONSES_KEY`: Azure OpenAI resource and key.
- `WEB_IQ_RESPONSES_DEPLOYMENT=gpt-6.1-sol`: this deployment must be named exactly
  as shown and actually deploy the requested model; no implicit substitute.
- `WEB_IQ_READONLY_TOOLS_JSON`: nonempty JSON array of exact reviewed tool names.
- `WEB_IQ_SEARCH_VERIFIED=true`: operator attestation of access and read-only review.
- `WEB_IQ_SEARCH_RATE_CARD_JSON`: `version`, `source` (HTTPS), `effectiveAt` (UTC ISO),
  `inputText`, `outputText` (USD per million tokens), `mcpRequestUsd`,
  `reservationUsd` (maximum 2), `maxOutputTokens` (128–4096).

The gateway reserves estimated funds before a search, accounts for both Responses
tokens and MCP calls, and refunds only validated unused amounts. Cached input is
priced conservatively at the uncached rate. Missing/failed usage keeps the
reservation and marks the estimate unknown. Search reservations are separate from
voice-session reservations so their costs are not counted twice. MCP tool output
can expand billable model input beyond the original query; the reservation and
call limit are **not a hard provider billing cap**. Set verified conservative
prices/reservations and monitor real service quotas before public access.

These paths have offline tests, not an authenticated live-search acceptance run.

## In-memory API

```ts
import { discoverWebIq } from "./webiq.js";
const result = await discoverWebIq(key, fetch);
// { endpoint, protocolVersion, tools: [{ name, inputSchema, outputSchema? }] }
```

The fetch parameter is optional and supports offline transport tests. Never pass
an untrusted fetch implementation: it receives the key. The production default is
native fetch. This function does not persist or log schemas, keys, sessions,
provider instructions, or content. Treat returned schemas as untrusted data;
do not follow embedded URLs, execute instructions, or resolve remote `$ref`s.
An absent `outputSchema` means no output contract was advertised.
`WebIqDiscoveryError` exposes a fixed, sanitized `code` and message, without
provider payloads or error causes.

The client sends `initialize`, then `notifications/initialized`, then bounded
`tools/list` pages. It never sends `tools/call`, performs sampling/elicitation, or
contacts an endpoint supplied by the server. Pings receive empty results; other
server requests receive method-not-supported responses. It supports JSON and
streaming SSE (including chunked multiline data), negotiated versions
`2025-06-18` and `2025-03-26`, and validated visible-ASCII session IDs.
Every subsequent request includes the negotiated protocol and assigned session.
A 404 session expiry permits one fresh initialization; auth failures are not
retried. Connections are closed after discovery; no persistent listener,
resumption, legacy SSE endpoint discovery, or automatic tool invocation is used.

Limits: 10 seconds/request, 30 seconds/discovery, 1 MiB/response, 4 MiB total,
8 pages, 256 tools, 32 exchanges (including server-request replies), 4096-character
keys/cursors, 1024-character session IDs, and schema depth/node limits of 32/20,000
per schema. Redirects are disabled. Cursors are opaque JSON values, never URLs to
follow. Repeated cursors, duplicate names, unsupported protocol versions,
malformed responses, unexpected session changes, and oversized input fail closed.

## Explicit operator discovery

Use Node 22+ and the repository's existing `tsx` dependency, from the repository
root. Place `WEB_IQ_API_KEY` in the ignored `apps\api\.env` backend file (or the
process environment). `node:process.loadEnvFile` loads that fixed backend file;
existing process values take precedence. Do not put a real key into examples,
frontend environment files, shell arguments, logs, or source control.

```powershell
npm exec -- tsx scripts\discover-webiq.mjs
```

This performs discovery and prints only the tool count, without names or content.
It does not write an artifact unless explicitly requested:

```powershell
npm exec -- tsx scripts\discover-webiq.mjs --output C:\PrivateArtifacts\webiq-tools.json
```

Use an existing private directory **outside this repository** and a new filename.
Relative paths, repository-contained paths (including resolved parent symlinks),
and existing files are rejected. The CLI never prints the key, provider payload,
schemas, or output path. It writes only a projected schema artifact, removing
descriptions, titles, examples, defaults, comments and metadata, and redacting the
configured key even if reflected by the server. That removal also applies to
matching nested property names, so this sanitized review artifact is intentionally
not an executable or lossless contract. Other schema strings remain untrusted;
keep the artifact private and manually review it before any sharing.

Discovery sends the key only to the pinned Microsoft endpoint. Running this
command is an explicit operator network action, not an application startup step.
Discovery itself must not be assumed free: pricing remains unverified.

Offline validation:

```powershell
npm exec -- vitest run apps\api\test\webiq.test.ts
```
