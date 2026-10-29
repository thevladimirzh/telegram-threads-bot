/**
 * Security tests — fuzzing untrusted Telegram updates.
 *
 * Test-ID map ↔ docs/risk-register.md security section (R48+):
 *   SEC-15 → R51/R53 (forged updates, DoS): for ANY JSON-shaped update the bot
 *            never throws, never performs destructive API calls and never logs
 *            secret material ("never crashes, never leaks, never deletes").
 *
 * Contract under test (docs/plan.md §7): `src/bot/createBot.ts` —
 *   createBot(deps: { store; now; logger; config }): Bot
 * Telegram updates are untrusted input (threat model: trust boundary
 * "Telegram updates -> bot"); grammY rethrows handler errors unless the bot
 * installs an error handler, so "never throws" is a real requirement.
 *
 * RED note: the contract modules do not exist until T7. They are imported
 * dynamically so the test fails with "module missing" (the expected RED state);
 * `@ts-ignore` keeps `npm run typecheck` clean until then.
 */
import fc from "fast-check";
import { expect, test } from "vitest";
import { FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN } from "../helpers/fake-bot-api";

const ENV: Record<string, string> = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads",
  ADMIN_IDS: "900001",
  MODE: "polling",
};

const SECRET_MARKERS = [TEST_BOT_TOKEN, "TEST-TOKEN", "sup3r-secret-pw", "threads_app@db.internal"];

type Update = any;

function makeLogger(records: Array<{ level: string; args: unknown[] }>): any {
  const rec =
    (level: string) =>
    (...args: unknown[]): void => {
      records.push({ level, args });
    };
  const logger: any = {
    level: "debug",
    silent: (): void => {},
    fatal: rec("fatal"),
    error: rec("error"),
    warn: rec("warn"),
    info: rec("info"),
    debug: rec("debug"),
    trace: rec("trace"),
  };
  logger.child = (): any => logger;
  return logger;
}

function deepText(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

async function bootBot(): Promise<{
  bot: any;
  api: FakeBotApi;
  logRecords: Array<{ level: string; args: unknown[] }>;
}> {
  // @ts-ignore src/config.ts does not exist until T7 (plan §7.1) — expected RED state.
  const { loadConfig } = await import("../../src/config");
  // @ts-ignore src/store/in-memory.ts does not exist until T7 (plan §7.2) — expected RED state.
  const { InMemoryStore } = await import("../../src/store/in-memory");
  // @ts-ignore src/bot/createBot.ts does not exist until T7 (plan §7.3) — expected RED state.
  const { createBot } = await import("../../src/bot/createBot");

  const config = loadConfig(ENV);
  const logRecords: Array<{ level: string; args: unknown[] }> = [];
  const bot = createBot({
    store: new InMemoryStore(),
    now: () => new Date(FIXED_DATE * 1000),
    logger: makeLogger(logRecords),
    config,
  } as any);
  const api = new FakeBotApi();
  bot.api.config.use(api.transformer);
  await bot.init();
  return { bot, api, logRecords };
}

/**
 * Arbitrary JSON-shaped updates with an update_id: the exact shape of a forged
 * or malformed update is attacker-controlled, so anything expressible in JSON
 * is in scope.
 */
const genUpdate = fc
  .record({ update_id: fc.integer(), extra: fc.jsonValue() })
  .map(({ update_id, extra }): Update => {
    const body = extra !== null && typeof extra === "object" && !Array.isArray(extra) ? extra : { payload: extra };
    return { update_id, ...body };
  });

test("SEC-15 (R51/R53): fuzz — any update: no crash, no destructive call, no secret in logs", async () => {
  await fc.assert(
    fc.asyncProperty(genUpdate, async (update: Update) => {
      const { bot, api, logRecords } = await bootBot();
      await bot.handleUpdate(update); // must settle without throwing

      const destructive = api.calls.filter((c) => /^(delete|copy|forward)/.test(c.method));
      expect(destructive, `garbage update caused destructive calls: ${deepText(update).slice(0, 300)}`).toEqual([]);

      const logs = deepText(logRecords);
      for (const marker of SECRET_MARKERS) {
        expect(logs.includes(marker), `logs leak '${marker}' on garbage input`).toBe(false);
      }
    }),
    { seed: 20261028, numRuns: 100, endOnFailure: true },
  );
});
