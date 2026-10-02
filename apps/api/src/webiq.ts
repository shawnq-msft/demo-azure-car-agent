export const WEB_IQ_MCP_ENDPOINT = "https://api.microsoft.ai/v3/mcp";
const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_VERSIONS = new Set([PROTOCOL_VERSION, "2025-03-26"]);
export const WEB_IQ_DISCOVERY_LIMITS = Object.freeze({
  requestTimeoutMs: 10_000,
  discoveryTimeoutMs: 30_000,
  responseBytes: 1_048_576,
  totalBytes: 4_194_304,
  pages: 8,
  tools: 256,
  cursorLength: 4096,
  sessionLength: 1024,
  keyLength: 4096,
  schemaDepth: 32,
  schemaNodes: 20_000,
  exchanges: 32,
});

export type WebIqDiscoveryErrorCode =
  | "missing-key" | "invalid-key" | "authentication-failed" | "request-failed"
  | "invalid-response" | "unsupported-protocol" | "limit-exceeded" | "timeout"
  | "redirect-rejected" | "session-expired";

export class WebIqDiscoveryError extends Error {
  constructor(public readonly code: WebIqDiscoveryErrorCode) {
    super(`Web IQ discovery failed (${code}).`);
    this.name = "WebIqDiscoveryError";
  }
}

export interface WebIqToolSchema {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface WebIqDiscovery {
  endpoint: typeof WEB_IQ_MCP_ENDPOINT;
  protocolVersion: string;
  tools: WebIqToolSchema[];
}

function fail(code: WebIqDiscoveryErrorCode): never {
  throw new WebIqDiscoveryError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(text: string): unknown {
  try { return JSON.parse(text); } catch { return fail("invalid-response"); }
}

function schema(value: unknown): Record<string, unknown> {
  if (!record(value) || value.type !== "object") fail("invalid-response");
  let nodes = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++nodes > WEB_IQ_DISCOVERY_LIMITS.schemaNodes || depth > WEB_IQ_DISCOVERY_LIMITS.schemaDepth) {
      fail("limit-exceeded");
    }
    if (item !== null && typeof item === "object") {
      for (const child of Object.values(item)) inspect(child, depth + 1);
    }
  };
  inspect(value, 0);
  return value;
}

