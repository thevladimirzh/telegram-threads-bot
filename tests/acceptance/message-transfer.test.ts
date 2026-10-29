/**
 * Acceptance tests — tests/features/message-transfer.feature (S42–S48).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S42 -> ACC-15, ACC-8 -> R15, R8, R62
 *   S43 -> ACC-8, ACC-16 -> R8, R21, R62
 *   S44 -> ACC-16, ACC-8 -> R20, R21, R8, R62
 *   S45 -> ACC-16        -> R20, R21, R62
 *   S46 -> ACC-20        -> R41, R62
 *   S47 -> ACC-20        -> R43, R62
 *   S48 -> ACC-8         -> R8, R62
 *
 * Copy mechanism (harness convention 10): `copyMessage`/`copyMessages` or
 * `sendMessage` with the copied text are both accepted — the assertions are
 * black-box on what reaches the thread (markers normalize both).
 * D87 (iteration 2): every copy and placeholder is a thread-body message —
 * a REPLY to the title message (root id 42); `message_thread_id` is never used
 * for thread assembly (the old behaviour is the reported bug).
 * D88 (iteration 2): albums are copied PER ITEM (one post per item, contiguous,
 * in source order, each a reply to the root) — media-group grouping is
 * intentionally lost (`copyMessages` cannot reply); per-item copy usage itself
 * is NOT asserted, only its observable consequences.
 * Placeholders (D27, exact): `[poll] {question}`, `[service] {service_event_type}`,
 * `[unsupported] {content_type}`.
 */
import { afterEach, describe, expect, test } from "vitest";
import { CHATS, USERS, boot, cleanup, type Ctx, type ThreadPost } from "./harness";

async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.threads]);
  await ctx.userIsAdminOf(USERS.author, [CHATS.source]);
  await ctx.connectSource(CHATS.source);
  await ctx.connectThreads(CHATS.threads);
  ctx.resetCalls();
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

