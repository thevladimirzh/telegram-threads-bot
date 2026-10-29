/**
 * Acceptance tests — tests/features/failures-and-limits.feature (S64–S75).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S64 -> ACC-6, ACC-14 -> R6, R14
 *   S65 -> ACC-14        -> R14
 *   S66 -> ACC-32, ACC-14 -> R26, R14
 *   S67 -> ACC-32, ACC-16 -> R26, R20
 *   S68 -> ACC-7, ACC-29 -> R7, R38
 *   S69 -> ACC-29, ACC-7 -> R38, R7
 *   S70 -> ACC-7, ACC-29 -> R7, R42
 *   S71 -> ACC-21        -> R27, R10
 *   S72 -> ACC-21        -> R28, R10
 *   S73 -> ACC-21        -> R28, R10, R62   (copy-post detection realigned to D87)
 *   S74 -> ACC-28, ACC-11 -> R37, R11
 *   S75 -> ACC-1, ACC-9  -> R1, R9
 *
 * S72/S73 (retry_after, D24) use vitest fake timers (harness convention 9):
 * the bot waits via timers; the gap between the failing call and its retry is
 * sampled on the mocked clock and must be >= retry_after seconds.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RecordedCall } from "../helpers/fake-bot-api";
import { CHATS, USERS, boot, cleanup, type Ctx } from "./harness";

async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.privateSource, CHATS.threads]);
  await ctx.userIsAdminOf(USERS.author, [CHATS.source]);
  await ctx.connectSource(CHATS.source);
  await ctx.connectSource(CHATS.privateSource);
  await ctx.connectThreads(CHATS.threads);
  ctx.resetCalls();
}

/**
 * Calls that would mean "a thread was created" (root/copies/closing).
 * D87: a thread-body message is a reply to the thread root; the superseded
 * `message_thread_id` assembly is still matched so the check never goes blind.
 */
function threadCreationCalls(ctx: Ctx, mark: number): RecordedCall[] {
  return ctx.callsSince(mark).filter((c) => {
    if (/^copy/.test(c.method)) return true;
    if (c.method === "sendMessage" && (ctx.isThreadBodyCall(c) || c.payload.message_thread_id != null)) return true;
    if (c.method === "sendMessage" && /moved from/.test(String(c.payload.text ?? ""))) return true;
    return false;
  });
}

function dialogReplyText(ctx: Ctx): string {
  const replies = ctx.dialogReplies(CHATS.threads.id);
  expect(replies.length, "the dialog reply is required").toBeGreaterThan(0);
  return String(replies[0].payload.text ?? "");
}

const ANNOUNCE_42 = 'Thread created "Lunch": https://t.me/threads_chat/42?thread=42';

afterEach(cleanup);

