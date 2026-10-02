import { describe, expect, it } from "vitest";
import { locales, registrationSchema } from "@car/contracts";
import { dictionaries, initialLocale } from "./i18n";
import { errorMessage, formatSeconds, readVideos, safeVideo, validCoordinates } from "./utils";
import { ApiError } from "./api";

describe("all five UI dictionaries", () => {
  it("maps browser languages with English as the default", () => {
    expect(initialLocale("en-GB")).toBe("en-US");
    expect(initialLocale("fr-FR")).toBe("en-US");
    expect(initialLocale("")).toBe("en-US");
    expect(initialLocale("zh-TW")).toBe("zh-CN");
    expect(initialLocale("ja")).toBe("ja-JP");
    expect(initialLocale("ko-KR")).toBe("ko-KR");
    expect(initialLocale("de-AT")).toBe("de-DE");
  });
  for (const locale of locales) {
    it(`${locale} has every label and localized examples`, () => {
      expect(Object.keys(dictionaries[locale]).sort()).toEqual(Object.keys(dictionaries["en-US"]).sort());
      for (const value of Object.values(dictionaries[locale])) expect(value.length).toBeGreaterThan(0);
      expect(dictionaries[locale].examples).toHaveLength(3);
      if (locale !== "en-US") expect(dictionaries[locale].required).not.toBe(dictionaries["en-US"].required);
    });
  }
});
describe("media trust boundary", () => {
  it("reconstructs trusted URLs from validated IDs", () => {
    expect(safeVideo({ title: "A", platform: "youtube", videoId: "dQw4w9WgXcQ", url: "javascript:alert(1)" })?.url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(safeVideo({ title: "B", platform: "bilibili", videoId: "BV1xx411c7mD" })?.url).toBe("https://www.bilibili.com/video/BV1xx411c7mD");
  });
  it("rejects malformed providers and identifiers", () => {
    expect(safeVideo({ title: "A", platform: "youtube", videoId: "../evil" })).toBeNull();
    expect(safeVideo({ title: "A", platform: "unknown", videoId: "dQw4w9WgXcQ" })).toBeNull();
    expect(readVideos({ videos: [null, { title: "A", platform: "youtube", videoId: "dQw4w9WgXcQ" }] })).toHaveLength(1);
  });
});
describe("utility validation", () => {
  it("rejects invalid coordinates rather than fabricating a route", () => {
    expect(validCoordinates(90, -180)).toBe(true);
    expect(validCoordinates(91, 0)).toBe(false);
    expect(validCoordinates(NaN, 0)).toBe(false);
    expect(validCoordinates(0, Infinity)).toBe(false);
  });
  it("formats observed durations", () => { expect(formatSeconds(65)).toBe("1:05"); expect(formatSeconds(0)).toBe("0:00"); });
  it("localizes HTTP errors without surfacing raw server text", () => {
    expect(errorMessage(new ApiError("secret-server-detail", 401), dictionaries["de-DE"])).toBe(dictionaries["de-DE"].unauthorized);
    expect(errorMessage(new ApiError("quota", 429), dictionaries["ko-KR"])).toBe(dictionaries["ko-KR"].quotaError);
    for (const locale of locales) {
      expect(errorMessage(new ApiError("spotify-policy", 403), dictionaries[locale])).toBe(dictionaries[locale].spotifyPolicy);
      expect(errorMessage(new ApiError("spotify-policy-restricted", 403), dictionaries[locale])).toBe(dictionaries[locale].spotifyPolicy);
      expect(dictionaries[locale].spotifyPolicy).toContain("III.3");
      expect(dictionaries[locale].spotifyPolicy).toContain("III.5");
      expect(dictionaries[locale].spotifyPolicy).toContain("III.7");
    }
  });
  it("requires privacy independently of optional marketing consent", () => {
    const registration = { name: "Demo", company: "Example", email: "demo@example.test", scenario: "Cockpit demo", locale: "en-US", privacyConsent: true, marketingConsent: false };
    expect(registrationSchema.safeParse(registration).success).toBe(true);
    expect(registrationSchema.safeParse({ ...registration, privacyConsent: false }).success).toBe(false);
  });
});
