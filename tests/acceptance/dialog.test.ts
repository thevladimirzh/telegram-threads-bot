/**
 * Acceptance tests — tests/features/dialog.feature (S15–S33, S83).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S15 -> ACC-9            -> R9
 *   S16 -> ACC-9            -> R9
 *   S17 -> ACC-19, ACC-6    -> R25, R6
 *   S18 -> ACC-19, ACC-6    -> R25, R6
 *   S19 -> ACC-6, ACC-11    -> R6, R11
 *   S20 -> ACC-9, ACC-22    -> R9, R31
 *   S21 -> ACC-22           -> R44, R31
 *   S22 -> ACC-22           -> R44
 *   S23 -> ACC-23, ACC-22   -> R16, R19, R30   (R16 -> UNIT-8)
 *   S24 -> ACC-23           -> R19
 *   S25 -> ACC-23           -> R19
 *   S26 -> ACC-23, ACC-33    -> R16, R19, R63   (R16 -> UNIT-8; closing exact
 *                                               text = D89 announce link)
 *   S27 -> ACC-9, ACC-24    -> R9, R32
 *   S28 -> ACC-22           -> R45
 *   S29 -> ACC-22           -> R45, R31
 *   S30 -> ACC-9, ACC-24    -> R9, R32
 *   S31 -> ACC-24, ACC-9    -> R32, R9
 *   S32 -> ACC-22           -> R30             (D68 (final): a second forward
 *                                               from the same author JOINS the
 *                                               open draft — no refusal)
 *   S33 -> ACC-22           -> R31, R62         (thread membership is the reply
 *                                               chain to the root, D87 —
 *                                               `threadMarkers` realigned)
 *   S83 -> ACC-22           -> R30             (new, D68 (final): a forward
 *                                               from another chat RECREATES
 *                                               the draft)
 *
 * Scenario Outlines (S23/S24/S25/S31) are one test each with a table-driven
 * loop; every row boots a fresh bot so rows stay independent.
 */
import { afterEach, describe, expect, test } from "vitest";
import type { RecordedCall } from "../helpers/fake-bot-api";
import { CHATS, USERS, boot, cleanup, isMarkedSelected, type Ctx } from "./harness";

async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.privateSource, CHATS.threads]);
  await ctx.userIsAdminOf(USERS.author, [CHATS.source]);
  await ctx.userIsAdminOf(USERS.other_author, [CHATS.source]);
  await ctx.userHasNoRightsIn(USERS.stranger, [CHATS.source]);
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

/** A non-empty localized reply in the threads chat after `mark`. */
function repliesAfter(ctx: Ctx, mark: number, chatId = CHATS.threads.id): string[] {
  return ctx
    .callsSince(mark)
    .filter((c) => c.method === "sendMessage" && c.payload.chat_id === chatId)
    .map((c) => String(c.payload.text ?? ""))
    .filter((t) => t.length > 0);
}

afterEach(cleanup);

