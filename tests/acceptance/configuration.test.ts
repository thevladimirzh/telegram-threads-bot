/**
 * Acceptance tests — tests/features/configuration.feature (S10–S14).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S10 -> ACC-31 -> R40
 *   S11 -> ACC-31 -> R40
 *   S12 -> ACC-31 -> R40
 *   S13 -> ACC-31 -> R39
 *   S14 -> ACC-31 -> R39
 *
 * Entry point: `loadConfig(env)` from src/config.ts (docs/plan.md §7.1,
 * Zod-validated, throws on invalid env). S14 also boots `createBot` to show
 * that polling startup registers no webhook.
 *
 * NOTE (OQ-QA-1, resolved by D80): ADMIN_IDS entries are trimmed and empty
 * entries are ignored ("1,,2" -> [1,2], " 777 ,, 888 " -> [777, 888]) while
 * any non-numeric entry fails config load (fail-closed). S11/D57 stand as
 * written; the security test SEC-12 is aligned to D80 by `security-engineer`.
 */
import { describe, expect, test } from "vitest";
import { ENV_BASE, boot } from "./harness";

type LoadConfig = (env: Record<string, string | undefined>) => any;

async function loadConfigOf(): Promise<LoadConfig> {
  // @ts-ignore src/config.ts does not exist until T7 (plan §7.1) — expected RED state.
  const mod = await import("../../src/config");
  return mod.loadConfig as LoadConfig;
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { ...ENV_BASE, ...overrides };
}

describe("configuration.feature — startup configuration", () => {
  test("S10 A missing required environment variable fails startup with a typed error (configuration.feature)", async () => {
    const loadConfig = await loadConfigOf();
    let error: unknown;
    try {
      loadConfig(baseEnv({ BOT_TOKEN: undefined }));
    } catch (e) {
      error = e;
    }
    expect(error, "startup must fail with a typed configuration error").toBeDefined();
    const text = `${String(error)} ${JSON.stringify(error ?? {})}`;
    expect(text, "the error names the offending variable").toContain("BOT_TOKEN");
  });

  test("S11 ADMIN_IDS tolerates spaces and empty entries (configuration.feature)", async () => {
    const loadConfig = await loadConfigOf();
    const config = loadConfig(baseEnv({ ADMIN_IDS: " 777 ,, 888 " }));
    expect(config.adminIds).toContain(777);
    expect(config.adminIds).toContain(888);
    expect(config.adminIds).not.toContain(999);
  });

  test("S12 A non-numeric ADMIN_IDS entry fails startup with a typed error (configuration.feature)", async () => {
    const loadConfig = await loadConfigOf();
    let error: unknown;
    try {
      loadConfig(baseEnv({ ADMIN_IDS: "777, abc" }));
    } catch (e) {
      error = e;
    }
    expect(error, "startup must fail with a typed configuration error").toBeDefined();
    const text = `${String(error)} ${JSON.stringify(error ?? {})}`;
    expect(text, "the error names the offending variable").toContain("ADMIN_IDS");
  });

  test("S13 Webhook mode without webhook settings fails startup (configuration.feature)", async () => {
    const loadConfig = await loadConfigOf();
    let error: unknown;
    try {
      loadConfig(baseEnv({ MODE: "webhook", WEBHOOK_URL: undefined, WEBHOOK_SECRET: undefined }));
    } catch (e) {
      error = e;
    }
    expect(error, "webhook mode without settings must fail startup").toBeDefined();
    const text = `${String(error)} ${JSON.stringify(error ?? {})}`;
    expect(text, "the error explains WEBHOOK_URL is required").toContain("WEBHOOK_URL");
    expect(text, "the error explains WEBHOOK_SECRET is required").toContain("WEBHOOK_SECRET");
  });

  test("S14 Polling mode is the default and registers no webhook (configuration.feature)", async () => {
    const loadConfig = await loadConfigOf();
    const config = loadConfig(baseEnv({ MODE: undefined }));
    expect(config.mode, "MODE unset defaults to polling").toBe("polling");

    // "startup succeeds" — the bot boots and no setWebhook call is made.
    const ctx = await boot({ env: { MODE: undefined } });
    expect(ctx.bot, "the bot starts in polling mode").toBeDefined();
    expect(ctx.api.callsOf("setWebhook"), "polling startup must not register a webhook").toEqual([]);
  });
});
