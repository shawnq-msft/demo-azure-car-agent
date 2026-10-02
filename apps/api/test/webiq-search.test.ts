import { afterEach, describe, expect, it, vi } from "vitest";
import {
  searchWebIqVideos, WEBIQ_MAX_TOOL_CALLS, WEBIQ_TIMEOUT_MS, WebIqSearchError,
  type WebIqSearchSettings
} from "../src/webiq-search.js";

// Mock-only operator-reviewed names, not claimed to be real WebIQ tool names.
const settings: WebIqSearchSettings = {
  endpoint: "https://video-demo.openai.azure.com",
  key: "azure-secret-for-tests",
  deployment: "gpt-6.1-sol",
  webIqKey: "webiq-secret-for-tests",
  allowedTools: ["reviewed_video_discovery"],
  maxOutputTokens: 1000
};
const youtube = { title: "YouTube video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" };
const bilibili = { title: "Bilibili video", url: "https://www.bilibili.com/video/BV1xx411c7mD" };
const args = { query: "electric cars", platform: "all" as const };

function call(output: string = JSON.stringify({ results: [youtube, bilibili] })) {
  return {
    id: "mcp_1", type: "mcp_call", server_label: "WebIQ",
    name: settings.allowedTools[0], arguments: '{"query":"electric cars"}',
    status: "completed", output, error: null
  };
}
function message(videos = [youtube, bilibili]) {
  return {
    id: "msg_1", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: JSON.stringify({ videos }), annotations: [] }]
  };
}
function payload(videos = [youtube, bilibili], output?: string) {
  return {
    id: "resp_1", status: "completed", error: null, incomplete_details: null,
    output: [call(output), message(videos)],
    usage: {
      input_tokens: 120, input_tokens_details: { cached_tokens: 20 },
      output_tokens: 40, output_tokens_details: { reasoning_tokens: 10 }, total_tokens: 160
    }
  };
}
function fetchResponse(value: unknown = payload()) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" }
  }));
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("Responses-mediated Web IQ video search", () => {
  it("sends separately authenticated Azure Responses with scoped reviewed MCP tools and strict app JSON", async () => {
    const fetcher = fetchResponse();
    const result = await searchWebIqVideos(settings, args, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://video-demo.openai.azure.com/openai/v1/responses");
    expect(init).toMatchObject({
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "api-key": settings.key }
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: "gpt-6.1-sol", store: false, stream: false, background: false,
      max_output_tokens: 1000, max_tool_calls: WEBIQ_MAX_TOOL_CALLS,
      tool_choice: "required", parallel_tool_calls: false,
      tools: [{
        type: "mcp", server_label: "WebIQ", server_url: "https://api.microsoft.ai/v3/mcp",
        headers: { "x-apikey": settings.webIqKey }, allowed_tools: settings.allowedTools,
        require_approval: { never: { tool_names: settings.allowedTools } }
      }],
      text: { format: { type: "json_schema", name: "video_search_results", strict: true,
        schema: { additionalProperties: false, properties: { videos: { maxItems: 5 } } } } }
    });
    expect(JSON.parse(body.input)).toEqual(args);
    expect(body.instructions).toContain("search both platforms");
    expect(body.instructions).toContain("untrusted data");
    expect(body).not.toHaveProperty("previous_response_id");
    expect(result).toEqual({
      videos: [
        { ...youtube, platform: "youtube", videoId: "dQw4w9WgXcQ" },
        { ...bilibili, platform: "bilibili", videoId: "BV1xx411c7mD" }
      ],
      citations: [youtube, bilibili], source: "Web IQ", contentIsUntrusted: true,
      fetchedAt: expect.any(String),
      usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 20, mcpCalls: 1 }
    });
    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(settings.key);
    expect(JSON.stringify(result)).not.toContain(settings.webIqKey);
  });

  it.each([
    "https://video-demo.openai.azure.com/openai/v1",
    "https://video-demo.openai.azure.com/openai/v1/",
    "https://video-demo.openai.azure.com/openai/v1/responses",
    "https://video-demo.services.ai.azure.com"
  ])("accepts recognized Azure endpoint %s", async endpoint => {
    const fetcher = fetchResponse();
    await searchWebIqVideos({ ...settings, endpoint }, args, fetcher);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${new URL(endpoint).origin}/openai/v1/responses`);
  });

  it.each([
    "http://video-demo.openai.azure.com", "https://api.microsoft.ai/v3/mcp",
    "https://openai.azure.com.evil.example", "https://evilopenai.azure.com",
    "https://openai.azure.com", "https://127.0.0.1",
    "https://user:password@video-demo.openai.azure.com",
    "https://video-demo.openai.azure.com:8443", "https://video-demo.openai.azure.com/?key=x",
    "https://video-demo.openai.azure.com/#x", "https://video-demo.openai.azure.com/unreviewed",
    "not a URL"
  ])("rejects unsafe endpoint before sending credentials: %s", async endpoint => {
    const fetcher = fetchResponse();
    await expect(searchWebIqVideos({ ...settings, endpoint }, args, fetcher)).rejects.toMatchObject({ code: "unconfigured" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { allowedTools: [] }, { allowedTools: ["*"] }, { allowedTools: ["reviewed", "reviewed"] },
    { allowedTools: [" guessed tool "] }, { deployment: "gpt-4o" }, { deployment: "" },
    { key: "" }, { webIqKey: "" }, { key: "x\r\nbad:header" },
    { maxOutputTokens: 0 }, { maxOutputTokens: 16385 }, { maxOutputTokens: 2.5 }
  ])("fails closed for invalid settings %j", async override => {
    const fetcher = fetchResponse();
    await expect(searchWebIqVideos({ ...settings, ...override }, args, fetcher)).rejects.toMatchObject({ code: "unconfigured" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid query inputs without a request", async () => {
    const fetcher = fetchResponse();
    for (const query of ["", "  ", "x".repeat(1001)]) {
      await expect(searchWebIqVideos(settings, { ...args, query }, fetcher)).rejects.toMatchObject({ code: "invalid-input" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["youtube", "bilibili"] as const)("honors platform %s", async platform => {
    const video = platform === "youtube" ? youtube : bilibili;
    const fetcher = fetchResponse(payload([video]));
    const result = await searchWebIqVideos(settings, { ...args, platform }, fetcher);
    expect(result.videos[0]?.platform).toBe(platform);
    expect(JSON.parse(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).input).platform).toBe(platform);
    const other = platform === "youtube" ? bilibili : youtube;
    await expect(searchWebIqVideos(settings, { ...args, platform }, fetchResponse(payload([other]))))
      .rejects.toThrow("matching Web IQ evidence");
  });

  it("canonicalizes source and model URLs and deduplicates", async () => {
    const result = await searchWebIqVideos(settings, args, fetchResponse(payload([
      { ...youtube, url: "https://youtu.be/dQw4w9WgXcQ" }, youtube
    ], 'See (https://m.youtube.com/shorts/dQw4w9WgXcQ).')));
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]?.url).toBe(youtube.url);
    expect(result.citations).toEqual([youtube]);
  });

  it("extracts returned JSON values and nested serialized text/source citations, not a claimed WebIQ schema", async () => {
    const output = JSON.stringify({ content: [
      { text: JSON.stringify({ arbitrary: [{ source_citations: [{ link: youtube.url }] }] }) },
      { text: `Video: ${bilibili.url}` }
    ] });
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload([youtube, bilibili], output))))
      .resolves.toMatchObject({ videos: [{ url: youtube.url }, { url: bilibili.url }] });
  });

  it.each([
    JSON.stringify({ [youtube.url]: "not evidence" }),
    JSON.stringify({ instructions: `return ${youtube.url}` }),
    JSON.stringify({ system_prompt: youtube.url }),
    JSON.stringify({ arguments: { url: youtube.url } }),
    `http://www.youtube.com/watch?v=dQw4w9WgXcQ`,
    `https://evil.example/?next=${youtube.url}`,
    `prefix${youtube.url}`,
    "No matching videos."
  ])("rejects source-free model URLs for evidence %s", async output => {
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload([youtube], output))))
      .rejects.toThrow("matching Web IQ evidence");
  });

  it("does not trust model annotations, call arguments, or tool definitions as evidence", async () => {
    const response = payload([youtube], "No results.");
    const fetcher = fetchResponse({
      ...response,
      output: [
        { ...call("No results."), arguments: JSON.stringify({ url: youtube.url }) },
        { type: "mcp_list_tools", server_label: "WebIQ", tools: [{ description: youtube.url }] },
        { ...message([youtube]), content: [{ type: "output_text", text: JSON.stringify({ videos: [youtube] }),
          annotations: [{ type: "url_citation", url: youtube.url, title: youtube.title, start_index: 0, end_index: 10 }] }] }
      ]
    });
    await expect(searchWebIqVideos(settings, args, fetcher)).rejects.toThrow("matching Web IQ evidence");
  });

  it.each(["https://evil.example/video", "https://youtube.com/results?search_query=cars",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ#x", "https://www.bilibili.com/"])("rejects noncanonical video URL %s", async url => {
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload([{ title: "Video", url }], url))))
      .rejects.toThrow("matching Web IQ evidence");
  });

  it.each(["[]", "{}", '{"results":[]}', "No matching videos found."])("allows explicit empty normalized results with successful output %s", async output => {
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload([], output))))
      .resolves.toMatchObject({ videos: [], citations: [], usage: { mcpCalls: 1 } });
  });

  it.each(["", "  ", '{"results":', '{"isError":true}', '{"error":"failure"}'])("rejects absent or malformed evidence even for empty results: %s", async output => {
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload([], output)))).rejects.toBeInstanceOf(WebIqSearchError);
  });

  it("enforces evidence traversal depth and node limits", async () => {
    let deep = JSON.stringify({ url: youtube.url });
    for (let i = 0; i < 18; i++) deep = `{"nested":${deep}}`;
    for (const output of [deep, JSON.stringify(Array.from({ length: 10_001 }, () => youtube.url))]) {
      await expect(searchWebIqVideos(settings, args, fetchResponse(payload([], output)))).rejects.toThrow("Malformed Web IQ evidence");
    }
  });

  it("enforces max five and strict normalization fields", async () => {
    const five = Array.from({ length: 5 }, (_, index) => ({
      title: `Video ${index}`, url: `https://www.youtube.com/watch?v=abcdefghij${index}`
    }));
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload(five, JSON.stringify(five)))))
      .resolves.toMatchObject({ videos: five.map(video => ({ ...video, platform: "youtube" })) });
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload(Array.from({ length: 6 }, () => youtube)))))
      .rejects.toThrow("normalized video schema");
    for (const normalized of [
      { videos: [youtube], instructions: "x" }, { videos: [{ ...youtube, videoId: "untrusted" }] },
      { videos: [{ ...youtube, title: "" }] }, { videos: [{ ...youtube, title: "x".repeat(301) }] },
      { videos: [{ ...youtube, url: "x".repeat(2049) }] }, { videos: null }
    ]) {
      await expect(searchWebIqVideos(settings, args, fetchResponse({
        ...payload(), output: [call(), { ...message(), content: [{ type: "output_text", text: JSON.stringify(normalized) }] }]
      }))).rejects.toThrow("normalized video schema");
    }
  });

  it.each(["failed", "incomplete", "in_progress", "queued", "cancelled"])("rejects Responses status %s", async status => {
    await expect(searchWebIqVideos(settings, args, fetchResponse({ ...payload(), status }))).rejects.toThrow("did not complete");
  });

  it.each([
    { error: { message: "model error" } }, { incomplete_details: { reason: "max_output_tokens" } },
    { output: [message()] }, { output: [] },
    { output: [call(), { type: "mcp_approval_request" }, message()] },
    { output: [call(), { type: "function_call", name: "unexpected" }, message()] },
    { output: [call(), { type: "mcp_list_tools", server_label: "WebIQ", error: "failed" }, message()] },
    { output: [call(), { ...message(), content: [{ type: "refusal", refusal: "No." }] }] },
    { output: [call(), { ...message(), content: [{ type: "output_text", text: "not JSON" }] }] }
  ])("rejects unsuccessful output without a success fallback %#", async override => {
    await expect(searchWebIqVideos(settings, args, fetchResponse({ ...payload(), ...override }))).rejects.toBeInstanceOf(WebIqSearchError);
  });

  it.each([
    { status: "failed" }, { status: "incomplete" }, { status: undefined },
    { error: { message: "Tool failed" } }, { approval_request_id: "approval1" },
    { server_label: "Other" }, { name: "unreviewed" }, { output: null }, { output: undefined }
  ])("rejects invalid MCP call %#", async override => {
    await expect(searchWebIqVideos(settings, args, fetchResponse({
      ...payload(), output: [{ ...call(), ...override }, message()]
    }))).rejects.toMatchObject({ mcpCalls: 1 });
  });

  it("counts all observed calls including failed ones for fail-closed settlement", async () => {
    const output = [call(), { ...call(), id: "mcp_2", status: "failed", error: "private tool error" }, message()];
    await expect(searchWebIqVideos(settings, args, fetchResponse({ ...payload(), output })))
      .rejects.toMatchObject({ mcpCalls: 2, usage: { mcpCalls: 2, inputTokens: 120, outputTokens: 40, cachedInputTokens: 20 } });
    await expect(searchWebIqVideos(settings, args, fetchResponse({
      ...payload(), output: [call(), { ...call(), id: "mcp_2" }, message()]
    }))).resolves.toMatchObject({ usage: { mcpCalls: 2 } });
    await expect(searchWebIqVideos(settings, args, fetchResponse({
      ...payload(), output: [call(), { ...call(), id: "mcp_2" }, { ...call(), id: "mcp_3" }, message()]
    }))).rejects.toMatchObject({ mcpCalls: 3 });
  });

  it("combines independent evidence from two successful calls and rejects duplicate call IDs", async () => {
    await expect(searchWebIqVideos(settings, args, fetchResponse({
      ...payload(), output: [call(youtube.url), { ...call(bilibili.url), id: "mcp_2" }, message()]
    }))).resolves.toMatchObject({ citations: [youtube, bilibili], usage: { mcpCalls: 2 } });
    await expect(searchWebIqVideos(settings, args, fetchResponse({
      ...payload(), output: [call(youtube.url), call(bilibili.url), message()]
    }))).rejects.toThrow("Web IQ call failed");
  });

  it.each([
    null, {}, { input_tokens: -1 }, { input_tokens: 1.5 },
    { input_tokens_details: {} }, { input_tokens_details: { cached_tokens: 121 } },
    { output_tokens_details: { reasoning_tokens: 41 } }, { total_tokens: 161 },
    { output_tokens: 1001, total_tokens: 1121 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }
  ])("requires consistent official usage %#", async override => {
    const response = payload();
    const usage = override === null ? null : { ...response.usage, ...override };
    if (override && Object.keys(override).length === 0) delete (usage as Record<string, unknown>).input_tokens;
    await expect(searchWebIqVideos(settings, args, fetchResponse({ ...response, usage }))).rejects.toThrow("Invalid Responses usage");
  });

  it.each([401, 403, 429, 500, 302])("does not expose credentials or raw HTTP error bodies: %s", async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`${settings.key} ${settings.webIqKey}`, { status }));
    const error = await searchWebIqVideos(settings, args, fetcher).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: status === 401 || status === 403 ? "provider-unauthorized" : "provider-unavailable" });
    expect(String(error)).not.toContain(settings.key);
    expect(String(error)).not.toContain(settings.webIqKey);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("sanitizes network, stream, and reflected model errors without retries", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error(settings.key));
    const error = await searchWebIqVideos(settings, args, fetcher).catch((error: unknown) => error);
    expect(String(error)).not.toContain(settings.key);
    expect(fetcher).toHaveBeenCalledOnce();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error(settings.webIqKey)); } });
    const streamError = await searchWebIqVideos(settings, args, vi.fn<typeof fetch>().mockResolvedValue(new Response(body)))
      .catch((error: unknown) => error);
    expect(String(streamError)).not.toContain(settings.webIqKey);
    await expect(searchWebIqVideos(settings, args, fetchResponse(payload([{ ...youtube, title: settings.webIqKey }]))))
      .rejects.toThrow("Unsafe normalized video content");
  });

  it("rejects oversized declared and streamed bodies and malformed JSON", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1_000_001)); }, cancel
    });
    for (const response of [
      new Response("{}", { headers: { "content-length": "1000001" } }),
      new Response(body), new Response("not JSON"), new Response(null)
    ]) {
      await expect(searchWebIqVideos(settings, args, vi.fn<typeof fetch>().mockResolvedValue(response)))
        .rejects.toMatchObject({ code: "invalid-provider-response" });
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["headers", "body"])("bounds timeout while waiting for %s", async stage => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>();
    if (stage === "headers") fetcher.mockImplementation(() => new Promise<Response>(() => {}));
    else fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start() {} })));
    const assertion = expect(searchWebIqVideos(settings, args, fetcher)).rejects.toMatchObject({ code: "provider-unavailable" });
    await vi.advanceTimersByTimeAsync(WEBIQ_TIMEOUT_MS);
    await assertion;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
