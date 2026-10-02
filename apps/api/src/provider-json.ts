import { ApiError } from "./security.js";

export async function readProviderJson(response: Response, limit = 4_000_000): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > limit) {
    await response.body?.cancel();
    throw new ApiError("invalid-provider-response", "Provider response exceeds size limit", 502);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError("invalid-provider-response", "Provider response missing", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError("invalid-provider-response", "Provider response exceeds size limit", 502);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new ApiError("invalid-provider-response", "Provider JSON response is invalid", 502);
  }
}