describe("failures-and-limits.feature — batch limits, duplicates and API failures", () => {
  test("S64 A mixed batch asks for one chat and transfers only that chat's messages (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.privateSource, id: 20, at: "10:01:00" });
    const fwd10 = await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    const fwd20 = await ctx.forward({ chat: CHATS.privateSource, id: 20, into: CHATS.threads });

    const buttons = ctx.buttons(CHATS.threads.id);
    expect(buttons.some((b) => b.data.includes("200000000000001")), "buttons to pick 'Source Chat'").toBe(true);
    expect(buttons.some((b) => b.data.includes("200000000000004")), "buttons to pick 'Private Source Chat'").toBe(true);

    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.copyMarkerSeq(CHATS.threads.id), "the thread contains only the copy of the message 10").toEqual([10]);

    for (const id of [fwd10, fwd20]) {
      expect(ctx.deletedIds(CHATS.threads.id), "the whole forwarded batch is deleted in the threads chat").toContain(id);
    }
  });

  test("S65 The mixed-batch reply warns how many messages were left out (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.privateSource, id: 20, at: "10:01:00" });
    await ctx.observe({ chat: CHATS.privateSource, id: 21, at: "10:02:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    await ctx.forwardMany({ chat: CHATS.privateSource, ids: [20, 21], into: CHATS.threads });

    expect(dialogReplyText(ctx), "the reply warns that 2 messages from other chats were not included").toContain("2");
  });

  test("S66 A batch over 50 messages is truncated with a warning naming the dropped count (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    const all = Array.from({ length: 55 }, (_, i) => i + 1);
    for (const id of all) {
      await ctx.observe({ chat: CHATS.source, id, at: "10:00:00" });
    }
    await ctx.forwardMany({ chat: CHATS.source, ids: all, into: CHATS.threads });

    expect(dialogReplyText(ctx), "the reply warns that 5 messages were dropped").toContain("5");

    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    const seq = ctx.copyMarkerSeq(CHATS.threads.id);
    expect(seq.length, "the thread contains exactly 50 copies").toBe(50);
    expect(seq, "the first 50 messages in forward order are taken (D31/D41)").toEqual(all.slice(0, 50));
  });

  test("S67 An album straddling the 50-message limit is kept whole and dropped with the overflow (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    const singles = Array.from({ length: 49 }, (_, i) => i + 1);
    for (const id of singles) {
      await ctx.observe({ chat: CHATS.source, id, at: "10:00:00" });
    }
    for (const id of [50, 51, 52]) {
      await ctx.observe({
        chat: CHATS.source,
        id,
        at: "10:01:00",
        content: { kind: "photo", caption: `Album ${id}`, fileId: `ph${id}` },
        mediaGroupId: "grp1",
      });
    }
    await ctx.forwardMany({ chat: CHATS.source, ids: [...singles, 50, 51, 52], into: CHATS.threads });

    expect(dialogReplyText(ctx), "the reply warns that 3 messages were dropped").toContain("3");

    // "the dialog covers the first 49 messages" / "the album is not split":
    // completing the dialog copies exactly the 49 singles, never part of the album.
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    const seq = ctx.copyMarkerSeq(CHATS.threads.id);
    expect(seq, "the dialog covers the first 49 messages").toEqual(singles);
    expect(seq.some((m) => m >= 50), "the album is not split across the batch limit").toBe(false);
  });

  test("S68 A duplicate transfer is refused with a link to the existing thread and no side effects (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.createPriorThread({
      title: "Lunch",
      rootId: 42,
      sourceChat: CHATS.source,
      sourceIds: [10],
      threadsChat: CHATS.threads,
    });

    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    const replies = ctx
      .callsSince(mark)
      .filter((c) => c.method === "sendMessage")
      .map((c) => String(c.payload.text ?? ""));
    expect(replies.some((t) => t.includes("Lunch")), "the refusal names the thread 'Lunch'").toBe(true);
    expect(
      replies.some((t) => t.includes("https://t.me/threads_chat/42?thread=42")),
      "the refusal contains the link to the existing thread",
    ).toBe(true);
    expect(threadCreationCalls(ctx, mark), "no new thread is created").toEqual([]);
    expect(
      ctx.callsSince(mark).filter((c) => c.method === "sendMessage" && c.payload.chat_id === CHATS.source.id),
      "no announce is posted",
    ).toEqual([]);
    expect(ctx.callsSince(mark).filter((c) => /^delete/.test(c.method)), "nothing is deleted anywhere").toEqual([]);
  });

  test("S69 Identical but unmapped messages are not refused as duplicates (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.createPriorThread({
      title: "Lunch",
      rootId: 42,
      sourceChat: CHATS.source,
      sourceIds: [10],
      threadsChat: CHATS.threads,
    });
    // The same text as message 10, but a different, unmapped message.
    await ctx.observe({
      chat: CHATS.source,
      id: 11,
      at: "10:05:00",
      content: { kind: "text", text: "text-10" },
    });

    await ctx.forward({ chat: CHATS.source, id: 11, into: CHATS.threads });
    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    expect(threadCreationCalls(ctx, mark).length, "a new thread is created").toBeGreaterThan(0);
    expect(
      ctx.callsSince(mark).some(
        (c) => c.method === "sendMessage" && c.payload.chat_id === CHATS.source.id && /Thread created/.test(String(c.payload.text ?? "")),
      ),
      "the announce for the new thread is posted in the source chat",
    ).toBe(true);
  });

  test("S70 A batch partially overlapping an existing thread is refused as a duplicate (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.createPriorThread({
      title: "Lunch",
      rootId: 42,
      sourceChat: CHATS.source,
      sourceIds: [10, 11],
      threadsChat: CHATS.threads,
    });

    await ctx.forward({ chat: CHATS.source, id: 11, into: CHATS.threads });
    await ctx.forward({
      chat: CHATS.source,
      id: 12,
      into: CHATS.threads,
      content: { kind: "text", text: "text-12" },
      date: 10 * 3600 + 2 * 60,
    });
    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    const replies = ctx
      .callsSince(mark)
      .filter((c) => c.method === "sendMessage")
      .map((c) => String(c.payload.text ?? ""));
    expect(replies.some((t) => t.includes("Lunch")), "the refusal names the thread 'Lunch'").toBe(true);
    expect(threadCreationCalls(ctx, mark), "no new thread is created").toEqual([]);
    expect(ctx.callsSince(mark).filter((c) => /^delete/.test(c.method)), "nothing is deleted anywhere").toEqual([]);
  });

  test("S71 Deletion uses at most 100 ids per call and deletes every id exactly once (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    const all = Array.from({ length: 50 }, (_, i) => i + 1);
    for (const id of all) {
      await ctx.observe({ chat: CHATS.source, id, at: "10:00:00" });
    }
    const fwdIds = await ctx.forwardMany({ chat: CHATS.source, ids: all, into: CHATS.threads });

    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    for (const call of ctx.api.callsOf("deleteMessages")) {
      expect((call.payload.message_ids as unknown[]).length, "deleteMessages exceeds 100 ids").toBeLessThanOrEqual(100);
    }
    const deletedForwards = ctx.deletedIds(CHATS.threads.id).slice().sort((a, b) => a - b);
    expect(deletedForwards, "every forwarded id is deleted exactly once").toEqual(fwdIds.slice().sort((a, b) => a - b));
    const deletedOriginals = ctx.deletedIds(CHATS.source.id);
    expect(deletedOriginals.slice().sort((a, b) => a - b), "every matched original is deleted").toEqual(all);
    expect(new Set(deletedOriginals).size, "no original is deleted twice").toBe(deletedOriginals.length);
  });

  test("S72 retry_after on deletion is honored and the deletion resumes (failures-and-limits.feature)", async () => {
    const ctx = await boot({ fakeTimers: true, time: "10:00:00" });
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });
    ctx.failFirstDeleteIn(CHATS.source.id, { error_code: 429, description: "Too Many Requests", retry_after: 3 });

    await ctx.pickChat(CHATS.source);
    const pending = ctx.sendTitle("Lunch");
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;

    const failIdx = ctx.lastFailedCallIndex;
    expect(failIdx, "the first deletion must fail with 429").toBeGreaterThanOrEqual(0);
    const failTime = ctx.callTimes[failIdx];
    const retry = ctx.timedCallsSince(failIdx + 1, ["deleteMessage", "deleteMessages"])[0];
    expect(retry, "the deletion is retried").toBeDefined();
    expect(
      retry!.time - failTime,
      "the deletion is retried only after the retry_after interval has passed (3 s)",
    ).toBeGreaterThanOrEqual(3000);
    expect(ctx.deletedIds(CHATS.source.id).slice().sort((a, b) => a - b), "all originals are eventually deleted").toEqual([10, 11]);
    expect(ctx.hasExactText(CHATS.source.id, ANNOUNCE_42), "the transfer ends with the announce in the source chat").toBe(true);
  });

  test("S73 retry_after on posting is honored and the transfer completes (failures-and-limits.feature)", async () => {
    const ctx = await boot({ fakeTimers: true, time: "10:00:00" });
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });
    ctx.failNthCopyPost(2, { error_code: 429, description: "Too Many Requests", retry_after: 5 });

    await ctx.pickChat(CHATS.source);
    const pending = ctx.sendTitle("Lunch");
    await vi.advanceTimersByTimeAsync(120_000);
    await pending;

    const failIdx = ctx.lastFailedCallIndex;
    expect(failIdx, "the second copy post must fail with 429").toBeGreaterThanOrEqual(0);
    const failTime = ctx.callTimes[failIdx];
    // D87: a copy post is a copy* call or a thread-body sendMessage (reply to
    // the root); the superseded message_thread_id assembly is still matched.
    const isCopyPost = (c: RecordedCall): boolean =>
      /^copy/.test(c.method) ||
      (c.method === "sendMessage" && (ctx.isThreadBodyCall(c) || c.payload.message_thread_id != null));
    const retry = ctx.timedCallsSince(failIdx + 1).find((t) => isCopyPost(t.call));
    expect(retry, "the copy is sent again").toBeDefined();
    expect(
      retry!.time - failTime,
      "the copy is sent again only after the retry_after interval has passed (5 s)",
    ).toBeGreaterThanOrEqual(5000);
    expect(
      ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
      "the thread is created completely (closing message)",
    ).toBe(true);
  });

  test("S74 An unexpected API failure ends with a localized message and no raw error (failures-and-limits.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    ctx.failRootPost({ error_code: 500, description: "Internal Server Error" });

    await ctx.pickChat(CHATS.source);
    await ctx.sendTitle("Lunch");

    const failIdx = ctx.lastFailedCallIndex;
    expect(failIdx, "posting the root message must fail").toBeGreaterThanOrEqual(0);
    expect(
      ctx.callsSince(failIdx + 1).filter((c) => c.method === "sendMessage" && c.payload.chat_id === CHATS.threads.id).length,
      "the bot replies with a localized failure message",
    ).toBeGreaterThan(0);
    for (const t of ctx.texts()) {
      expect(/\bat\s+[\w$.<>[\]]+\(.*:\d+:\d+\)|GrammyError|TypeError|ReferenceError|Internal Server Error|error_code/.test(t), `no message may contain a stack trace or raw error: ${t}`).toBe(false);
    }
  });

  test("S75 An aborted dialog deletes nothing in the source chat (failures-and-limits.feature)", async () => {
    for (const abort of ["/cancel", "the 15-minute timeout"] as const) {
      const ctx = await boot();
      await background(ctx);
      await ctx.setTime("10:00:00");
      await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
      await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads, at: "10:00:00" });

      const mark = ctx.mark();
      if (abort === "/cancel") {
        await ctx.command(USERS.author, CHATS.threads, "/cancel");
      } else {
        ctx.setTime("10:15:00");
        await ctx.text(USERS.author, CHATS.threads, "Late Title");
      }
      expect(threadCreationCalls(ctx, mark), `${abort}: no thread is created`).toEqual([]);
      expect(ctx.deletedIds(CHATS.source.id), `${abort}: nothing is deleted in the source chat`).toEqual([]);
    }
  });
});
