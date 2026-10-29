/**
 * Acceptance tests — tests/features/settings.feature (S1–S9).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S1 -> ACC-3, ACC-11 -> R3, R11
 *   S2 -> ACC-3         -> R3
 *   S3 -> ACC-3         -> R3
 *   S4 -> ACC-3         -> R3
 *   S5 -> ACC-3         -> R3
 *   S6 -> ACC-3         -> R3
 *   S7 -> ACC-3         -> R3, R62   (untouched-thread probe also detects D87
 *                                     reply-to-root thread-body messages)
 *   S8 -> ACC-3         -> R3
 *   S9 -> ACC-12        -> R12
 *
 * Black-box: /settings runs in DM; chats are connected only through settings
 * buttons (D11, D77 — located by chat-id substring). State assertions that the
 * scenarios phrase as "X is not connected" are verified as "the refused press
 * produced no store write and no destructive call" plus behavioural probes.
 */
import { afterEach, describe, expect, test } from "vitest";
import { CHATS, USERS, boot, cleanup, hasCyrillic, type Ctx } from "./harness";

/** settings.feature Background: admins declared, bot rights declared. */
async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.privateSource, CHATS.threads, CHATS.privateThreads]);
  await ctx.botIsNotAdminOf([CHATS.other, CHATS.forum, CHATS.threads2]);
}

afterEach(cleanup);

