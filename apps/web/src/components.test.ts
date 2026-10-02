import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ConfirmationDialog } from "./components/ConfirmationDialog";
import { Registration } from "./components/Registration";
import { Metrics } from "./components/Metrics";
import { dictionaries } from "./i18n";

describe("stable frontend integration selectors", () => {
  it("renders partial native voice counts as unknown or lower bounds", () => {
    const html = renderToStaticMarkup(createElement(Metrics, {
      t: dictionaries["en-US"], capabilities: null, refresh: vi.fn(),
      usage: { seconds: 1, inputTokens: 5, outputTokens: 0, turns: 0, estimatedUsd: 0.01, currency: "USD", latencySamples: [], rateVersion: "test", externalCostsIncluded: false, tokenTurnCoverage: "partial" }
    }));
    expect(html).toContain("<strong>&gt;= 5</strong>");
    expect(html).toContain("does not report voice tokens");
    expect(html).toContain(`<strong>${dictionaries["en-US"].unknown}</strong>`);
  });
  it("renders exact confirm/cancel test IDs on their respective buttons", () => {
    const html = renderToStaticMarkup(createElement(ConfirmationDialog, {
      action: { callId: "b5c734ec-75dc-42e7-8c37-61d5d428c183", name: "work.reset", args: {} },
      t: dictionaries["en-US"], busy: false, onAnswer: vi.fn()
    }));
    expect(html).toMatch(/<button[^>]*data-testid="action-confirm"[^>]*>Confirm<\/button>/);
    expect(html).toMatch(/<button[^>]*data-testid="action-cancel"[^>]*>Cancel<\/button>/);
  });
  it("renders registration selectors without claiming active WebRTC", () => {
    const html = renderToStaticMarkup(createElement(Registration, {
      t: dictionaries["en-US"], locale: "en-US", setLocale: vi.fn(), onRegistered: vi.fn()
    }));
    for (const id of ["registration-form", "locale-select", "register-name", "register-company", "register-email", "register-scenario", "register-privacy", "register-marketing", "register-submit"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    expect(html).not.toContain(">WebRTC preview<");
  });
});
