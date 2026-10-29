/**
 * Security tests — configuration: secrets in errors, webhook fail-closed,
 * ADMIN_IDS integrity.
 *
 * Test-ID map ↔ docs/risk-register.md security section (R48+):
 *   SEC-9  → R55 (secret leakage): invalid-env errors never echo BOT_TOKEN / DATABASE_URL
 *   SEC-11 → R56 (webhook secret): MODE=webhook without WEBHOOK_URL / WEBHOOK_SECRET must not boot
 *   SEC-12 → R57 (env parsing): malformed ADMIN_IDS fails closed, never a wrong
 *            admin set; per D80 "1,,2" parses to [1, 2] (empty entries ignored)
 *
 * Contract under test (docs/plan.md §7.1): `src/config.ts` —
 *   loadConfig(env: Record<string, string | undefined>): AppConfig
 * Zod-validated, throws on invalid env.
 *
 * RED note: `src/config.ts` does not exist until T7. The contract module is
 * imported dynamically so every test fails individually with "module missing"
 * (the expected RED state). `@ts-ignore` keeps `npm run typecheck` clean while
 * the module is absent; the typings come back automatically once it exists.
 */
import { describe, expect, test } from "vitest";

/** Secret values that must never surface in errors, logs or bot replies. */
const BOT_TOKEN = "123456:TEST-TOKEN";
const DATABASE_URL = "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads";
const SECRET_MARKERS = [BOT_TOKEN, "TEST-TOKEN", "sup3r-secret-pw", "threads_app@db.internal"];

type LoadConfig = (env: Record<string, string | undefined>) => any;

async function loadConfigOf(): Promise<LoadConfig> {
  // @ts-ignore src/config.ts does not exist until T7 (plan §7.1) — expected RED state.
  const mod = await import("../../src/config");
  return mod.loadConfig as LoadConfig;
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { BOT_TOKEN, DATABASE_URL, ADMIN_IDS: "900001", MODE: "polling", ...overrides };
}

/** Invalid env must throw a controlled error that echoes no secret material. */
function expectFailClosed(loadConfig: LoadConfig, env: Record<string, string | undefined>, label: string): void {
  let error: unknown;
  try {
    loadConfig(env);
  } catch (e) {
    error = e;
  }
  expect(error, `${label}: loadConfig must throw (fail closed)`).toBeDefined();
  const text = `${String(error)} ${JSON.stringify(error ?? {})}`;
  for (const secret of SECRET_MARKERS) {
    expect(text, `${label}: error output must not contain '${secret}'`).not.toContain(secret);
  }
}

describe("SEC-9 (R55): configuration errors never echo secret values", () => {
  test("missing BOT_TOKEN / bad MODE / bad DATABASE_URL errors carry no secret material", async () => {
    const loadConfig = await loadConfigOf();
    const cases: Array<[Record<string, string | undefined>, string]> = [
      [baseEnv({ BOT_TOKEN: undefined }), "missing BOT_TOKEN"],
      [baseEnv({ MODE: "nonsense" }), "invalid MODE"],
      [baseEnv({ DATABASE_URL: "definitely-not-a-url" }), "invalid DATABASE_URL"],
      [baseEnv({ ADMIN_IDS: "abc" }), "invalid ADMIN_IDS"],
    ];
    for (const [env, label] of cases) {
      expectFailClosed(loadConfig, env, label);
    }
  });
});

describe("SEC-11 (R56): MODE=webhook fails closed without webhook URL and secret", () => {
  test("webhook without WEBHOOK_URL or WEBHOOK_SECRET is refused; both together boot", async () => {
    const loadConfig = await loadConfigOf();

    expectFailClosed(loadConfig, baseEnv({ MODE: "webhook" }), "webhook without WEBHOOK_URL");
    expectFailClosed(
      loadConfig,
      baseEnv({ MODE: "webhook", WEBHOOK_URL: "https://bot.example.com/hook" }),
      "webhook without WEBHOOK_SECRET",
    );
    expectFailClosed(
      loadConfig,
      baseEnv({ MODE: "webhook", WEBHOOK_URL: "https://bot.example.com/hook", WEBHOOK_SECRET: "" }),
      "webhook with empty WEBHOOK_SECRET",
    );

    const ok = loadConfig(
      baseEnv({ MODE: "webhook", WEBHOOK_URL: "https://bot.example.com/hook", WEBHOOK_SECRET: "hook-secret" }),
    );
    expect(ok.mode).toBe("webhook");
    expect(ok.webhookSecret).toBe("hook-secret");
  });

  test("polling mode boots without any WEBHOOK_* variables", async () => {
    const loadConfig = await loadConfigOf();
    const config = loadConfig(baseEnv({ MODE: "polling" }));
    expect(config.mode).toBe("polling");
  });
});

describe("SEC-12 (R57): malformed ADMIN_IDS fails closed, never a wrong admin set", () => {
  test("garbage ADMIN_IDS values are rejected, a valid value yields exactly that admin", async () => {
    const loadConfig = await loadConfigOf();

    // D80 (normative): entries are trimmed and empty entries are IGNORED, so
    // "1,,2" is accepted and yields exactly [1, 2] — not a widened admin set.
    // Security note: this tolerance has no security consequence — ADMIN_IDS
    // comes from the operator-controlled process environment (never from user
    // input), and the parsed set is still exactly {1, 2}.
    expect(loadConfig(baseEnv({ ADMIN_IDS: "1,,2" })).adminIds).toEqual([1, 2]);

    // D80 fail-closed: any non-numeric, empty or unsafe entry is rejected.
    for (const raw of ["abc", "1,abc", "", "   ", "NaN", "900001; DROP TABLE users", "99999999999999999999"]) {
      expectFailClosed(loadConfig, baseEnv({ ADMIN_IDS: raw }), `ADMIN_IDS=${JSON.stringify(raw)}`);
    }

    const config = loadConfig(baseEnv({ ADMIN_IDS: "900001" }));
    expect(Array.isArray(config.adminIds)).toBe(true);
    expect(config.adminIds).toEqual([900001]);
    for (const id of config.adminIds) {
      expect(Number.isSafeInteger(id) && id > 0).toBe(true);
    }
  });
});