describe("settings.feature — chat connections via /settings in DM", () => {
  test("S1 /settings lists only the chats where the bot is an admin (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.openSettings(USERS.admin);
    const reply = ctx.texts(USERS.admin.id).join("\n");
    expect(reply).toContain("Source Chat");
    expect(reply).toContain("Private Source Chat");
    expect(reply).toContain("Threads Chat");
    expect(reply).toContain("Private Threads Chat");
    expect(reply).not.toContain("Other Chat");
  });

  test("S2 A user outside ADMIN_IDS is refused in /settings (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.openSettings(USERS.stranger);
    const replies = ctx.texts(USERS.stranger.id);
    expect(replies.length, "a localized refusal is required").toBeGreaterThan(0);
    const reply = replies.join("\n");
    for (const title of [
      "Source Chat",
      "Private Source Chat",
      "Threads Chat",
      "Private Threads Chat",
      "Other Chat",
    ]) {
      expect(reply, "the refusal must not list chats").not.toContain(title);
    }
  });

  test("S3 Connecting a source chat is confirmed with the change described (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    const mark = ctx.mark();
    await ctx.connectSource(CHATS.source);
    const replies = ctx.texts(USERS.admin.id);
    expect(replies.length, "a confirmation reply is required").toBeGreaterThan(0);
    expect(replies[replies.length - 1], "the confirmation names the chat").toContain("Source Chat");
    expect(ctx.callsSince(mark).filter((c) => /^(delete|copy|forward)/.test(c.method))).toEqual([]);
  });

  test("S4 Connecting the threads chat is confirmed with the change described (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.connectThreads(CHATS.threads);
    const replies = ctx.texts(USERS.admin.id);
    expect(replies.length, "a confirmation reply is required").toBeGreaterThan(0);
    expect(replies[replies.length - 1], "the confirmation names the chat").toContain("Threads Chat");
  });

  test("S5 A source chat equal to the threads chat is refused (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.connectThreads(CHATS.threads);
    await ctx.openSettings(USERS.admin);
    const button = ctx.settingsButton(CHATS.threads, "source");
    const mark = ctx.mark();
    ctx.writes.length = 0;
    await ctx.callback(USERS.admin, ctx.dm(USERS.admin), button.data, button.messageId);

    const after = ctx.callsSince(mark);
    const replies = after.filter((c) => c.method === "sendMessage");
    expect(replies.length, "the bot must reply with a localized refusal").toBeGreaterThan(0);
    for (const r of replies) {
      expect(String(r.payload.text ?? "").length, "the refusal must be non-empty localized text").toBeGreaterThan(0);
    }
    expect(ctx.writes, "the refused press must not connect the chat (D33)").toEqual([]);
    expect(after.filter((c) => /^(delete|copy|forward)/.test(c.method))).toEqual([]);
    // "Threads Chat is not connected as a source chat": a batch from it is refused.
    await ctx.observe({ chat: CHATS.threads, from: USERS.author, id: 90, at: "10:00:00" });
    const probeMark = ctx.mark();
    await ctx.forward({ chat: CHATS.threads, id: 90, into: CHATS.threads });
    expect(ctx.dialogReplies(CHATS.threads.id).length, "no dialog opens from a non-source chat").toBe(0);
    expect(ctx.callsSince(probeMark).filter((c) => /^(delete|copy)/.test(c.method))).toEqual([]);
  });

  test("S6 Marking a second threads chat re-points the single threads chat (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.botIsAdminOf([CHATS.threads2]);
    await ctx.connectThreads(CHATS.threads);
    await ctx.pressSettingsButton(CHATS.threads2, "threads");

    const replies = ctx.texts(USERS.admin.id);
    const last = replies[replies.length - 1];
    expect(last, "the confirmation names the new threads chat").toContain("Threads Chat 2");
    expect(last, "the confirmation names the disconnected chat").toContain("Threads Chat");

    // "Threads Chat 2 is the only chat shown as the threads chat afterwards":
    // behavioural probe — only the new threads chat opens dialogs now.
    await ctx.observe({ chat: CHATS.source, id: 60, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 60, into: CHATS.threads2 });
    expect(ctx.dialogReplies(CHATS.threads2.id).length, "the new threads chat opens the dialog").toBe(1);
    await ctx.observe({ chat: CHATS.source, id: 61, at: "10:01:00" });
    await ctx.forward({ chat: CHATS.source, id: 61, into: CHATS.threads });
    expect(ctx.dialogReplies(CHATS.threads.id).length, "the old threads chat is disconnected").toBe(0);
  });

  test("S7 Disconnecting a source chat is confirmed and leaves created threads intact (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.connectSource(CHATS.source);
    await ctx.connectThreads(CHATS.threads);
    await ctx.createPriorThread({
      title: "Lunch",
      rootId: 42,
      sourceChat: CHATS.source,
      sourceIds: [10],
      threadsChat: CHATS.threads,
    });

    const mark = ctx.mark();
    await ctx.disconnectSource(CHATS.source);
    const replies = ctx.texts(USERS.admin.id);
    expect(replies[replies.length - 1], "the confirmation names the chat").toContain("Source Chat");

    // "no message is sent or deleted on behalf of the thread 'Lunch'"
    const after = ctx.callsSince(mark).filter((c) => c.method !== "answerCallbackQuery");
    expect(after.filter((c) => /^(delete|copy|forward)/.test(c.method))).toEqual([]);
    expect(
      after.filter(
        (c) =>
          c.payload.chat_id === CHATS.threads.id ||
          c.payload.message_thread_id === 42 ||
          ctx.replyToOf(c) === 42, // D87: thread-body messages reply to the root
      ),
      "the created thread must stay untouched",
    ).toEqual([]);
  });

  test("S8 An admin of the source chat without global admin rights cannot change connections (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.userIsAdminOf(USERS.author, [CHATS.source]);

    // The settings button is discovered from a real admin /settings reply and
    // then pressed by the non-global-admin (client-side forgery, same pattern
    // as SEC-3): D77 callback_data embeds the chat id.
    await ctx.openSettings(USERS.admin);
    const button = ctx.settingsButton(CHATS.source, "source");
    const mark = ctx.mark();
    ctx.writes.length = 0;
    await ctx.callback(USERS.author, ctx.dm(USERS.author), button.data, button.messageId);

    const after = ctx.callsSince(mark);
    const replies = after.filter((c) => c.method === "sendMessage" && c.payload.chat_id === ctx.dm(USERS.author).id);
    expect(replies.length, "the bot must reply with a localized refusal").toBeGreaterThan(0);
    expect(ctx.writes, "the forged press must not connect the chat").toEqual([]);
    expect(after.filter((c) => /^(delete|copy|forward)/.test(c.method))).toEqual([]);
  });

  test("S9 The locale is switched manually in /settings and used afterwards (settings.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.switchLang(USERS.admin, "ru");
    const replies = ctx.texts(USERS.admin.id);
    expect(replies.length, "a confirmation reply is required").toBeGreaterThan(0);
    expect(hasCyrillic(replies[replies.length - 1]), "the confirmation is in Russian").toBe(true);

    await ctx.openSettings(USERS.admin);
    const later = ctx.texts(USERS.admin.id);
    expect(hasCyrillic(later[later.length - 1]), "subsequent messages to the user are in Russian").toBe(true);
  });
});
