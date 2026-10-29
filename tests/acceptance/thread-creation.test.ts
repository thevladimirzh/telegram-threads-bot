/**
 * Acceptance tests — tests/features/thread-creation.feature (S34–S41).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S34 -> ACC-25, ACC-8, ACC-33 -> R33, R8, R62, R63   (closing link = D89 announce link)
 *   S35 -> ACC-25, ACC-8 -> R33, R8, R62
 *   S36 -> ACC-4, ACC-26, ACC-33 -> R4, R34, R63        (D89 link formats, + basic-group QA row)
 *   S37 -> ACC-8, ACC-33 -> R8, R63                     (closing exact text = D89 link)
 *   S38 -> ACC-20, ACC-33 -> R41, R63                   (first line = D89 link, computed)
 *   S39 -> ACC-1, ACC-25 -> R1, R33, R62
 *   S40 -> ACC-1, ACC-28 -> R1, R37, R62
 *   S41 -> ACC-29, ACC-7 -> R42, R7, R62
 *
 * Exact strings (decisions §3, en): closing `{title} — moved from {link}`
 * (em dash U+2014), extra line `N messages replaced by placeholders` (D39).
 * D89 (iteration 3, R63; amends D7/D62): the closing link points to the
 * ANNOUNCE message in the source chat — `https://t.me/c/{internal_chat_id}/
 * {announce_message_id}` (uniform for public and private chats; the bare
 * `t.me/c/{chat_id}` and the `t.me/{username}` closing forms are dropped).
 * The announce is sent BEFORE the closing message so its id is known; the
 * steps "the announce message gets the id 42" (stub) pin that id so the
 * closing texts are exact. The root message gets id 42 (fixture convention,
 * harness `sendTitle`).
 *
 * D87 (iteration 2): the thread is a reply chain — every thread-body message
 * (copy, placeholder, closing, failure report) is a reply to the root (the
 * title message, id 42) and carries NO `message_thread_id`; the old
 * `message_thread_id`-based assembly is the reported bug and is superseded.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  CHATS,
  USERS,
  announceCallIn,
  boot,
  cleanup,
  closingCallIn,
  type ChatFixture,
  type Ctx,
  type ThreadPost,
} from "./harness";

async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.threads]);
  await ctx.userIsAdminOf(USERS.author, [CHATS.source]);
  await ctx.connectSource(CHATS.source);
  await ctx.connectThreads(CHATS.threads);
  ctx.resetCalls();
}

/** Content posts (root/copies/closing) into the threads chat since a mark. */
function postsSince(ctx: Ctx, mark: number): ThreadPost[] {
  return ctx.threadPosts(CHATS.threads.id).filter((p) => ctx.api.calls.indexOf(p.call) >= mark);
}

