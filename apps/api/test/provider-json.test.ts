import { describe, expect, it, vi } from "vitest";
import { readProviderJson } from "../src/provider-json.js";

describe("bounded provider JSON", () => {
  it("reads valid JSON and rejects malformed or absent bodies", async () => {
    await expect(readProviderJson(new Response('{"ok":true}'))).resolves.toEqual({ ok: true });
    await expect(readProviderJson(new Response("invalid"))).rejects.toMatchObject({ code: "invalid-provider-response" });
    await expect(readProviderJson(new Response(null))).rejects.toMatchObject({ code: "invalid-provider-response" });
  });
  it("cancels an oversized response before buffering it", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(12)); }, cancel });
    await expect(readProviderJson(new Response(body), 10)).rejects.toMatchObject({ code: "invalid-provider-response" });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("rejects an excessive declared size without consuming the stream", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(readProviderJson(new Response(body, { headers: { "content-length": "100" } }), 10)).rejects.toMatchObject({ code: "invalid-provider-response" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
