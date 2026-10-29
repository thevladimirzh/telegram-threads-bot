/**
 * Smoke test for the Lingui i18n setup (bootstrap T1, devops-sre).
 *
 * NOTE: intended location is tests/unit/, which is write-protected for the
 * devops-sre role; kept here (tests/helpers/) until the owner re-homes it.
 * Proves that runtime catalogs work inside Vitest without Babel/macro plugins.
 */
import { describe, expect, it } from "vitest";
import { createI18n, defaultLocale, locales } from "../../src/i18n/index.js";

describe("i18n setup", () => {
  it("exposes locales ru + en with default en", () => {
    expect(locales).toEqual(["en", "ru"]);
    expect(defaultLocale).toBe("en");
  });

  it("translates via runtime catalogs and switches locale", () => {
    const i18n = createI18n();

    expect(i18n.locale).toBe("en");
    expect(i18n._("app.name")).toBe("Threads bot");

    i18n.activate("ru");
    expect(i18n._("app.name")).toBe("Бот веток");
  });
});