function postTexts(posts: ThreadPost[]): string[] {
  return posts.map((p) => (p.kind === "text" ? p.text : `<copy:${p.ids.join(",")}>`));
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

afterEach(cleanup);

describe("thread-creation.feature — thread creation and layout", () => {
  test("S34 A valid title creates the thread with the title message as its root (thread-creation.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });

    const mark = ctx.mark();
    ctx.setNextSendIdIn(CHATS.source.id, 42); // "the announce message gets the id 42"
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    const posts = postsSince(ctx, mark);
    expect(posts.length, "root + copies + closing are expected").toBeGreaterThanOrEqual(3);
    expect(postTexts(posts)[0], "'Lunch' is sent as the first message of the thread").toBe("Lunch");
    expect(ctx.copyMarkerSeq(CHATS.threads.id), "the copies follow in forward order").toEqual([10, 11]);
    expect(
      ctx.hasExactText(CHATS.threads.id, "Lunch — moved from https://t.me/c/200000000000001/42"),
      "the closing message is exactly 'Lunch — moved from https://t.me/c/200000000000001/42' (D89: the link points to the announce message)",
    ).toBe(true);
    // S34: "each copy is a reply to the title message" + "the closing message
    // is a reply to the title message" (D87).
    expectBodyRepliesToRoot(ctx, posts.slice(1));
  });

  test("S35 Copies and the closing message are posted into the thread of the root message (thread-creation.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" }); // root gets id 42

    const posts = postsSince(ctx, mark);
    expect(postTexts(posts)[0], "the root message 'Lunch' is created first").toBe("Lunch");
    expect(ctx.messageIdOf(posts[0].call), "the root message gets the id 42").toBe(42);
    // D87 (supersedes the old message_thread_id-based assembly): the thread is
    // a reply chain — copies and the closing message are replies to the root,
    // and no message of the thread carries message_thread_id.
    expectBodyRepliesToRoot(ctx, posts.slice(1));
    for (const p of posts) {
      expect(
        p.call.payload.message_thread_id,
        `no message of the thread carries message_thread_id (D87): ${p.call.method}`,
      ).toBeUndefined();
    }
  });

  test("S36 The closing message links back to the source chat (thread-creation.feature)", async () => {
    // D89 (R63, amends D62): the closing link is the ANNOUNCE message link
    // `https://t.me/c/{internal_chat_id}/{announce_message_id}` — uniform for
    // public and private chats (the bare `t.me/c/{chat_id}` and the
    // `t.me/{username}` closing forms are dropped as unresolvable). The
    // "Basic Group" row is extra QA depth (R63): it checks the `-` (basic
    // group) prefix stripping of D62 and is not part of the scenario table.
    const rows: Array<[ChatFixture, string]> = [
      [CHATS.source, "200000000000001"],
      [CHATS.privateSource, "200000000000004"],
      [{ id: -123456789, type: "group", title: "Basic Group" }, "123456789"],
    ];
    for (const [sourceChat, strippedId] of rows) {
      const ctx = await boot();
      await background(ctx);
      // D79: /settings discovers chats from observed updates (my_chat_member
      // and messages) filtered to bot-admin membership — seed the discovery
      // signal before connecting a chat the background did not cover.
      await ctx.botIsAdminOf([sourceChat]);
      // D4 / SEC-1: only a source-chat ADMIN may move messages — the row's
      // author needs its admin membership seeded too (same as S83 in
      // dialog.test.ts). Without it the bot correctly refuses the transfer.
      await ctx.userIsAdminOf(USERS.author, [sourceChat]);
      await ctx.connectSource(sourceChat);
      await ctx.observe({ chat: sourceChat, id: 10, at: "10:00:00" });
      await ctx.forward({ chat: sourceChat, id: 10, into: CHATS.threads });

      const mark = ctx.mark();
      ctx.setNextSendIdIn(sourceChat.id, 42); // "the announce message gets the id 42"
      await ctx.completeDialog({ chat: sourceChat, title: "Lunch" });

      const announce = announceCallIn(ctx, sourceChat.id);
      expect(announce, "the announce is posted in the source chat (D89: its id feeds the closing link)").toBeDefined();
      expect(ctx.messageIdOf(announce!), "the announce message gets the id 42").toBe(42);
      const closing = closingCallIn(ctx, CHATS.threads.id);
      expect(closing, "the closing message is posted in the threads chat").toBeDefined();
      expect(
        ctx.api.calls.indexOf(announce!) < ctx.api.calls.indexOf(closing!),
        "the announce is sent BEFORE the closing message (D89: its id is needed for the link)",
      ).toBe(true);
      expect(
        closing!.payload.text,
        `the closing message must be exactly 'Lunch — moved from https://t.me/c/${strippedId}/42'`,
      ).toBe(`Lunch — moved from https://t.me/c/${strippedId}/42`);
      // The closing message is a thread-body message: a reply to the root (D87).
      expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
    }
  });

  test("S37 The closing message carries no placeholder line when nothing was replaced (thread-creation.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00", content: { kind: "text", text: "Hello" } });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    ctx.setNextSendIdIn(CHATS.source.id, 42); // "the announce message gets the id 42"
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    const closing = ctx.api
      .callsOf("sendMessage")
      .find((c) => String(c.payload.text ?? "") === "Lunch — moved from https://t.me/c/200000000000001/42");
    expect(
      closing,
      "the closing message is exactly 'Lunch — moved from https://t.me/c/200000000000001/42' (D89: the announce-message link)",
    ).toBeDefined();
    expect(String(closing!.payload.text ?? "").includes("\n"), "the closing message has no second line").toBe(false);
    // The closing message is a thread-body message: a reply to the root (D87).
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S38 The closing message reports the placeholder count when placeholders were used (thread-creation.feature)", async () => {
    for (const n of [1, 2]) {
      const ctx = await boot();
      await background(ctx);
      const ids: number[] = [];
      for (let i = 0; i < n; i++) {
        const id = 30 + i;
        ids.push(id);
        await ctx.observe({
          chat: CHATS.source,
          id,
          at: "10:00:00",
          content: { kind: "poll", question: `Lunch ${i}?` },
        });
      }
      await ctx.forwardMany({ chat: CHATS.source, ids, into: CHATS.threads });

      const mark = ctx.mark();
      await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
      // D89 (R63): the first line carries the announce-message link
      // `https://t.me/c/{internal_chat_id}/{announce_message_id}` — the announce
      // id is not stubbed here, so it is taken from the announce call itself.
      const announce = announceCallIn(ctx, CHATS.source.id);
      expect(announce, "the announce is posted in the source chat (D89: its id feeds the closing link)").toBeDefined();
      const link = `https://t.me/c/200000000000001/${ctx.messageIdOf(announce!)}`;
      expect(
        ctx.hasExactText(
          CHATS.threads.id,
          `Lunch — moved from ${link}\n${n} messages replaced by placeholders`,
        ),
        `the closing message must be exactly 'Lunch — moved from ${link}\\n${n} messages replaced by placeholders'`,
      ).toBe(true);
      const closing = closingCallIn(ctx, CHATS.threads.id);
      expect(
        String(closing!.payload.text ?? "").split("\n")[1],
        `the second line must be exactly '${n} messages replaced by placeholders'`,
      ).toBe(`${n} messages replaced by placeholders`);
      // Placeholders and the closing message are thread-body messages: replies
      // to the root (D87).
      expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
    }
  });

  test("S39 The root message is created before any copy (thread-creation.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });

    await ctx.pickChat(CHATS.source);
    const mark = ctx.mark();
    await ctx.sendTitle("Lunch");

    const calls = ctx.callsSince(mark);
    expect(calls.length, "the transfer must produce API calls").toBeGreaterThan(0);
    expect(calls[0].method, "the first API call of the transfer is the root send").toBe("sendMessage");
    expect(calls[0].payload.text, "the root message is 'Lunch'").toBe("Lunch");
    // D87: a thread-body post is a reply to the root (or, on the superseded
    // buggy path, carries message_thread_id) — either assembly counts here.
    const copyIdx = calls.findIndex(
      (c) =>
        /^copy/.test(c.method) ||
        (c.method === "sendMessage" && (ctx.isThreadBodyCall(c) || c.payload.message_thread_id != null)),
    );
    expect(copyIdx, "copies are posted afterwards").toBeGreaterThan(0);
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S40 A failure while posting copies deletes nothing in the source chat (thread-creation.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });
    ctx.failNthCopyPost(2, { error_code: 400, description: "Bad Request: copy failed" });

    await ctx.pickChat(CHATS.source);
    const mark = ctx.mark();
    await ctx.sendTitle("Lunch");

    expect(ctx.lastFailedCallIndex, "the second copy post must actually fail").toBeGreaterThanOrEqual(0);
    const afterFailure = ctx.callsSince(ctx.lastFailedCallIndex + 1);
    expect(
      afterFailure.filter((c) => c.method === "sendMessage" && c.payload.chat_id === CHATS.threads.id).length,
      "the bot replies with a localized failure message in the threads chat",
    ).toBeGreaterThan(0);
    // D87: the successful copy and the failure report are thread-body messages
    // of the created thread — both are replies to the root (title message).
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
    expect(ctx.deletedIds(CHATS.source.id), "no message of the source chat is deleted (AC14)").toEqual([]);
    expect(
      ctx.api.callsOf("sendMessage").filter((c) => c.payload.chat_id === CHATS.source.id),
      "no announce is posted in the source chat",
    ).toEqual([]);
  });

  test("S41 A failed attempt stores no mapping and the same batch can be transferred again (thread-creation.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });

    // Given: a previous transfer of the batch failed while posting the copies.
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });
    ctx.failNthCopyPost(2, { error_code: 400, description: "Bad Request: copy failed" });
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.deletedIds(CHATS.source.id), "the failed attempt deletes nothing").toEqual([]);

    // When: the same messages are forwarded again and the dialog completed.
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });
    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    const posts = postsSince(ctx, mark);
    expect(postTexts(posts)[0], "a thread is created completely (root)").toBe("Lunch");
    expect(ctx.copyMarkerSeq(CHATS.threads.id).slice(-2), "the copies are posted").toEqual([10, 11]);
    expect(
      ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
      "the closing message completes the thread",
    ).toBe(true);
    // D87: the retried copies and the closing message are replies to the root.
    expectBodyRepliesToRoot(ctx, posts.slice(1));
    expect(
      ctx.deletedIds(CHATS.source.id).slice().sort((a, b) => a - b),
      "the originals are deleted exactly once",
    ).toEqual([10, 11]);
  });
});
