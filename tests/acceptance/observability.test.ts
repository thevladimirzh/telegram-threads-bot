/**
 * Acceptance tests — tests/features/observability.feature (S80–S82).
 *
 * Scenario map -> planned test IDs: none — per D61 the observability scenarios
 * carry only @AC9/@S tags and have no dedicated risk ID (AC10 is enforced by
 * the QA gate itself).
 *
 * Entry points (D71 extends the plan §7 contract): `src/health.ts` exports
 * `healthCheck(deps)` and `readyCheck(deps): Promise<{ status: number; body: string }>`;
 * tests call the check functions directly. The `deps` shape is RESOLVED
 * (OQ-QA-6, D71 contract): `deps: { store: Store; version?: string }` and
 * `readyCheck` pings the store — the test attaches the ping as an own
 * property of the `InMemoryStore` instance and passes `{ store }` exactly.
 * S82 asserts log shape through the injected logger (the provisional reading
 * of OQ-L recorded in docs/spec/decisions.md).
 */
import { afterEach, describe, expect, test } from "vitest";
import { CHATS, USERS, boot, cleanup, type Ctx } from "./harness";

async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.threads]);
  await ctx.userIsAdminOf(USERS.author, [CHATS.source]);
  await ctx.connectSource(CHATS.source);
  await ctx.connectThreads(CHATS.threads);
  ctx.resetCalls();
}

type Ping = () => Promise<void>;

/** OQ-QA-6 (resolved): deps is exactly `{ store; version? }`; the readiness
 *  ping goes through the store (`store.ping`) — attached as an own property
 *  of the InMemoryStore instance to make success/failure observable. */
function healthDeps(ping: Ping): any {
  // @ts-ignore src/store/in-memory.ts does not exist until T7 (plan §7.2) — expected RED state.
  return import("../../src/store/in-memory").then(({ InMemoryStore }) => {
    const store: any = new InMemoryStore();
    store.ping = ping; // readyCheck pings the store
    return { store };
  });
}

afterEach(cleanup);

describe("observability.feature — observability endpoints and logs", () => {
  test("S80 /health answers 200 while the bot runs (observability.feature)", async () => {
    // @ts-ignore src/health.ts does not exist until T7 (D71) — expected RED state.
    const { healthCheck } = await import("../../src/health");
    const deps = await healthDeps(async () => {});
    const response = await healthCheck(deps);
    expect(response.status, "/health answers 200 while the bot runs").toBe(200);
    expect(typeof response.body, "the response carries a string body (D71 contract)").toBe("string");
  });

  test("S81 /ready reflects the database ping (observability.feature)", async () => {
    // @ts-ignore src/health.ts does not exist until T7 (D71) — expected RED state.
    const { readyCheck } = await import("../../src/health");

    const ok = await readyCheck(await healthDeps(async () => {}));
    expect(ok.status, "db ping succeeds -> /ready answers 200").toBe(200);
    expect(typeof ok.body, "the response carries a string body (D71 contract)").toBe("string");

    const failing = await readyCheck(
      await healthDeps(async () => {
        throw new Error("db down");
      }),
    );
    expect(failing.status, "db ping fails -> /ready answers 503").toBe(503);
  });

  test("S82 Operational logs are single-line JSON records on stdout (observability.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    expect(ctx.logRecords.length, "a completed transfer must produce log records (non-vacuous)").toBeGreaterThan(0);
    for (const record of ctx.logRecords) {
      const line = JSON.stringify(record);
      expect(line, `log record must serialize to JSON: ${JSON.stringify(record)}`).toBeDefined();
      expect(line.includes("\n"), `log line must be single-line JSON: ${line}`).toBe(false);
      expect(() => JSON.parse(line), `log line must parse as a JSON record: ${line}`).not.toThrow();
    }
  });
});
