import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  discoverWebIq, WEB_IQ_DISCOVERY_LIMITS as LIMITS, WEB_IQ_MCP_ENDPOINT, WebIqDiscoveryError,
} from "../src/webiq.js";

const key = "offline-test-key-not-a-credential";
const tool = { name: "advertised_tool", inputSchema: { type: "object", properties: { q: { type: "string" } } } };
const init = {
  protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
};
const json = (id: number, result: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json", ...headers },
  });
const ack = () => new Response(null, { status: 202 });
function queued(...responses: Response[]) {
  return vi.fn<typeof fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected request ${key}`);
    return response;
  });
}
function sequence(result: unknown = { tools: [tool] }) {
  return queued(json(1, init), ack(), json(2, result));
}
function sse(parts: string[], headers?: HeadersInit) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8", ...headers } });
}
afterEach(() => vi.useRealTimers());

describe("official Web IQ MCP discovery", () => {
  it("initializes with the official endpoint/header and returns only advertised schemas", async () => {
    const listed = { ...tool, outputSchema: { type: "object", properties: { x: { type: "number" } } }, description: key, _meta: { secret: key } };
    const fetcher = queued(json(1, init, { "mcp-session-id": "session-123" }), ack(), json(2, { tools: [listed] }));
    await expect(discoverWebIq(key, fetcher)).resolves.toEqual({
      endpoint: WEB_IQ_MCP_ENDPOINT, protocolVersion: "2025-06-18",
      tools: [{ name: tool.name, inputSchema: tool.inputSchema, outputSchema: listed.outputSchema }],
    });
    const calls = fetcher.mock.calls;
    expect(calls).toHaveLength(3);
    for (const [url, options] of calls) {
      expect(url).toBe("https://api.microsoft.ai/v3/mcp");
      expect(options).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
      const headers = new Headers(options?.headers);
      expect(headers.get("x-apikey")).toBe(key);
      expect(headers.get("accept")).toBe("application/json, text/event-stream");
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBeNull();
    }
    expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "car-agent-webiq-discovery", version: "1.0.0" } },
    });
    expect(new Headers(calls[0]![1]?.headers).get("mcp-session-id")).toBeNull();
    for (const [, options] of calls.slice(1)) {
      expect(new Headers(options?.headers).get("mcp-session-id")).toBe("session-123");
      expect(new Headers(options?.headers).get("mcp-protocol-version")).toBe("2025-06-18");
    }
    expect(JSON.parse(calls[1]![1]!.body as string)).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(JSON.parse(calls[2]![1]!.body as string)).toEqual({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  });

  it("negotiates the supported earlier protocol without inventing tool names", async () => {
    const fetcher = queued(json(1, { ...init, protocolVersion: "2025-03-26" }), ack(), json(2, { tools: [] }));
    await expect(discoverWebIq(key, fetcher)).resolves.toMatchObject({ protocolVersion: "2025-03-26", tools: [] });
    expect(new Headers(fetcher.mock.calls[2]![1]?.headers).get("MCP-Protocol-Version")).toBe("2025-03-26");
  });

  it.each([undefined, ""])("rejects a missing key before networking (%s)", async (missing) => {
    const fetcher = queued();
    await expect(discoverWebIq(missing, fetcher)).rejects.toMatchObject({ code: "missing-key" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([" ", "line\r\ninjection", "a".repeat(LIMITS.keyLength + 1), "nonascii-☃"])("bounds and validates credentials", async (invalid) => {
    const fetcher = queued();
    await expect(discoverWebIq(invalid, fetcher)).rejects.toMatchObject({ code: "invalid-key" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 403])("sanitizes auth failures (%i), without reading provider content or retrying", async (status) => {
    const cancel = vi.fn();
    const fetcher = queued(new Response(new ReadableStream({ cancel }), { status }));
    const error = await discoverWebIq(key, fetcher).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(WebIqDiscoveryError);
    expect(error).toMatchObject({ code: "authentication-failed", message: "Web IQ discovery failed (authentication-failed)." });
    expect(error).not.toHaveProperty("cause");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("sanitizes transport exceptions and JSON-RPC errors", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(`provider payload ${key}`));
    await expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ message: "Web IQ discovery failed (request-failed)." });
    const providerError = queued(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: key } }), { headers: { "content-type": "application/json" } }));
    await expect(discoverWebIq(key, providerError)).rejects.toMatchObject({ message: "Web IQ discovery failed (invalid-response)." });
  });

  it("supports chunked SSE, multiline data, CRLF, notifications and initialization over SSE", async () => {
    const fetcher = queued(
      sse([`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: init })}\r`, "\n\r", "\n"]),
      ack(),
      sse([
        ": keepalive\n\n",
        'data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n',
        "event: message\nda", 'ta: {"jsonrpc":"2.0",\r\n',
        `data: "id":2,"result":${JSON.stringify({ tools: [tool] })}}\r\n\r\n`,
      ]),
    );
    await expect(discoverWebIq(key, fetcher)).resolves.toMatchObject({ tools: [tool] });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns on an SSE response without waiting for the server to close its stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\n\n`));
      },
      cancel,
    });
    const fetcher = queued(json(1, init), ack(), new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    await expect(discoverWebIq(key, fetcher)).resolves.toMatchObject({ tools: [] });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("supports SSE with CR-only separators ending at EOF", async () => {
    const fetcher = queued(json(1, init), ack(), sse([`data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } })}\r\r`]));
    await expect(discoverWebIq(key, fetcher)).resolves.toMatchObject({ tools: [] });
  });

  it("answers pings and refuses server tool/sampling requests instead of executing them", async () => {
    const messages = [
      { jsonrpc: "2.0", id: "ping-1", method: "ping" },
      { jsonrpc: "2.0", id: "hostile-1", method: "tools/call", params: { name: "search", url: "https://evil.invalid" } },
      { jsonrpc: "2.0", id: "hostile-2", method: "sampling/createMessage", params: { messages: [{ content: key }] } },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ];
    const fetcher = queued(json(1, init), ack(), sse(messages.map((message) => `data: ${JSON.stringify(message)}\n\n`)), ack(), ack(), ack());
    await expect(discoverWebIq(key, fetcher)).resolves.toMatchObject({ tools: [] });
    const replies = fetcher.mock.calls.slice(3).map(([, options]) => JSON.parse(options!.body as string));
    expect(replies).toEqual([
      { jsonrpc: "2.0", id: "ping-1", result: {} },
      { jsonrpc: "2.0", id: "hostile-1", error: { code: -32601, message: "Method not supported" } },
      { jsonrpc: "2.0", id: "hostile-2", error: { code: -32601, message: "Method not supported" } },
    ]);
  });

  it("keeps URL-like pagination cursors opaque and contacts only the pinned endpoint", async () => {
    const cursor = "https://evil.invalid/steal?key=never";
    const fetcher = queued(json(1, init), ack(), json(2, { tools: [tool], nextCursor: cursor }), json(3, { tools: [] }));
    await expect(discoverWebIq(key, fetcher)).resolves.toMatchObject({ tools: [tool] });
    expect(JSON.parse(fetcher.mock.calls[3]![1]!.body as string).params).toEqual({ cursor });
    expect(fetcher.mock.calls.every(([url]) => url === WEB_IQ_MCP_ENDPOINT)).toBe(true);
  });

  it("rejects repeated pagination and enforces the page ceiling", async () => {
    const repeating = queued(json(1, init), ack(), json(2, { tools: [], nextCursor: "same" }), json(3, { tools: [], nextCursor: "same" }));
    await expect(discoverWebIq(key, repeating)).rejects.toMatchObject({ code: "limit-exceeded" });
    const fetcher = queued(json(1, init), ack(), ...Array.from({ length: LIMITS.pages }, (_, i) => json(i + 2, { tools: [], nextCursor: `cursor-${i}` })));
    await expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(fetcher).toHaveBeenCalledTimes(LIMITS.pages + 2);
  });

  it.each([null, "", 123, "x".repeat(LIMITS.cursorLength + 1)])("rejects malformed/oversized cursors", async (nextCursor) => {
    await expect(discoverWebIq(key, sequence({ tools: [], nextCursor }))).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it.each([302, 307, 308])("rejects hostile redirects without forwarding credentials (%i)", async (status) => {
    const fetcher = queued(new Response(null, { status, headers: { location: "https://evil.invalid" } }));
    await expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "redirect-rejected" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe("error");
  });

  it("rejects an injected transport that reports a different response URL", async () => {
    const response = json(1, init);
    Object.defineProperty(response, "url", { value: "https://evil.invalid" });
    await expect(discoverWebIq(key, queued(response))).rejects.toMatchObject({ code: "redirect-rejected" });
  });

  it.each(["contains space", "", "a".repeat(LIMITS.sessionLength + 1)])("rejects invalid session IDs", async (session) => {
    const fetcher = queued(json(1, init, { "mcp-session-id": session }));
    await expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "invalid-response" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects session changes and unsupported versions", async () => {
    await expect(discoverWebIq(key, queued(json(1, init, { "mcp-session-id": "first" }), new Response(null, { status: 202, headers: { "mcp-session-id": "different" } })))).rejects.toMatchObject({ code: "invalid-response" });
    await expect(discoverWebIq(key, queued(json(1, { ...init, protocolVersion: "unknown" })))).rejects.toMatchObject({ code: "unsupported-protocol" });
  });

  it("reinitializes once without an expired session header", async () => {
    const fetcher = queued(
      json(1, init, { "mcp-session-id": "expired" }), ack(), new Response(null, { status: 404 }),
      json(3, init, { "mcp-session-id": "fresh" }), ack(), json(4, { tools: [] }),
    );
    await expect(discoverWebIq(key, fetcher)).resolves.toMatchObject({ tools: [] });
    expect(new Headers(fetcher.mock.calls[3]![1]?.headers).get("mcp-session-id")).toBeNull();
    expect(new Headers(fetcher.mock.calls[5]![1]?.headers).get("mcp-session-id")).toBe("fresh");
  });

  it("does not loop on repeated expired sessions", async () => {
    const fetcher = queued(
      json(1, init, { "mcp-session-id": "expired" }), ack(), new Response(null, { status: 404 }),
      json(3, init, { "mcp-session-id": "expired" }), ack(), new Response(null, { status: 404 }),
    );
    await expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "session-expired" });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("bounds declared and streamed response sizes and cancels the body", async () => {
    const cancel = vi.fn();
    const declared = new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/json", "content-length": String(LIMITS.responseBytes + 1) },
    });
    await expect(discoverWebIq(key, queued(declared))).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(cancel).toHaveBeenCalledOnce();
    const streamed = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(LIMITS.responseBytes + 1)); }, cancel,
    }), { headers: { "content-type": "text/event-stream" } });
    await expect(discoverWebIq(key, queued(streamed))).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("bounds tools and schema nesting", async () => {
    await expect(discoverWebIq(key, sequence({ tools: Array.from({ length: LIMITS.tools + 1 }, (_, i) => ({ ...tool, name: `t-${i}` })) }))).rejects.toMatchObject({ code: "limit-exceeded" });
    let deep: Record<string, unknown> = {};
    for (let i = 0; i <= LIMITS.schemaDepth; i++) deep = { nested: deep };
    await expect(discoverWebIq(key, sequence({ tools: [{ name: "deep", inputSchema: { type: "object", ...deep } }] }))).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("bounds aggregate response bytes across pagination", async () => {
    const pages = Array.from({ length: LIMITS.pages }, (_, i) => json(i + 2, {
      tools: [], nextCursor: `page-${i}`, untrustedPadding: "x".repeat(900_000),
    }));
    const fetcher = queued(json(1, init), ack(), ...pages);
    await expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(fetcher.mock.calls.length).toBeLessThan(LIMITS.pages + 2);
  });

  it("bounds schema nodes as well as bytes", async () => {
    const inputSchema = { type: "object", enum: Array.from({ length: LIMITS.schemaNodes + 1 }, () => 0) };
    await expect(discoverWebIq(key, sequence({ tools: [{ name: "wide", inputSchema }] }))).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("bounds exchanges from hostile server requests", async () => {
    const requests = Array.from({ length: LIMITS.exchanges }, (_, i) =>
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: `ping-${i}`, method: "ping" })}\n\n`);
    const fetcher = queued(json(1, init), ack(), sse(requests), ...Array.from({ length: LIMITS.exchanges }, ack));
    await expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(fetcher).toHaveBeenCalledTimes(LIMITS.exchanges);
  });

  it.each([
    { tools: [tool, tool] },
    { tools: [{ name: "", inputSchema: { type: "object" } }] },
    { tools: [{ name: "invalid", inputSchema: [] }] },
    { tools: [{ ...tool, outputSchema: { type: "array" } }] },
    { tools: "not-an-array" },
  ])("rejects malformed tools and duplicate names", async (result) => {
    await expect(discoverWebIq(key, sequence(result))).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects malformed JSON, response IDs, unsupported content types, incomplete SSE and missing capabilities", async () => {
    const malformed = new Response("{not JSON", { headers: { "content-type": "application/json" } });
    const contentType = new Response("text", { headers: { "content-type": "text/plain" } });
    for (const response of [malformed, contentType, json(999, init), sse(['data: {"jsonrpc":"2.0"\n']), json(1, { ...init, capabilities: {} })]) {
      await expect(discoverWebIq(key, queued(response))).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("times out fetch implementations even if they ignore AbortSignal", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const assertion = expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(LIMITS.requestTimeoutMs);
    await assertion;
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  });

  it("times out and cancels an idle response stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetcher = queued(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/event-stream" } }));
    const assertion = expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(LIMITS.requestTimeoutMs);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds the complete discovery duration across individually timely requests", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      const message = JSON.parse(options!.body as string);
      if (message.method === "initialize") return json(message.id, init);
      if (message.method === "notifications/initialized") return ack();
      return json(message.id, { tools: [], nextCursor: `cursor-${message.id}` });
    });
    const assertion = expect(discoverWebIq(key, fetcher)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(LIMITS.discoveryTimeoutMs);
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});

describe("Web IQ operator CLI (offline subprocesses)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  function cli(args: string[], credential: string, mock = false, captureWrite = false) {
    const source = `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      import assert from "node:assert/strict";
      let writes = 0;
      if (${captureWrite}) {
        fs.writeFile = async (_path, body, options) => {
          writes++;
          const artifact = JSON.parse(body);
          assert.equal(artifact.tools[0].name, "provider-content-never-print");
          assert.equal(artifact.tools[0].inputSchema.description, undefined);
          assert.equal(artifact.tools[0].inputSchema.properties.value.const, "[REDACTED]");
          assert.equal(artifact.tools[0].inputSchema.examples, undefined);
          assert.equal(artifact.tools[0]._meta, undefined);
          assert.equal(body.includes(${JSON.stringify(key)}), false);
          assert.equal(options.flag, "wx");
          assert.equal(options.mode, 384);
        };
        syncBuiltinESMExports();
        process.on("beforeExit", () => { if (writes !== 1) process.exitCode = 2; });
      }
      process.argv = ["node", "discover-webiq.mjs", ...${JSON.stringify(args)}];
      globalThis.fetch = async (_url, options) => {
        if (!${mock}) throw new Error("NETWORK MUST NOT BE CALLED");
        const request = JSON.parse(options.body);
        if (request.method === "notifications/initialized") return new Response(null, {status:202});
        const result = request.method === "initialize" ? ${JSON.stringify(init)}
          : {tools:[{
            name:"provider-content-never-print", _meta:{credential:${JSON.stringify(key)}},
            inputSchema:{type:"object",description:"provider-content-never-print",
              examples:[${JSON.stringify(key)}],properties:{value:{const:${JSON.stringify(key)}}}}
          }]};
        return new Response(JSON.stringify({jsonrpc:"2.0",id:request.id,result}),{headers:{"content-type":"application/json"}});
      };
      await import("./scripts/discover-webiq.mjs");
    `;
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
      cwd: root, env: { ...process.env, WEB_IQ_API_KEY: credential }, encoding: "utf8", timeout: 10_000,
    });
  }

  it("uses the shared transport and prints only a count, without persisting by default", () => {
    const result = cli([], key, true);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Web IQ discovery completed: 1 tool schema(s). No artifact written.");
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(key);
    expect(result.stdout).not.toContain("provider-content-never-print");
  });

  it("fails safely for a missing key without exposing backend environment values", () => {
    const result = cli([], "");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Web IQ discovery failed (missing-key).");
  });

  it("sanitizes explicitly requested external artifacts with exclusive creation (filesystem write mocked)", () => {
    const external = fileURLToPath(new URL("../../../../webiq-offline-artifact.json", import.meta.url));
    const result = cli(["--output", external], key, true, true);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("Web IQ discovery completed: 1 tool schema(s). Sanitized artifact written.");
    expect(result.stderr).toBe("");
  });

  it.each([["--output", "relative.json"], ["--unexpected"], ["--output", fileURLToPath(new URL("../../../webiq-should-not-exist.json", import.meta.url))]])(
    "rejects invalid arguments and repository-contained output before discovery",
    (...args) => {
      const result = cli(args, key);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).toBe("Web IQ discovery failed. Check arguments, environment, and the new external output path.");
      expect(result.stderr).not.toContain(key);
    },
  );
});
