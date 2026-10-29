/**
 * Acceptance tests — tests/features/cleanup-and-announce.feature (S49–S63).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S49 -> ACC-8              -> R8, R62
 *   S50 -> ACC-1, ACC-2, ACC-33 -> R1, R2, R62, R63   (D89: announce BEFORE closing,
 *                                                     closing links to the announce)
 *   S51 -> ACC-2, ACC-18      -> R2, R22, R62
 *   S52 -> ACC-2, ACC-18, ACC-11 -> R2, R22, R11, R62
 *   S53 -> ACC-2, ACC-17      -> R2, R17, R62
 *   S54 -> ACC-17, ACC-2      -> R18, R2, R62
 *   S55 -> ACC-18             -> R24, R22, R62
 *   S56 -> ACC-18, ACC-5      -> R23, R5, R62
 *   S57 -> ACC-5              -> R5, R29, R62
 *   S58 -> ACC-5              -> R29, R62
 *   S59 -> ACC-28, ACC-11     -> R37, R11, R62
 *   S60 -> ACC-4, ACC-26      -> R4, R34, R62
 *   S61 -> ACC-13             -> R13, R35, R62
 *   S62 -> ACC-27, ACC-13     -> R13, R36, R62
 *   S63 -> ACC-4, ACC-5       -> R4, R5, R62
 *   S84 -> ACC-34             -> R63                (D89 fallback: the announce
 *                                                    cannot be sent -> the closing
 *                                                    names the plain chat title)
 *
 * Exact strings (decisions §3, en): announce
 * `Thread created "{title}": https://t.me/{chat_path}/{root_id}?thread={root_id}`
 * (root id 42 per the fixture convention, D81). Failure-report WORDING is not
 * pinned (D72/OQ-M) — the report assertions are semantic: a reply into the
 * created thread (D28) that names the failing originals. Per D74 (OQ-QA-8
 * resolved) the report additionally groups results by the classes
 * `deleted`, `not_found`, `forbidden`, `failed`, each with a count —
 * S56–S58 assert exactly that grouping.
 *
 * D87 (iteration 2): the closing message and the failure report are
 * thread-body messages — replies to the title message (root id 42);
 * `message_thread_id` is never used for thread assembly (the old acceptance of
 * `message_thread_id` in `inThread` was the reported bug and is superseded).
 * The announce keeps its forum-topic behaviour: `message_thread_id` only there
 * (D18/D69, unchanged — S61/S62 assert exactly that).
 *
 * D89 (iteration 3, R63): the announce is sent BEFORE the closing message so
 * its message id is known — the closing message links to that announce message
 * (`https://t.me/c/{internal_chat_id}/{announce_message_id}`, S50) — while the
 * thread display order is unchanged (the closing is still the last thread
 * message). When the announce cannot be sent, the closing message falls back
 * to the plain chat title without a link (S84). The announce's OWN link
 * (`https://t.me/{chat_path}/{root_id}?thread={root_id}`, S60/S63) is correct
 * and unchanged.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { RecordedCall } from "../helpers/fake-bot-api";
import { CHATS, USERS, announceCallIn, boot, cleanup, closingCallIn, leaksRawError, type Ctx, type ThreadPost } from "./harness";

async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.threads]);
  await ctx.userIsAdminOf(USERS.author, [CHATS.source]);
  await ctx.connectSource(CHATS.source);
  await ctx.connectThreads(CHATS.threads);
  ctx.resetCalls();
}

function closingIndex(ctx: Ctx): number {
  const idx = ctx.api.calls.findIndex(
    (c) => c.method === "sendMessage" && /moved from/.test(String(c.payload.text ?? "")),
  );
  expect(idx, "the closing message must be posted").toBeGreaterThanOrEqual(0);
  return idx;
}

/** The AC5/D54 report: a reply into the created thread after the closing. */
function reportCalls(ctx: Ctx): RecordedCall[] {
  return ctx.callsSince(closingIndex(ctx) + 1).filter(
    (c) => c.method === "sendMessage" && c.payload.chat_id === CHATS.threads.id,
  );
}

/** D87: every thread-body message is a reply to the title message (root id 42). */
function expectBodyRepliesToRoot(ctx: Ctx, body: ThreadPost[]): void {
  for (const p of body) {
    expect(
      ctx.replyToOf(p.call),
      `every thread-body message is sent as a reply to the root (title message, id 42) (D87): ${p.call.method}`,
    ).toBe(42);
  }
}