describe("message-transfer.feature — copying the forwarded messages into the thread", () => {
  test("S42 Copies are sent as bot messages without author attribution (message-transfer.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    expect(
      ctx.api.calls.filter((c) => /^copy/.test(c.method)).length +
        ctx.threadPosts(CHATS.threads.id).filter((p) => p.kind === "text" && p.text === "text-10").length,
      "the copy is posted as a new message of the bot (non-vacuous)",
    ).toBeGreaterThan(0);
    expect(ctx.api.callsOf("forwardMessage"), "the copy is never a forward").toEqual([]);
    // S42: "each copy is a reply to the title message" (D87).
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));

    const names = ["Alice", "Authorson", "author_user"];
    for (const post of ctx.threadPosts(CHATS.threads.id)) {
      const text = post.kind === "text" ? post.text : String(post.call.payload.caption ?? "");
      for (const name of names) {
        expect(text.includes(name), `a copy carries the author's name '${name}': ${text}`).toBe(false);
      }
    }
  });

  test("S43 The order of the forwarded messages is preserved in the thread (message-transfer.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00" });
    await ctx.observe({ chat: CHATS.source, id: 12, at: "10:02:00" });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11, 12], into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    expect(ctx.copyMarkerSeq(CHATS.threads.id), "the copies appear in the source order").toEqual([10, 11, 12]);
    // S43: "each copy is a reply to the title message" (D87).
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S44 An album is copied as a contiguous group in source order (message-transfer.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({
      chat: CHATS.source,
      id: 20,
      at: "10:00:00",
      content: { kind: "photo", caption: "Album 20", fileId: "ph20" },
      mediaGroupId: "grp1",
    });
    await ctx.observe({
      chat: CHATS.source,
      id: 21,
      at: "10:00:01",
      content: { kind: "photo", caption: "Album 21", fileId: "ph21" },
      mediaGroupId: "grp1",
    });
    await ctx.forwardMany({ chat: CHATS.source, ids: [20, 21], into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    const seq = ctx.copyMarkerSeq(CHATS.threads.id);
    expect(seq, "the album copies are adjacent and in the source order").toEqual([20, 21]);
    // D88: the album is copied PER ITEM (observable: one thread post per item;
    // media-group grouping is intentionally lost) and each copy is a reply to
    // the title message (D87).
    const body = ctx.bodyPostsSince(CHATS.threads.id, mark);
    const itemPosts = body.filter((p) => ctx.postMarkers(p).some((m) => m === 20 || m === 21));
    expect(itemPosts.length, "the album is copied per item — one post per item (D88)").toBe(2);
    for (const p of itemPosts) {
      expect(ctx.postMarkers(p).length, "each album item is copied as its own post (D88)").toBe(1);
    }
    expectBodyRepliesToRoot(ctx, body);
  });

  test("S45 Album updates arriving split and out of order are grouped by their album id (message-transfer.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    // The bot observes 21 first, 20 second — the album arrives split/out of order.
    await ctx.observe({
      chat: CHATS.source,
      id: 21,
      at: "10:00:01",
      content: { kind: "photo", caption: "Album 21", fileId: "ph21" },
      mediaGroupId: "grp1",
    });
    await ctx.observe({
      chat: CHATS.source,
      id: 20,
      at: "10:00:00",
      content: { kind: "photo", caption: "Album 20", fileId: "ph20" },
      mediaGroupId: "grp1",
    });
    await ctx.forwardMany({ chat: CHATS.source, ids: [20, 21], into: CHATS.threads });
    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    const seq = ctx.copyMarkerSeq(CHATS.threads.id);
    expect(seq, "the album copies are adjacent in the source order despite split arrival").toEqual([20, 21]);
    // D88: the album is copied PER ITEM (one thread post per item; grouping is
    // intentionally lost) and each copy is a reply to the title message (D87).
    const body = ctx.bodyPostsSince(CHATS.threads.id, mark);
    const itemPosts = body.filter((p) => ctx.postMarkers(p).some((m) => m === 20 || m === 21));
    expect(itemPosts.length, "the album is copied per item — one post per item (D88)").toBe(2);
    for (const p of itemPosts) {
      expect(ctx.postMarkers(p).length, "each album item is copied as its own post (D88)").toBe(1);
    }
    expectBodyRepliesToRoot(ctx, body);
  });

  test("S46 Non-transferable content is replaced by an exact placeholder (message-transfer.feature)", async () => {
    for (const [kind, content, placeholder] of [
      ["poll", { kind: "poll", question: "Lunch?" } as const, "[poll] Lunch?"],
      ["service", { kind: "service", serviceEventType: "message_chat_join_by_link" } as const, "[service] message_chat_join_by_link"],
      ["invoice", { kind: "invoice" } as const, "[unsupported] invoice"],
    ] as const) {
      const ctx = await boot();
      await background(ctx);
      await ctx.observe({ chat: CHATS.source, id: 40, at: "10:00:00", content: content as any });
      await ctx.forward({ chat: CHATS.source, id: 40, into: CHATS.threads });

      const mark = ctx.mark();
      await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
      expect(
        ctx.hasExactText(CHATS.threads.id, placeholder),
        `the thread must contain the exact placeholder '${placeholder}'`,
      ).toBe(true);
      expect(
        ctx.api.calls.filter((c) => /^copy/.test(c.method) && (c.payload.message_id === 40 || (c.payload.message_ids as number[] | undefined)?.includes(40))),
        `${kind}: the placeholder replaces the copy`,
      ).toEqual([]);
      // D87: the placeholder and the closing message are thread-body messages —
      // replies to the title message (root id 42).
      expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
    }
  });

  test("S47 A reply inside the batch is copied as a plain message (message-transfer.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00" });
    await ctx.observe({ chat: CHATS.source, id: 11, at: "10:01:00", replyTo: 10 });
    await ctx.forwardMany({ chat: CHATS.source, ids: [10, 11], into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });

    for (const post of ctx.threadPosts(CHATS.threads.id)) {
      const replyTo = ctx.replyToOf(post.call);
      expect(
        replyTo === 10 || replyTo === 11,
        `a copy must carry no reply reference into the source chat (got ${replyTo})`,
      ).toBe(false);
    }
    expect(
      ctx.texts(CHATS.threads.id).some((t) => t.includes("moved from")),
      "the transfer does not fail (the thread is completed)",
    ).toBe(true);
    // D87: the copies of the reply and the closing message reply to the root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });

  test("S48 A text message is copied with its text verbatim (message-transfer.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    await ctx.observe({ chat: CHATS.source, id: 10, at: "10:00:00", content: { kind: "text", text: "Hello, world!" } });
    await ctx.forward({ chat: CHATS.source, id: 10, into: CHATS.threads });

    const mark = ctx.mark();
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch" });
    const copied =
      ctx.copyMarkerSeq(CHATS.threads.id).includes(10) || ctx.hasExactText(CHATS.threads.id, "Hello, world!");
    expect(copied, "the thread contains a copy with the text 'Hello, world!'").toBe(true);
    // D87: the copy and the closing message are replies to the root.
    expectBodyRepliesToRoot(ctx, ctx.bodyPostsSince(CHATS.threads.id, mark));
  });
});
