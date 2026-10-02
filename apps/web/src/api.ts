import type { ActionRequest, ActionResult, Capabilities, DemoState, DiagnosticSnapshot, Registration, RegistrationResult, UsageSummary } from "@car/contracts";

const configuredBase = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001";
export const apiBase = configuredBase.replace(/\/+$/, "");
export class ApiError extends Error {
  constructor(public readonly code: string, public readonly status = 0) { super(code); }
}
async function request<T>(path: string, token?: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20000),
      credentials: "omit"
    });
  } catch { throw new ApiError("network"); }
  if (!response.ok) {
    let code = "unknown";
    try { const error = await response.json(); code = error.code ?? error.error?.code ?? "unknown"; } catch { /* HTTP status is authoritative. */ }
    throw new ApiError(code, response.status);
  }
  return response.json() as Promise<T>;
}
export const api = {
  capabilities: () => request<Capabilities>("/api/capabilities"),
  register: (registration: Registration) => request<RegistrationResult>("/api/register", undefined, registration),
  demo: (token: string) => request<DemoState>("/api/demo", token),
  usage: (token: string) => request<UsageSummary>("/api/usage", token),
  diagnostics: (token: string) => request<DiagnosticSnapshot>("/api/diagnostics", token),
  action: (token: string, action: ActionRequest) => request<ActionResult>("/api/actions", token, action)
};
export function socketUrl(): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/ws`;
  return url.toString();
}