/** D28/D87: the report is a reply into the created thread (reply target = root 42). */
function expectReportInThread(ctx: Ctx, call: RecordedCall): void {
  expect(
    ctx.replyToOf(call),
    "the report is a reply into the created thread (D28/D87: reply target = the title message, id 42)",
  ).toBe(42);
}

/** D74 report classes (OQ-QA-8 resolved): fixed ASCII tokens, never localized. */
const REPORT_CLASSES = ["deleted", "not_found", "forbidden", "failed"] as const;

/**
 * D74 (OQ-QA-8): the report groups results by class, each with a count.
 * The wording/format is free (D72) — asserted format-free as: the line
 * carrying the class label pairs it with the expected count (label and
 * count within a short distance of each other, in either order).
 */
function expectClassCount(text: string, cls: string, count: number): void {
  const line = text.split("\n").find((l) => l.includes(cls));
  expect(line, `the report groups results by class '${cls}' (D74)`).toBeDefined();
  const paired = new RegExp(`(?:${cls}[^\\n]{0,24}\\b${count}\\b|\\b${count}\\b[^\\n]{0,24}${cls})`);
  expect(paired.test(line!), `the '${cls}' group carries the count ${count}: ${JSON.stringify(line)}`).toBe(true);
}

/** Every D74 class appears with its count (the report is grouped by all four). */
function expectReportCounts(text: string, counts: Record<(typeof REPORT_CLASSES)[number], number>): void {
  for (const cls of REPORT_CLASSES) expectClassCount(text, cls, counts[cls]);
}

const ANNOUNCE_42 = 'Thread created "Lunch": https://t.me/threads_chat/42?thread=42';

afterEach(cleanup);