/** Read-only schema discovery. Returned schemas are untrusted data, never executable instructions. */
export async function discoverWebIq(
  key: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<WebIqDiscovery> {
  if (key === undefined || key === "") fail("missing-key");
  if (typeof key !== "string" || key.length > WEB_IQ_DISCOVERY_LIMITS.keyLength || !/^[\x21-\x7e]+$/.test(key)) {
    fail("invalid-key");
  }
  const credential = key;
  const deadline = Date.now() + WEB_IQ_DISCOVERY_LIMITS.discoveryTimeoutMs;
  let totalBytes = 0;
  let exchanges = 0;
  let session: string | undefined;
  let protocol: string | undefined;
  let nextId = 1;

  async function post(message: Record<string, unknown>, initializing = false): Promise<unknown> {
    if (++exchanges > WEB_IQ_DISCOVERY_LIMITS.exchanges) fail("limit-exceeded");
    const timeout = Math.min(WEB_IQ_DISCOVERY_LIMITS.requestTimeoutMs, deadline - Date.now());
    if (timeout <= 0) fail("timeout");
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    const work = async (): Promise<unknown> => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-apikey": credential,
      };
      if (session) headers["Mcp-Session-Id"] = session;
      if (protocol) headers["MCP-Protocol-Version"] = protocol;
      const response = await fetcher(WEB_IQ_MCP_ENDPOINT, {
        method: "POST", headers, body: JSON.stringify(message),
        redirect: "error", signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        fail("timeout");
      }
      reader = response.body?.getReader();
      if (response.redirected || (response.status >= 300 && response.status < 400)
        || (response.url !== "" && response.url !== WEB_IQ_MCP_ENDPOINT)) fail("redirect-rejected");
      if (response.status === 401 || response.status === 403) fail("authentication-failed");
      if (response.status === 404 && session) fail("session-expired");
      if (!response.ok) fail("request-failed");
      const receivedSession = response.headers.get("mcp-session-id");
      if (receivedSession !== null) {
        if (receivedSession.length > WEB_IQ_DISCOVERY_LIMITS.sessionLength || !/^[\x21-\x7e]+$/.test(receivedSession)) {
          fail("invalid-response");
        }
        if (!initializing && receivedSession !== session) fail("invalid-response");
        if (initializing) session = receivedSession;
      }
      const isRequest = Object.hasOwn(message, "id") && Object.hasOwn(message, "method");
      if (!isRequest) {
        if (response.status !== 202) fail("invalid-response");
        return undefined;
      }
      if (response.status !== 200 || !reader) fail("invalid-response");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > WEB_IQ_DISCOVERY_LIMITS.responseBytes)) {
        fail("limit-exceeded");
      }
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
      if (contentType !== "application/json" && contentType !== "text/event-stream") fail("invalid-response");
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let text = "";
      let data: string[] = [];
      let eventType = "";
      const consumeMessage = async (value: unknown): Promise<{ result: unknown } | undefined> => {
        if (!record(value) || value.jsonrpc !== "2.0") fail("invalid-response");
        if (typeof value.method === "string") {
          if (Object.hasOwn(value, "result") || Object.hasOwn(value, "error")) fail("invalid-response");
          if (Object.hasOwn(value, "id")) {
            if (typeof value.id !== "string" && typeof value.id !== "number") fail("invalid-response");
            if ((typeof value.id === "string" && value.id.length > 256)
              || (typeof value.id === "number" && !Number.isFinite(value.id))) fail("limit-exceeded");
            // No sampling, elicitation, roots, or tool calls are ever executed.
            await post(value.method === "ping"
              ? { jsonrpc: "2.0", id: value.id, result: {} }
              : { jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "Method not supported" } });
          }
          return undefined;
        }
        if (value.id !== message.id || Object.hasOwn(value, "error")
          || !Object.hasOwn(value, "result")) fail("invalid-response");
        return { result: value.result };
      };
      const consumeLine = async (line: string): Promise<{ result: unknown } | undefined> => {
        if (line === "") {
          const payload = data.join("\n");
          const type = eventType;
          data = [];
          eventType = "";
          if (payload && (type === "" || type === "message")) return consumeMessage(parse(payload));
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
        } else if (line === "data") {
          data.push("");
        } else if (line.startsWith("event:")) {
          eventType = line.slice(6).replace(/^ /, "");
        } else if (line === "event") {
          eventType = "";
        }
        return undefined;
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          text += decoder.decode();
          if (contentType === "application/json") {
            const result = await consumeMessage(parse(text));
            if (!result) fail("invalid-response");
            return result.result;
          }
          if (text.endsWith("\r")) {
            const result = await consumeLine(text.slice(0, -1));
            if (result) return result.result;
          }
          fail("invalid-response");
        }
        bytes += chunk.value.byteLength;
        totalBytes += chunk.value.byteLength;
        if (bytes > WEB_IQ_DISCOVERY_LIMITS.responseBytes || totalBytes > WEB_IQ_DISCOVERY_LIMITS.totalBytes) {
          fail("limit-exceeded");
        }
        text += decoder.decode(chunk.value, { stream: true });
        if (contentType === "text/event-stream") {
          while (true) {
            const match = /[\r\n]/.exec(text);
            if (!match || (match[0] === "\r" && match.index === text.length - 1)) break;
            const index = match.index;
            const line = text.slice(0, index);
            text = text.slice(index + (text.slice(index, index + 2) === "\r\n" ? 2 : 1));
            const result = await consumeLine(line);
            if (result) return result.result;
          }
        }
      }
    };
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            cancel();
            reject(new WebIqDiscoveryError("timeout"));
          }, timeout);
        }),
      ]);
    } catch (error) {
      if (error instanceof WebIqDiscoveryError) throw error;
      fail(controller.signal.aborted ? "timeout" : "request-failed");
    } finally {
      clearTimeout(timer);
      cancel();
      controller.abort();
    }
  }

  // One fresh initialization is allowed for an expired server session; never retry auth failures.
  for (let attempt = 0; attempt < 2; attempt++) {
    session = undefined;
    protocol = undefined;
    try {
      const initialized = await post({
        jsonrpc: "2.0", id: nextId++, method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "car-agent-webiq-discovery", version: "1.0.0" } },
      }, true);
      if (!record(initialized) || typeof initialized.protocolVersion !== "string") fail("invalid-response");
      if (!SUPPORTED_VERSIONS.has(initialized.protocolVersion)) fail("unsupported-protocol");
      if (!record(initialized.capabilities) || !record(initialized.capabilities.tools)
        || !record(initialized.serverInfo) || typeof initialized.serverInfo.name !== "string"
        || typeof initialized.serverInfo.version !== "string") fail("invalid-response");
      protocol = initialized.protocolVersion;
      await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      const tools: WebIqToolSchema[] = [];
      const names = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < WEB_IQ_DISCOVERY_LIMITS.pages; page++) {
        const result = await post({
          jsonrpc: "2.0", id: nextId++, method: "tools/list", params: cursor === undefined ? {} : { cursor },
        });
        if (!record(result) || !Array.isArray(result.tools)) fail("invalid-response");
        if (tools.length + result.tools.length > WEB_IQ_DISCOVERY_LIMITS.tools) fail("limit-exceeded");
        for (const tool of result.tools) {
          if (!record(tool) || typeof tool.name !== "string" || tool.name.length === 0 || tool.name.length > 256
            || /[\x00-\x1f\x7f]/.test(tool.name) || names.has(tool.name)) fail("invalid-response");
          names.add(tool.name);
          tools.push({
            name: tool.name, inputSchema: schema(tool.inputSchema),
            ...(tool.outputSchema === undefined ? {} : { outputSchema: schema(tool.outputSchema) }),
          });
        }
        if (result.nextCursor === undefined) return { endpoint: WEB_IQ_MCP_ENDPOINT, protocolVersion: protocol, tools };
        if (typeof result.nextCursor !== "string" || result.nextCursor.length === 0
          || result.nextCursor.length > WEB_IQ_DISCOVERY_LIMITS.cursorLength) fail("limit-exceeded");
        if (cursors.has(result.nextCursor)) fail("limit-exceeded");
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      fail("limit-exceeded");
    } catch (error) {
      if (error instanceof WebIqDiscoveryError && error.code === "session-expired" && attempt === 0) continue;
      throw error;
    }
  }
  return fail("session-expired");
}