describe("dialog.feature — the transfer dialog in the threads chat", () => {
  test("S15 Forwarding a message from a connected source chat opens the dialog (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    const fwdId = await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const reply = ctx.api
      .callsOf("sendMessage")
      .find((c) => c.payload.chat_id === CHATS.threads.id && ctx.replyToOf(c) === fwdId);
    expect(reply, "the bot must reply to the forwarded message in the threads chat").toBeDefined();

    const buttons = ctx.buttons(CHATS.threads.id);
    expect(
      buttons.some((b) => b.data.includes("200000000000001")),
      "the reply must offer a button for 'Source Chat' (D77: chat id in callback_data)",
    ).toBe(true);
    expect(
      buttons.some((b) => b.data.includes("200000000000004")),
      "the reply must offer a button for 'Private Source Chat'",
    ).toBe(true);
    expect(String(reply!.payload.text ?? "").length, "the reply asks for the thread title").toBeGreaterThan(0);
  });

  test("S16 The dialog reply is the bot's first and only response to the forwarded batch (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const sends = ctx.api.callsOf("sendMessage");
    expect(sends.length, "the dialog reply is the bot's only response").toBe(1);
    const dialog = sends[0];
    expect(dialog.payload.chat_id, "the response goes to the threads chat").toBe(CHATS.threads.id);
    expect((dialog.payload.reply_markup as any)?.inline_keyboard, "the dialog reply carries the chat buttons").toBeTruthy();

    // The dialog reply is the first user-visible call (only read-only lookups
    // may precede it — S16's "first recorded API call").
    const idx = ctx.api.calls.indexOf(dialog);
    for (const c of ctx.api.calls.slice(0, idx)) {
      expect(c.method, `unexpected non-read call before the dialog reply: ${c.method}`).toMatch(/^get/);
    }
    expect(ctx.api.calls.filter((c) => /^(delete|copy|forward)/.test(c.method)), "nothing is deleted anywhere").toEqual([]);
  });

  test("S17 The source chat is preselected from forward_origin when it is connected (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const buttons = ctx.buttons(CHATS.threads.id);
    const sourceBtn = buttons.find((b) => b.data.includes("200000000000001"));
    const privateBtn = buttons.find((b) => b.data.includes("200000000000004"));
    expect(sourceBtn, "the dialog offers a button for 'Source Chat'").toBeDefined();
    expect(privateBtn, "the dialog offers a button for 'Private Source Chat'").toBeDefined();
    expect(isMarkedSelected(sourceBtn!), "the 'Source Chat' button is marked as selected").toBe(true);
    expect(isMarkedSelected(privateBtn!), "the other button is not marked as selected").toBe(false);
  });

  test("S18 A hidden-sender forward shows the chat buttons without preselection (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads, hidden: true });

    const buttons = ctx.buttons(CHATS.threads.id).filter((b) => b.data.includes("200000000000001") || b.data.includes("200000000000004"));
    expect(buttons.length, "chat buttons are shown").toBeGreaterThan(0);
    for (const b of buttons) {
      expect(isMarkedSelected(b), `button ${b.data} must not be preselected`).toBe(false);
    }
  });

  test("S19 A forward from a non-connected chat is refused with a clear message (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.other, id: 30, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.other, id: 30, into: CHATS.threads });

    const reply = repliesAfter(ctx, 0).join("\n");
    expect(reply.length, "a localized refusal is required").toBeGreaterThan(0);
    expect(reply, "the refusal names the not-connected chat").toContain("Other Chat");
    expect(ctx.dialogReplies(CHATS.threads.id), "no dialog is opened").toEqual([]);
    expect(ctx.deletedIds(CHATS.other.id), "nothing is deleted in the non-connected chat").toEqual([]);
  });

  test("S20 Text from a user other than the forward author is ignored (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.text(USERS.stranger, CHATS.threads, "My Title");
    expect(threadCreationCalls(ctx, mark), "no thread is created by a foreign answer").toEqual([]);
    expect(ctx.texts(CHATS.threads.id), "the foreign title must not become a thread root").not.toContain("My Title");

    // The author's draft is unchanged: their title completes the transfer.
    await ctx.sendTitle("Real Title");
    expect(ctx.hasExactText(CHATS.threads.id, "Real Title"), "the thread root is the author's title").toBe(true);
    expect(ctx.copyMarkerSeq(CHATS.threads.id), "the thread is created from the author's batch").toContain(10);
  });

  test("S21 A chat-choice callback from another user leaves the draft untouched (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.pickChat(CHATS.source, USERS.stranger);
    expect(
      ctx.callsSince(mark).filter((c) => c.method === "answerCallbackQuery").length,
      "the callback is acknowledged without errors",
    ).toBeGreaterThan(0);
    expect(threadCreationCalls(ctx, mark), "no thread is created").toEqual([]);

    // The draft of user "author" is unchanged.
    await ctx.completeDialog({ chat: CHATS.source, title: "Recovered" });
    expect(ctx.copyMarkerSeq(CHATS.threads.id), "the author's batch is still attached to the draft").toContain(10);
  });

  test("S22 Stale inline buttons after the dialog ended change nothing (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.createPriorThread({
      title: "Lunch",
      rootId: 42,
      sourceChat: CHATS.source,
      sourceIds: [10],
      threadsChat: CHATS.threads,
    });

    const mark = ctx.mark();
    await ctx.pickChat(CHATS.source, USERS.author);
    const after = ctx.callsSince(mark);
    expect(
      after.filter((c) => c.method === "answerCallbackQuery").length,
      "the stale callback is acknowledged without errors",
    ).toBeGreaterThan(0);
    expect(threadCreationCalls(ctx, mark), "no thread is created or changed").toEqual([]);
    expect(after.filter((c) => /^(delete|copy|forward)/.test(c.method)), "nothing is deleted anywhere").toEqual([]);
  });

  test("S23 An invalid title is rejected with the 1..255 rule and the draft stays open (dialog.feature)", async () => {
    for (const title of ["", "   "]) {
      const ctx = await boot();
      await background(ctx);
      await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
      await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

      const mark = ctx.mark();
      await ctx.text(USERS.author, CHATS.threads, title);
      const replies = repliesAfter(ctx, mark);
      expect(replies.length, `title ${JSON.stringify(title)}: a localized rejection is required`).toBeGreaterThan(0);
      expect(
        replies.some((t) => t.includes("255")),
        `title ${JSON.stringify(title)}: the rejection states the 1..255 rule`,
      ).toBe(true);
      expect(threadCreationCalls(ctx, mark), "no thread is created").toEqual([]);

      // "the draft is still open": a valid title still completes the transfer.
      await ctx.sendTitle("Recovered");
      expect(ctx.hasExactText(CHATS.threads.id, "Recovered"), "the draft survives the rejected title").toBe(true);
    }
  });

  test("S24 A valid title of 1..255 code points is accepted (dialog.feature)", async () => {
    for (const [length, char] of [
      ["1", "x"],
      ["255", "x"],
      ["255", "🙂"],
    ] as const) {
      const ctx = await boot();
      await background(ctx);
      await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
      await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

      const title = char.repeat(Number(length));
      await ctx.text(USERS.author, CHATS.threads, title);
      expect(
        ctx.hasExactText(CHATS.threads.id, title),
        `title of ${length} ${char} must become the thread root message`,
      ).toBe(true);
    }
  });

  test("S25 A title over 255 code points is rejected even with multi-unit characters (dialog.feature)", async () => {
    for (const [length, char] of [
      ["256", "x"],
      ["256", "🙂"],
      ["128", "🇷🇺"],
    ] as const) {
      const ctx = await boot();
      await background(ctx);
      await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
      await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

      const title = char.repeat(Number(length));
      const mark = ctx.mark();
      await ctx.text(USERS.author, CHATS.threads, title);
      const replies = repliesAfter(ctx, mark);
      expect(replies.length, `title of ${length} ${char}: a localized rejection is required`).toBeGreaterThan(0);
      expect(
        replies.some((t) => t.includes("255")),
        `title of ${length} ${char}: the rejection states the 1..255 rule`,
      ).toBe(true);
      expect(threadCreationCalls(ctx, mark), "no thread is created").toEqual([]);
    }
  });

  test("S26 The title is trimmed before use in the thread root and closing message (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    // "the announce message gets the id 42" (D89: the closing link embeds it).
    ctx.setNextSendIdIn(CHATS.source.id, 42);
    await ctx.text(USERS.author, CHATS.threads, "   Lunch menu   ");
    expect(ctx.hasExactText(CHATS.threads.id, "Lunch menu"), "the root message carries the trimmed title").toBe(true);
    expect(
      ctx.hasExactText(CHATS.threads.id, "Lunch menu — moved from https://t.me/c/200000000000001/42"),
      "the closing message is exactly 'Lunch menu — moved from https://t.me/c/200000000000001/42' (D89: the announce-message link)",
    ).toBe(true);
  });

  test("S27 The forward author aborts the dialog with /cancel (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.command(USERS.author, CHATS.threads, "/cancel");
    expect(repliesAfter(ctx, mark).length, "a localized abort message is required").toBeGreaterThan(0);
    expect(threadCreationCalls(ctx, mark), "no thread is created").toEqual([]);
    expect(ctx.deletedIds(CHATS.source.id), "nothing is deleted in the source chat").toEqual([]);
  });

  test("S28 /cancel without an active draft replies harmlessly (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    const mark = ctx.mark();
    await ctx.command(USERS.author, CHATS.threads, "/cancel"); // must not raise
    expect(
      repliesAfter(ctx, mark).length,
      "a localized message that there is no active dialog is required",
    ).toBeGreaterThan(0);
  });

  test("S29 /cancel from a non-author leaves the draft untouched (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.command(USERS.stranger, CHATS.threads, "/cancel");
    expect(repliesAfter(ctx, mark).length, "a harmless localized message is required").toBeGreaterThan(0);
    expect(threadCreationCalls(ctx, mark), "no thread is created").toEqual([]);

    // The draft of user "author" is unchanged.
    await ctx.completeDialog({ chat: CHATS.source, title: "Recovered" });
    expect(ctx.copyMarkerSeq(CHATS.threads.id), "the author's batch is still attached to the draft").toContain(10);
  });

  test("S30 The draft times out after 15 minutes (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.setTime("10:00:00");
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads, at: "10:00:00" });

    ctx.setTime("10:15:00");
    const mark = ctx.mark();
    await ctx.text(USERS.author, CHATS.threads, "Late Title"); // arrives at 10:15:00 = 15 min
    expect(repliesAfter(ctx, mark).length, "a localized timeout abort message is required").toBeGreaterThan(0);
    expect(threadCreationCalls(ctx, mark), "no thread is created").toEqual([]);
    expect(ctx.deletedIds(CHATS.source.id), "nothing is deleted in the source chat").toEqual([]);
  });

  test("S31 An answer at the timeout boundary has one defined outcome (dialog.feature)", async () => {
    for (const [time, expectation] of [
      ["10:14:59", "created"],
      ["10:15:00", "timeout"],
    ] as const) {
      const ctx = await boot();
      await background(ctx);
      await ctx.setTime("10:00:00");
      await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
      await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads, at: "10:00:00" });

      ctx.setTime(time);
      const mark = ctx.mark();
      await ctx.text(USERS.author, CHATS.threads, "Just In Time"); // arrives at <time>

      if (expectation === "created") {
        expect(ctx.hasExactText(CHATS.threads.id, "Just In Time"), `${time}: the thread is created`).toBe(true);
        expect(
          ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
          `${time}: the thread is complete with its closing message`,
        ).toBe(true);
      } else {
        expect(repliesAfter(ctx, mark).length, `${time}: a localized timeout abort is required`).toBeGreaterThan(0);
        expect(threadCreationCalls(ctx, mark), `${time}: no thread is created`).toEqual([]);
      }
    }
  });

  test("S32 A second forward from the same author joins the open draft (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.forward({ chat: CHATS.source, id: 11, into: CHATS.threads });

    // D68 (final): the same author + the same source chat JOINS the open
    // draft batch — no second dialog message and no refusal.
    const dialogIds = new Set(ctx.dialogReplies(CHATS.threads.id).map((c) => ctx.messageIdOf(c)));
    expect(dialogIds.size, "no second dialog message is posted (the draft is joined, not re-opened)").toBe(1);
    // "no refusal message is sent" — the old 'a dialog is already in progress'
    // rejection. Wording is free-form (D72), so the refusal is detected
    // semantically (same style as leaksRawError); a plain acknowledgement of
    // the join is allowed by D68 ("no new dialog message, no refusal").
    for (const text of repliesAfter(ctx, mark)) {
      expect(
        /already|in progress|refus|reject|ignor/i.test(text),
        `the second forward must not be refused: ${JSON.stringify(text)}`,
      ).toBe(false);
    }
    expect(threadCreationCalls(ctx, mark), "joining the batch creates no thread by itself").toEqual([]);
    expect(
      ctx.callsSince(mark).filter((c) => /^(delete|copy|forward)/.test(c.method)),
      "nothing is deleted or copied while the draft is still open",
    ).toEqual([]);

    // "the draft holds both messages" — black-box observable: completing the
    // dialog yields thread copies of 10 and 11 in source order.
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    const batch = ctx.copyMarkerSeq(CHATS.threads.id).filter((id) => id === 10 || id === 11);
    expect(batch, "the thread copies hold both messages in source order").toEqual([10, 11]);
  });

  test("S33 Interleaved dialogs of two authors are kept apart (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, from: USERS.other_author, id: 20, at: "10:02:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });
    await ctx.forward({ user: USERS.other_author, chat: CHATS.source, id: 20, into: CHATS.threads });

    await ctx.sendTitle("Beta", USERS.other_author, CHATS.threads, 42);
    await ctx.sendTitle("Alpha", USERS.author, CHATS.threads, 50);

    expect(ctx.hasExactText(CHATS.threads.id, "Alpha"), "the author's thread is titled 'Alpha'").toBe(true);
    expect(ctx.hasExactText(CHATS.threads.id, "Beta"), "the other author's thread is titled 'Beta'").toBe(true);

    const alphaMarkers = ctx.threadMarkers(50);
    const betaMarkers = ctx.threadMarkers(42);
    expect(alphaMarkers, "the 'Alpha' thread is created from the batch of user 'author'").toContain(10);
    expect(alphaMarkers, "the 'Alpha' thread contains no foreign batch").not.toContain(20);
    expect(betaMarkers, "the 'Beta' thread is created from the batch of user 'other_author'").toContain(20);
    expect(betaMarkers, "the 'Beta' thread contains no foreign batch").not.toContain(10);
  });

  test("S83 A forward from another chat while a draft is open recreates the draft (dialog.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    // D79 (OQ-QA-7): "Other Chat" must get the discovery signal before it can
    // be connected (the same seeding pattern as S54/S36); D4: the author can
    // only transfer from a chat where they are an admin.
    await ctx.botIsAdminOf([CHATS.other]);
    await ctx.userIsAdminOf(USERS.author, [CHATS.other]);
    await ctx.connectSource(CHATS.other);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.other, id: 20, at: "10:02:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.forward({ chat: CHATS.other, id: 20, into: CHATS.threads });

    // D68 (final): a forward from a DIFFERENT source chat RE-RENDERS the
    // dialog — the chat/title selection is cleared (the batch keeps the
    // earlier messages, D68 final) and a NEW dialog message asking for the
    // source chat and the title is posted.
    const dialogs = ctx.dialogReplies(CHATS.threads.id);
    const dialogIds = new Set(dialogs.map((c) => ctx.messageIdOf(c)));
    expect(dialogIds.size, "a NEW dialog message is posted (the draft is recreated)").toBe(2);
    const fresh = dialogs[dialogs.length - 1];
    expect(fresh.method, "the new dialog message is a new post, not an edit").toBe("sendMessage");
    expect(String(fresh.payload.text ?? "").length, "the new dialog message asks for the thread title").toBeGreaterThan(0);
    const freshData = (((fresh.payload.reply_markup as any)?.inline_keyboard ?? []) as any[][])
      .flat()
      .map((b: any) => String(b?.callback_data ?? ""));
    expect(
      freshData.some((d: string) => d.includes("200000000000006")),
      "the new dialog message offers a button for 'Other Chat' (D77: chat id in callback_data)",
    ).toBe(true);
    expect(
      freshData.some((d: string) => d.includes("200000000000001")),
      "the new dialog message offers a button for 'Source Chat' (it asks for the source chat)",
    ).toBe(true);
    expect(threadCreationCalls(ctx, mark), "recreating the draft creates no thread by itself").toEqual([]);

    // "the draft now holds only msg 20" — black-box observable: completing the
    // dialog afterwards transfers only 20 and deletes only 20's original.
    await ctx.completeDialog({ chat: CHATS.other, title: "Lunch" });
    const markers = ctx.copyMarkerSeq(CHATS.threads.id);
    expect(markers, "the thread copies hold the message 20").toContain(20);
    expect(markers, "the thread copies hold no message of the replaced draft").not.toContain(10);
    expect(ctx.deletedIds(CHATS.other.id), "exactly the original 20 is deleted in 'Other Chat'").toEqual([20]);
    expect(ctx.deletedIds(CHATS.source.id), "nothing is deleted in 'Source Chat'").toEqual([]);
  });
});
