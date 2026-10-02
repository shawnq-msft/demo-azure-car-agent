import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPublicClientApplication } from "@azure/msal-browser";
import { locales } from "@car/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminSession, filterParams, isAdminConfig, loadAdminConfig, validBillingRange, type AdminBillingReport } from "./admin";
import { Admin, adminLabels, AdminBilling, billingLabels } from "./components/Admin";

const config = { configured: true, tenantId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222", scope: "api://33333333-3333-4333-8333-333333333333/Leads.Manage" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function auth() {
  const account = { homeAccountId: "admin-account" };
  const client = {
    getActiveAccount: vi.fn().mockReturnValue(account),
    setActiveAccount: vi.fn(),
    loginPopup: vi.fn().mockResolvedValue({ account }),
    acquireTokenSilent: vi.fn().mockResolvedValue({ accessToken: "test-only-access-token" }),
    clearCache: vi.fn().mockResolvedValue(undefined),
    logoutPopup: vi.fn().mockResolvedValue(undefined)
  };
  return { client, session: new AdminSession(client as unknown as IPublicClientApplication, config.scope) };
}
describe("administrator browser boundary", () => {
  it("has localized fail-closed messages and renders no credential/token entry in all five languages", () => {
    for (const locale of locales) {
      const html = renderToStaticMarkup(createElement(Admin, { initialLanguage: locale }));
      expect(html).toContain(`lang="${locale}"`); expect(html).toContain(adminLabels[locale].title);
      expect(html).toContain(adminLabels[locale].loading);
      expect(html).not.toContain("<input"); expect(html).not.toContain("<textarea");
      expect(html).not.toContain(adminLabels[locale].login);
      expect(Object.keys(adminLabels[locale])).toEqual(Object.keys(adminLabels["en-US"]));
      expect(adminLabels[locale].unconfigured.length).toBeGreaterThan(40);
    }
  });
  it("rejects partial, malformed and unsafe public identity configuration", async () => {
    expect(isAdminConfig(config)).toBe(true);
    for (const value of [null, {}, { ...config, configured: false }, { ...config, tenantId: "common" },
      { ...config, clientId: "" }, { ...config, scope: "openid" }, { ...config, scope: "api://resource/.default" },
      { ...config, scope: "javascript:alert(1)" }]) expect(isAdminConfig(value)).toBe(false);
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ configured: false })));
    vi.stubGlobal("fetch", fetch);
    expect(await loadAdminConfig(new AbortController().signal)).toBeNull();
    expect(fetch.mock.calls[0]![1]).toMatchObject({ cache: "no-store", credentials: "omit" });
  });
  it("encodes filters without allowing query injection and omits empty fields", () => {
    const params = filterParams({ company: " Example & status=closed ", scenario: "", status: "new" });
    expect(params.get("company")).toBe("Example & status=closed"); expect(params.get("status")).toBe("new");
    expect(params.has("scenario")).toBe(false);
  });
  it("obtains tokens through MSAL silently and sends them only in authorization headers", async () => {
    const { session, client } = auth();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ leads: [], limit: 50, nextCursor: null })));
    vi.stubGlobal("fetch", fetch);
    await session.login();
    expect(client.loginPopup).toHaveBeenCalledWith({ scopes: [config.scope], prompt: "select_account" });
    const result = await session.page({ company: "", scenario: "", status: "" }, new AbortController().signal);
    expect(result.leads).toEqual([]);
    expect(client.acquireTokenSilent).toHaveBeenCalledWith({ account: { homeAccountId: "admin-account" }, scopes: [config.scope] });
    expect(fetch.mock.calls[0]![0]).not.toContain("test-only-access-token");
    expect(fetch.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: "Bearer test-only-access-token" }, credentials: "omit", cache: "no-store" });
  });
  it("clears local identity state even if provider logout fails", async () => {
    const { session, client } = auth();
    vi.stubGlobal("location", { origin: "https://demo.example", pathname: "/" });
    client.logoutPopup.mockRejectedValue(new Error("Popup closed"));
    await expect(session.logout()).rejects.toThrow("Popup closed");
    expect(client.setActiveAccount).toHaveBeenCalledWith(null);
    expect(client.clearCache).toHaveBeenCalledTimes(2);
    expect(client.logoutPopup.mock.calls[0]![0].postLogoutRedirectUri).toBe("https://demo.example/?admin-auth=1");
  });
  it("does not restore identity when an outstanding login completes after cleanup", async () => {
    const { session, client } = auth();
    let finish: ((value: { account: { homeAccountId: string } }) => void) | undefined;
    client.loginPopup.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const login = session.login();
    await session.clear();
    finish!({ account: { homeAccountId: "stale-user" } });
    await expect(login).rejects.toMatchObject({ status: 401 });
    expect(client.setActiveAccount.mock.calls).toEqual([[null]]);
  });
  it("fails closed when silent renewal fails and never calls the API", async () => {
    const { session, client } = auth(), fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    client.acquireTokenSilent.mockRejectedValue(new Error("Interaction required"));
    await expect(session.overview(new AbortController().signal)).rejects.toMatchObject({ status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts pending requests and clears renewed tokens after sign-out", async () => {
    const { session, client } = auth(), fetch = vi.fn(), controller = new AbortController();
    vi.stubGlobal("fetch", fetch);
    controller.abort();
    await expect(session.overview(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(client.clearCache).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it("posts follow-up updates without any mail-send field and treats forbidden responses as session failures", async () => {
    const { session } = auth(), fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(session.update("lead/id", "contacted", "Requested callback", new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    expect(fetch.mock.calls[0]![0]).toContain("/leads/lead%2Fid/follow-up");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ status: "contacted", notes: "Requested callback" });
  });
  it("renders disabled billing controls when unconfigured in all five languages", () => {
    const onLoad = vi.fn();
    for (const locale of locales) {
      const html = renderToStaticMarkup(createElement(AdminBilling, { locale, configured: false, busy: false, report: null, onLoad }));
      expect(html).toContain(billingLabels[locale].unconfigured);
      expect(html).toContain(billingLabels[locale].notice);
      expect(html).toMatch(/<button disabled="" type="submit">/);
      expect(html.match(/type="date" required="" disabled=""/g)).toHaveLength(2);
    }
    expect(onLoad).not.toHaveBeenCalled();
  });
  it("labels scope-level billing as provisional and separates currencies", () => {
    const report: AdminBillingReport = {
      source: "azure-cost-management", scope: "/subscriptions/example", from: "2026-01-01", to: "2026-01-02", fetchedAt: "2026-01-03T12:00:00Z",
      rows: [{ date: "2026-01-01", service: "Azure Maps", currency: "USD", cost: 1.25 }, { date: "2026-01-02", service: "Azure AI", currency: "EUR", cost: 3 }],
      totals: [{ currency: "USD", cost: 1.25 }, { currency: "EUR", cost: 3 }], finalInvoice: false
    };
    const html = renderToStaticMarkup(createElement(AdminBilling, { locale: "en-US", configured: true, busy: false, report, onLoad: vi.fn() }));
    expect(html).toContain("not per visitor or model and not a settled invoice");
    expect(html).toContain("/subscriptions/example");
    expect(html).toContain("Azure Maps"); expect(html).toContain("Azure AI");
    expect(html).toContain("USD: 1.25"); expect(html).toContain("EUR: 3.00");
  });
  it("validates inclusive billing dates and queries only on explicit demand", async () => {
    expect(validBillingRange("2026-01-01", "2026-01-31")).toBe(true);
    for (const [from, to] of [["2026-01-01", "2026-02-01"], ["2026-02-30", "2026-03-01"], ["2026-01-02", "2026-01-01"], ["2099-01-01", "2099-01-01"]]) {
      expect(validBillingRange(from!, to!)).toBe(false);
    }
    const { session } = auth(), fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    expect(fetch).not.toHaveBeenCalled();
    await expect(session.billing("2026-01-01", "2026-02-01", new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
    await session.billing("2026-01-01", "2026-01-31", new AbortController().signal);
    expect(fetch.mock.calls[0]![0]).toContain("/api/admin/billing?from=2026-01-01&to=2026-01-31");
  });
});
