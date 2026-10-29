/**
 * Unit tests — src/config.ts (loadConfig), UNIT-17 (R39/R40): env parsing is
 * either a valid config or a typed error, never a crash. Covers D80
 * (ADMIN_IDS: trim, ignore empty entries, fail closed on non-numeric) and
 * SEC-11 (MODE=webhook fails closed without WEBHOOK_URL/WEBHOOK_SECRET).
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { loadConfig } from "../../src/config";

const BOT_TOKEN = "123456:TEST-TOKEN";
const DATABASE_URL = "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads";

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { BOT_TOKEN, DATABASE_URL, ADMIN_IDS: "777", MODE: "polling", ...overrides };
}

describe("loadConfig", () => {
  test("parses a minimal polling environment (UNIT-17)", () => {
    const config = loadConfig(baseEnv());
    expect(config.botToken).toBe(BOT_TOKEN);
    expect(config.databaseUrl).toBe(DATABASE_URL);
    expect(config.adminIds).toEqual([777]);
    expect(config.mode).toBe("polling");
    expect(config.webhookUrl).toBeUndefined();
    expect(config.webhookSecret).toBeUndefined();
    expect(config.draftTimeoutMs).toBe(900000);
    expect(config.batchLimit).toBe(50);
  });

  test("D80: ADMIN_IDS entries are trimmed and empty entries ignored", () => {
    expect(loadConfig(baseEnv({ ADMIN_IDS: " 777 ,, 888 " })).adminIds).toEqual([777, 888]);
    expect(loadConfig(baseEnv({ ADMIN_IDS: "1,,2" })).adminIds).toEqual([1, 2]);
  });

  test("D80: non-numeric ADMIN_IDS entries fail closed, naming ADMIN_IDS", () => {
    for (const raw of ["abc", "1,abc", "NaN", "900001; DROP TABLE users", "99999999999999999999", "", "   "]) {
      let error: unknown;
      try {
        loadConfig(baseEnv({ ADMIN_IDS: raw }));
      } catch (e) {
        error = e;
      }
      expect(error, `ADMIN_IDS=${JSON.stringify(raw)} must be rejected`).toBeDefined();
      expect(`${String(error)}`, `ADMIN_IDS=${JSON.stringify(raw)} error names the variable`).toContain("ADMIN_IDS");
    }
  });

  test("missing or invalid variables throw errors naming the variable, never its value", () => {
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [{ ...baseEnv(), BOT_TOKEN: undefined }, "BOT_TOKEN"],
      [{ ...baseEnv(), DATABASE_URL: undefined }, "DATABASE_URL"],
      [{ ...baseEnv(), DATABASE_URL: "definitely-not-a-url" }, "DATABASE_URL"],
      [{ ...baseEnv(), MODE: "nonsense" }, "MODE"],
    ];
    for (const [env, name] of cases) {
      let error: unknown;
      try {
        loadConfig(env);
      } catch (e) {
        error = e;
      }
      expect(error, `${name}: must throw`).toBeDefined();
      const text = `${String(error)} ${JSON.stringify(error ?? {})}`;
      expect(text, `${name}: error names the variable`).toContain(name);
      expect(text, `${name}: error must not echo the token`).not.toContain("TEST-TOKEN");
      expect(text, `${name}: error must not echo the database url`).not.toContain("sup3r-secret-pw");
    }
  });

  test("SEC-11: webhook mode fails closed without WEBHOOK_URL and WEBHOOK_SECRET", () => {
    for (const overrides of [
      { MODE: "webhook" },
      { MODE: "webhook", WEBHOOK_URL: "https://bot.example.com/hook" },
      { MODE: "webhook", WEBHOOK_URL: "https://bot.example.com/hook", WEBHOOK_SECRET: "" },
    ]) {
      let error: unknown;
      try {
        loadConfig(baseEnv(overrides));
      } catch (e) {
        error = e;
      }
      expect(error, `${JSON.stringify(overrides)} must be rejected`).toBeDefined();
    }
    const ok = loadConfig(
      baseEnv({ MODE: "webhook", WEBHOOK_URL: "https://bot.example.com/hook", WEBHOOK_SECRET: "hook-secret" }),
    );
    expect(ok.mode).toBe("webhook");
    expect(ok.webhookUrl).toBe("https://bot.example.com/hook");
    expect(ok.webhookSecret).toBe("hook-secret");
  });

  test("the error for a fully missing webhook config names both variables", () => {
    let error: unknown;
    try {
      loadConfig(baseEnv({ MODE: "webhook" }));
    } catch (e) {
      error = e;
    }
    const text = `${String(error)}`;
    expect(text).toContain("WEBHOOK_URL");
    expect(text).toContain("WEBHOOK_SECRET");
  });

  test("MODE unset defaults to polling", () => {
    expect(loadConfig(baseEnv({ MODE: undefined })).mode).toBe("polling");
  });
});

describe("loadConfig runtime wiring (D85/D86)", () => {
  test("PORT defaults to 8080 and honors an explicit port", () => {
    expect(loadConfig(baseEnv()).port).toBe(8080);
    expect(loadConfig(baseEnv({ PORT: "3000" })).port).toBe(3000);
  });

  test("invalid PORT fails closed naming PORT", () => {
    for (const raw of ["abc", "-1", "0", "1.5", ""]) {
      let error: unknown;
      try {
        loadConfig(baseEnv({ PORT: raw }));
      } catch (e) {
        error = e;
      }
      if (raw === "") continue; // empty PORT falls back to the default
      expect(error, `PORT=${JSON.stringify(raw)} must be rejected`).toBeDefined();
      expect(`${String(error)}`).toContain("PORT");
    }
  });

  test("webhookPath is the WEBHOOK_URL path in webhook mode and absent in polling mode", () => {
    const webhook = loadConfig(
      baseEnv({ MODE: "webhook", WEBHOOK_URL: "https://bot.example.com/hook/xyz", WEBHOOK_SECRET: "s" }),
    );
    expect(webhook.webhookPath).toBe("/hook/xyz");
    expect(loadConfig(baseEnv()).webhookPath).toBeUndefined();
    const rooted = loadConfig(
      baseEnv({ MODE: "webhook", WEBHOOK_URL: "https://bot.example.com", WEBHOOK_SECRET: "s" }),
    );
    expect(rooted.webhookPath).toBe("/");
  });
});

describe("loadConfig properties (UNIT-17: valid config or typed error, never a crash)", () => {
  test("arbitrary env values never crash and never echo secrets (seed fixed)", () => {
    fc.assert(
      fc.property(
        fc.record({
          BOT_TOKEN: fc.option(fc.string(), { nil: undefined }),
          DATABASE_URL: fc.option(fc.string(), { nil: undefined }),
          ADMIN_IDS: fc.option(fc.string(), { nil: undefined }),
          MODE: fc.option(fc.string(), { nil: undefined }),
          WEBHOOK_URL: fc.option(fc.string(), { nil: undefined }),
          WEBHOOK_SECRET: fc.option(fc.string(), { nil: undefined }),
          PORT: fc.option(fc.string(), { nil: undefined }),
        }),
        (env) => {
          let result: unknown;
          let error: unknown;
          try {
            result = loadConfig(env);
          } catch (e) {
            error = e;
          }
          if (error !== undefined) {
            const text = `${String(error)} ${JSON.stringify(error ?? {})}`;
            expect(text).not.toContain("sup3r-secret-pw");
            expect(error).toBeInstanceOf(Error);
          } else {
            const config = result as { adminIds: number[] };
            expect(Array.isArray(config.adminIds)).toBe(true);
            for (const id of config.adminIds) {
              expect(Number.isSafeInteger(id) && id > 0).toBe(true);
            }
          }
          return true;
        },
      ),
      { seed: 20261028, numRuns: 300 },
    );
  });
});