describe("cleanup-and-announce.feature — cleanup of originals and the announce", () => {
  test("S49 The forwarded copies are deleted in the threads chat after the thread is posted (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    const fwdId = await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.deletedIds(CHATS.threads.id), "a delete call removes the forwarded message").toContain(fwdId);

    const closing = closingIndex(ctx);
    const firstDelete = ctx.api.calls.findIndex((c) => /^delete/.test(c.method) && c.payload.chat_id === CHATS.threads.id);
    expect(firstDelete, "the delete call is made after the closing message is posted").toBeGreaterThan(closing);
    // S49: "the closing message is a reply to the title message" (D87) — and
    // every other thread-body message with it.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S50 Originals are deleted only after the whole thread is posted (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    const closing = closingIndex(ctx);
    const firstSourceDelete = ctx.api.calls.findIndex(
      (c) => /^delete/.test(c.method) && c.payload.chat_id === CHATS.source.id,
    );
    expect(firstSourceDelete, "a source deletion must happen (non-vacuous)").toBeGreaterThanOrEqual(0);
    expect(
      firstSourceDelete,
      "the closing message of the thread is posted before the first deletion in the source chat",
    ).toBeGreaterThan(closing);
    // D89 (R63): the announce is sent BEFORE the closing message (its message
    // id feeds the closing link) and the closing message links to exactly that
    // announce message in the source chat.
    const announce = announceCallIn(ctx, CHATS.source.id);
    expect(announce, "the announce is posted in the source chat (D89)").toBeDefined();
    expect(
      ctx.api.calls.indexOf(announce!),
      "the closing message of the thread is posted after the announce in 'Source Chat' (D89)",
    ).toBeLessThan(closing);
    expect(
      String(ctx.api.calls[closing].payload.text ?? ""),
      `the closing message links to the announce message in 'Source Chat' (D89): ` +
        `'Lunch — moved from https://t.me/c/200000000000001/${ctx.messageIdOf(announce!)}'`,
    ).toBe(`Lunch — moved from https://t.me/c/200000000000001/${ctx.messageIdOf(announce!)}`);
    // S50: "the closing message is a reply to the title message" (D87) — and
    // every other thread-body message with it.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S51 An indexed original is matched by date, sender and content and deleted (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.deletedIds(CHATS.source.id), "a delete call removes exactly the message 10").toEqual([10]);
    // D87: every thread-body message of the created thread replies to the root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S52 Zero matched originals keep the thread and are reported (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    // The bot has observed no messages of "Source Chat" — the batch matches nothing.
    await ctx.forward({
      chat: CHATS.source,
      id: 10,
      into: CHATS.threads,
      content: { kind: "text", text: "text-10" },
      date: 10 * 3600,
    });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    expect(ctx.hasExactText(CHATS.threads.id, "Lunch"), "the thread is kept with all its messages (root)").toBe(true);
    expect(
      ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
      "the thread is kept with all its messages (closing)",
    ).toBe(true);
    const reports = reportCalls(ctx);
    expect(reports.length, "a report as a reply in the thread is required").toBe(1);
    expectReportInThread(ctx, reports[0]);
    expect(String(reports[0].payload.text ?? "").length, "the report says that no originals were found to delete").toBeGreaterThan(0);
    expect(ctx.deletedIds(CHATS.source.id), "nothing is deleted in the source chat").toEqual([]);
    expect(ctx.hasExactText(CHATS.source.id, ANNOUNCE_42), "the announce is still posted in the source chat").toBe(true);
    // D87: copy, closing and report are thread-body messages — replies to root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S53 An ambiguous match deletes nothing for the ambiguous message (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00", content: { kind: "text", text: "Twin" } });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:00:00", content: { kind: "text", text: "Twin" } });
    await ctx.forward({
      chat: CHATS.source,
      id: 55,
      into: CHATS.threads,
      content: { kind: "text", text: "Twin" },
      date: 10 * 3600,
    });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.deletedIds(CHATS.source.id), "nothing is deleted in the source chat").toEqual([]);
    const reports = reportCalls(ctx);
    expect(reports.length, "a report as a reply in the thread is required").toBe(1);
    expectReportInThread(ctx, reports[0]);
    expect(
      String(reports[0].payload.text ?? "").length,
      "the report says that the original could not be identified",
    ).toBeGreaterThan(0);
    // D87: copy, closing and report are thread-body messages — replies to root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S54 Identical content in another source chat is never cross-matched (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    // D79: /settings discovers chats from observed updates (my_chat_member
    // and messages) filtered to bot-admin membership — seed the discovery
    // signal for "Private Source Chat" before connecting it.
    await ctx.botIsAdminOf([CHATS.privateSource]);
    await ctx.connectSource(CHATS.privateSource);
    await ctx.observe({
      chat: CHATS.privateSource,
      id: 40,
      at: "10:00:00",
      content: { kind: "text", text: "Same" },
    });
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00", content: { kind: "text", text: "Same" } });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.deletedIds(CHATS.source.id), "a delete call removes exactly the message 10").toEqual([10]);
    expect(ctx.deletedIds(CHATS.privateSource.id), "no delete call names the message 40").toEqual([]);
    // D87: every thread-body message of the created thread replies to the root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S55 An edited original is matched after its index entry is refreshed (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00", content: { kind: "text", text: "Hello" } });
    await ctx.observeEdit({ chat: CHATS.source, id: 10, content: { kind: "text", text: "Hello!" } });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads }); // the edited message

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.deletedIds(CHATS.source.id), "a delete call removes exactly the message 10").toEqual([10]);
    // D87: every thread-body message of the created thread replies to the root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S56 Originals already deleted before the transfer are reported and the thread is kept (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    ctx.failDeleteOf([10], { error_code: 400, description: "Bad Request: message to delete not found" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.hasExactText(CHATS.threads.id, "Lunch"), "the thread is kept with all its messages").toBe(true);
    expect(
      ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
      "the thread is kept with all its messages (closing)",
    ).toBe(true);
    const reports = reportCalls(ctx);
    expect(reports.length, "a report as a reply in the thread is required").toBe(1);
    expectReportInThread(ctx, reports[0]);
    const text = String(reports[0].payload.text ?? "");
    expect(text.includes("10"), "the report names the message 10 as not deleted").toBe(true);
    // D74 (OQ-QA-8): grouped by class with counts — the delete failed with
    // "message to delete not found" -> `not_found`; nothing was deleted.
    expectReportCounts(text, { deleted: 0, not_found: 1, forbidden: 0, failed: 0 });
    // D87: copy, closing and report are thread-body messages — replies to root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S57 A partial deletion failure keeps the thread and reports how many originals failed (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.observe({ chat: CHATS.source, id: 12, at: "10:02:00" });
    ctx.failDeleteOf([11], { error_code: 400, description: "Bad Request: oops" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11, 12], into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(
      ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
      "the thread is kept with all its messages",
    ).toBe(true);
    const reports = reportCalls(ctx);
    expect(reports.length, "a report as a reply in the thread is required").toBe(1);
    expectReportInThread(ctx, reports[0]);
    // D74 (OQ-QA-8): grouped by class with counts replace the old "1 of 3"
    // wording — 2 originals deleted, the generic failure of message 11
    // ("Bad Request: oops") lands in `failed`.
    const text = String(reports[0].payload.text ?? "");
    expectReportCounts(text, { deleted: 2, not_found: 0, forbidden: 0, failed: 1 });
    // D87: copies, closing and report are thread-body messages — replies to root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S58 The failure report counts match the actual deletion outcomes (cleanup-and-announce.feature)", async () => {
    for (const [which, expected] of [
      ["none", "none"],
      ["one", "one"],
      ["all", "all"],
    ] as const) {
      const ctx = await boot();
      await background(ctx);
      await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
      await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
      await ctx.observe({ chat: CHATS.source, id: 12, at: "10:02:00" });
      if (which === "one") ctx.failDeleteOf([11], { error_code: 400, description: "Bad Request: oops" });
      if (which === "all") {
        ctx.failDeleteOf([10, 11, 12], { error_code: 400, description: "Bad Request: oops" });
      }
      await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11, 12], into: CHATS.threads });
      const mark = ctx.mark();
      await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

      const reports = reportCalls(ctx);
      if (expected === "none") {
        expect(reports, "no failure report is sent").toEqual([]);
      } else {
        expect(reports.length, `row '${which}': exactly one report is expected`).toBe(1);
        expectReportInThread(ctx, reports[0]);
        const text = String(reports[0].payload.text ?? "");
        // D74 (OQ-QA-8): the counts are per class (deleted/not_found/forbidden/
        // failed), not an "N of M" total. The injected errors are generic
        // ("Bad Request: oops") -> `failed`; successes land in `deleted`.
        if (expected === "one") {
          expectReportCounts(text, { deleted: 2, not_found: 0, forbidden: 0, failed: 1 });
        } else {
          expectReportCounts(text, { deleted: 0, not_found: 0, forbidden: 0, failed: 3 });
        }
      }
      // D87: copies, closing (and the report) are thread-body messages —
      // replies to the root.
      expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
    }
  });

  test("S59 The bot demoted before the deletion step keeps the thread and reports a failure (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    ctx.demoteBotIn(CHATS.source.id); // removed from the admins before the deletion step

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.hasExactText(CHATS.threads.id, "Lunch"), "the thread is kept with all its messages").toBe(true);
    expect(
      ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
      "the thread is kept with all its messages (closing)",
    ).toBe(true);
    const reports = reportCalls(ctx);
    expect(reports.length, "the report is a localized failure message").toBe(1);
    expectReportInThread(ctx, reports[0]);
    // D87: copy, closing and report are thread-body messages — replies to root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
    for (const t of ctx.texts()) {
      expect(leaksRawError(t), `no message may contain a raw error dump: ${t}`).toBe(false);
    }
  });

  test("S60 The announce is posted with the exact thread link (cleanup-and-announce.feature)", async () => {
    for (const [threadsChat, url] of [
      [CHATS.threads, "https://t.me/threads_chat/42?thread=42"],
      [CHATS.privateThreads, "https://t.me/c/200000000000005/42?thread=42"],
    ] as const) {
      const ctx = await boot();
      await background(ctx);
      // D79 (OQ-QA-7): /settings discovers chats from observed updates
      // (my_chat_member and messages) filtered to bot-admin membership — seed
      // the discovery signal for the row's threads chat before connecting it
      // (the same fix as S54/S36; rows whose chat the background did not cover
      // had zero discovery signal). Exact-string assertions are unchanged.
      await ctx.botIsAdminOf([threadsChat]);
      await ctx.connectThreads(threadsChat); // re-points when needed (D58)
      await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
      await ctx.forward({ chat: CHATS.source, id: 10, into: threadsChat });

      // "the next message created by the bot gets the id 42" (sendTitle stub).
      // The dialog runs in the row's threads chat — complete it there.
      const mark = ctx.mark();
      await ctx.completeDialog({ chat: CHATS.source, title: "Lunch", into: threadsChat });
      expect(
        ctx.hasExactText(CHATS.source.id, `Thread created "Lunch": ${url}`),
        `the announce must be exactly 'Thread created "Lunch": ${url}'`,
      ).toBe(true);
      // D87: every thread-body message of the row's thread replies to the root.
      expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(threadsChat.id, mark));
    }
  });

  test("S61 The announce goes to the same forum topic as the forwarded messages (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.botIsAdminOf([CHATS.forum]);
    await ctx.connectSource(CHATS.forum);
    await ctx.observe({ chat: CHATS.forum, id: 10, at: "10:00:00", messageThread: 7 });
    await ctx.forward({ chat: CHATS.forum, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.forum, title: "Lunch" });
    const announce = ctx.api
      .callsOf("sendMessage")
      .find((c) => c.payload.chat_id === CHATS.forum.id && /Thread created/.test(String(c.payload.text ?? "")));
    expect(announce, "the announce is posted in the forum chat").toBeDefined();
    expect(announce!.payload.message_thread_id, "the announce keeps message_thread_id 7").toBe(7);
    // D87/D18: thread assembly is the reply chain in the threads chat, while
    // the forum announce keeps message_thread_id (asserted above, unchanged).
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S62 A batch spanning several forum topics announces in the topic of the first message (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.botIsAdminOf([CHATS.forum]);
    await ctx.connectSource(CHATS.forum);
    await ctx.observe({ chat: CHATS.forum, id: 10, at: "10:00:00", messageThread: 7 });
    await ctx.observe({ chat: CHATS.forum, id: 11, at: "10:01:00", messageThread: 9 });
    await ctx.forwardMany({ chat: CHATS.forum, ids: [10, 11], into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.forum, title: "Lunch" });
    const announces = ctx.api
      .callsOf("sendMessage")
      .filter((c) => c.payload.chat_id === CHATS.forum.id && /Thread created/.test(String(c.payload.text ?? "")));
    expect(announces.length, "exactly one announce is posted").toBe(1);
    expect(announces[0].payload.message_thread_id, "the announce goes to the topic of the first message").toBe(7);
    expect(
      ctx.api.callsOf("sendMessage").filter((c) => c.payload.message_thread_id === 9 && c.payload.chat_id === CHATS.forum.id),
      "no announce is posted with message_thread_id 9",
    ).toEqual([]);
    // D87/D69: the forum announce keeps message_thread_id (asserted above);
    // thread assembly in the threads chat is the reply chain to the root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S63 The announce is posted even when no originals could be deleted (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    ctx.failDeleteOf([10], { error_code: 400, description: "Bad Request: oops" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.hasExactText(CHATS.source.id, ANNOUNCE_42), "the announce is exactly as specified").toBe(true);
    const reports = reportCalls(ctx);
    expect(reports.length, "the report lists the originals that were not deleted").toBe(1);
    expect(
      String(reports[0].payload.text ?? "").includes("10"),
      "the report lists the originals that were not deleted (message 10)",
    ).toBe(true);
    // S63: "the report as a reply to the title message lists the originals
    // that were not deleted" (D87) — and every other thread-body message too.
    expectReportInThread(ctx, reports[0]);
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S84 When the announce cannot be sent the closing message names the plain chat title without a link (cleanup-and-announce.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    // "sending the announce in 'Source Chat' fails with a Telegram error" (D89).
    ctx.failNextSendIn(CHATS.source.id, { error_code: 400, description: "Bad Request: oops" });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    expect(
      ctx.lastFailedCallIndex >= 0 &&
        ctx.api.calls[ctx.lastFailedCallIndex].method === "sendMessage" &&
        ctx.api.calls[ctx.lastFailedCallIndex].payload.chat_id === CHATS.source.id,
      "the announce send in 'Source Chat' actually fails (the injection is not vacuous)",
    ).toBe(true);
    const closing = closingCallIn(ctx, CHATS.threads.id);
    expect(closing, "the closing message is still sent").toBeDefined();
    expect(
      closing!.payload.text,
      "the closing message is exactly 'Lunch — moved from Source Chat' (D89 fallback: the plain chat title, no link)",
    ).toBe("Lunch — moved from Source Chat");
    expect(
      /t\.me\/|https?:\/\//.test(String(closing!.payload.text ?? "")),
      "the fallback closing message carries no link",
    ).toBe(false);
    expect(ctx.replyToOf(closing!), "the closing message is a reply to the title message (D87)").toBe(42);
    expect(ctx.hasExactText(CHATS.threads.id, "Lunch"), "the thread is kept with all its messages (root)").toBe(true);
    expect(ctx.copyMarkerSeq(CHATS.threads.id), "the thread is kept with all its messages (copies)").toContain(10);
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });
});
