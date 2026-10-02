import { describe, expect, it } from "vitest";
import { actionSchema, clientEventSchema, locales, registrationSchema } from "./index";

const registration = {
  name: "Demo Visitor",
  company: "Example",
  email: "visitor@example.test",
  scenario: "Vehicle assistant evaluation",
  privacyConsent: true,
  marketingConsent: false,
  locale: "en-US"
};

describe("registration contract", () => {
  it.each(locales)("accepts %s without requiring marketing consent", (locale) => {
    expect(registrationSchema.parse({ ...registration, locale }).marketingConsent).toBe(false);
  });
  it("requires informed privacy consent", () => {
    expect(registrationSchema.safeParse({ ...registration, privacyConsent: false }).success).toBe(false);
  });
  it("rejects honeypot input and injected fields", () => {
    expect(registrationSchema.safeParse({ ...registration, website: "bot" }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...registration, role: "admin" }).success).toBe(false);
  });
  it("bounds free text and validates email", () => {
    expect(registrationSchema.safeParse({ ...registration, scenario: "x".repeat(1001) }).success).toBe(false);
    expect(registrationSchema.safeParse({ ...registration, email: "not-an-email" }).success).toBe(false);
  });
});

describe("control contracts", () => {
  it("allows only enumerated tools and valid call identifiers", () => {
    expect(actionSchema.safeParse({ callId: "bad", name: "work.sendMail", args: {} }).success).toBe(false);
    expect(actionSchema.safeParse({ callId: crypto.randomUUID(), name: "run.shell", args: {} }).success).toBe(false);
  });
  it("does not accept arbitrary top-level socket commands", () => {
    expect(clientEventSchema.safeParse({ type: "admin", token: "anything" }).success).toBe(false);
    expect(clientEventSchema.safeParse({ type: "metrics", latencyMs: -1 }).success).toBe(false);
  });
});
