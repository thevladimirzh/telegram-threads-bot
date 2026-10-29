/**
 * Acceptance tests — tests/features/i18n.feature (S76–S79).
 *
 * Scenario map -> planned test IDs (docs/risk-register.md) -> risks:
 *   S76 -> ACC-12 -> R12, R63   (the closing message is located by its D89
 *                                announce link `https://t.me/c/{internal_chat_id}/
 *                                {announce_message_id}` — never by a bare
 *                                `t.me/{username}` / `t.me/c/{id}` form)
 *   S77 -> ACC-12 -> R12
 *   S78 -> ACC-30 -> R47
 *   S79 -> ACC-30 -> R46
 *
 * Locale is the initiator's (D26); the thread URL is appended verbatim and
 * never localized (D77 scenario wording). Exact strings are en-only (D72) —
 * the ru assertions check "is Russian" (Cyrillic) and "is not the English
 * form" instead of pinning unlisted wording.
 */
import { afterEach, describe, expect, test } from "vitest";
import {
  CHATS,
  USERS,
  announceCallIn,
  boot,
  cleanup,
  hasCyrillic,
  hasRawCatalogId,
  hasUnresolvedPlaceholder,
  type Ctx,
  type UserFixture,
} from "./harness";

async function background(ctx: Ctx): Promise<void> {
  await ctx.botIsAdminOf([CHATS.source, CHATS.threads]);
  await ctx.userIsAdminOf(USERS.author, [CHATS.source]);
  await ctx.connectSource(CHATS.source);
  await ctx.connectThreads(CHATS.threads);
  ctx.resetCalls();
}

function userWithLocale(locale: string): UserFixture {
  return { ...USERS.author, language_code: locale };
}

afterEach(cleanup);

describe("i18n.feature — localization of all user-facing strings", () => {
  test("S76 Every message of a transfer uses the initiator's locale (i18n.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    const author = userWithLocale("ru");
    await ctx.userIsAdminOf(author, [CHATS.source]);
    await ctx.observe({ chat: CHATS.source, from: author, id: 10, at: "10:00:00" });
    await ctx.forward({ user: author, chat: CHATS.source, id: 10, into: CHATS.threads });
    await ctx.completeDialog({ chat: CHATS.source, title: "Lunch", as: author });

    const prompt = ctx.api
      .callsOf("sendMessage")
      .find((c) => c.payload.chat_id === CHATS.threads.id && (c.payload.reply_markup as any)?.inline_keyboard);
    expect(prompt, "the dialog prompt is sent").toBeDefined();
    const promptText = String(prompt!.payload.text ?? "");
    expect(hasCyrillic(promptText), "the dialog prompt is in Russian").toBe(true);

    // D89 (R63): the closing message links to the announce message —
    // `https://t.me/c/{internal_chat_id}/{announce_message_id}` (uniform for
    // public and private chats; the bare `t.me/{username}` / `t.me/c/{id}`
    // closing forms are dropped). The announce id is not stubbed here — the
    // lookup uses the id of the announce message actually sent.
    const announceCall = announceCallIn(ctx, CHATS.source.id);
    expect(announceCall, "the announce is sent in the source chat").toBeDefined();
    const closing = ctx
      .texts(CHATS.threads.id)
      .find((t) => t.includes(`https://t.me/c/200000000000001/${ctx.messageIdOf(announceCall!)}`));
    expect(closing, "the closing message is sent and links to the announce message (D89)").toBeDefined();
    expect(hasCyrillic(closing!), "the closing message is in Russian").toBe(true);
    expect(closing!.includes("moved from"), "the closing message is not in English").toBe(false);

    const announce = ctx.texts(CHATS.source.id).find((t) => t.includes("https://t.me/threads_chat/42?thread=42"));
    expect(announce, "the announce is sent with the verbatim URL").toBeDefined();
    expect(hasCyrillic(announce!), "the announce is in Russian").toBe(true);
    expect(announce!.includes("Thread created"), "the announce is not in English").toBe(false);

    for (const t of ctx.texts()) {
      expect(t.includes("Thread created") || t.includes("moved from"), `bot message is in English: ${t}`).toBe(false);
    }
  });

  test("S77 The thread URL is appended verbatim and never localized (i18n.feature)", async () => {
    for (const locale of ["en", "ru"] as const) {
      const ctx = await boot();
      await background(ctx);
      const author = userWithLocale(locale);
      await ctx.userIsAdminOf(author, [CHATS.source]);
      await ctx.observe({ chat: CHATS.source, from: author, id: 10, at: "10:00:00" });
      await ctx.forward({ user: author, chat: CHATS.source, id: 10, into: CHATS.threads });
      // "the next message created by the bot gets the id 42" (sendTitle stub).
      await ctx.completeDialog({ chat: CHATS.source, title: "Lunch", as: author });

      const announce = ctx
        .texts(CHATS.source.id)
        .find((t) => t.includes("https://t.me/threads_chat/42?thread=42"));
      expect(announce, `locale ${locale}: the announce contains the exact thread URL`).toBeDefined();
    }
  });

  test("S78 An unknown language code falls back to English (i18n.feature)", async () => {
    const ctx = await boot();
    await background(ctx);
    const author = userWithLocale("de");
    await ctx.userIsAdminOf(author, [CHATS.source]);
    await ctx.observe({ chat: CHATS.source, from: author, id: 10, at: "10:00:00" });
    await ctx.forward({ user: author, chat: CHATS.source, id: 10, into: CHATS.threads });

    const prompt = ctx.api
      .callsOf("sendMessage")
      .find((c) => c.payload.chat_id === CHATS.threads.id && (c.payload.reply_markup as any)?.inline_keyboard);
    expect(prompt, "the dialog prompt is sent").toBeDefined();
    const promptText = String(prompt!.payload.text ?? "");
    expect(promptText.length, "the dialog prompt is in English (non-empty)").toBeGreaterThan(0);
    expect(hasCyrillic(promptText), "the dialog prompt falls back to English").toBe(false);
  });

  test("S79 User-visible replies never contain raw catalog identifiers (i18n.feature)", async () => {
    const texts: string[] = [];
    for (const locale of ["en", "ru"] as const) {
      const ctx = await boot();
      const admin = { ...USERS.admin, language_code: locale };
      const author = userWithLocale(locale);
      await ctx.botIsAdminOf([CHATS.source, CHATS.threads]);
      await ctx.userIsAdminOf(author, [CHATS.source]);
      await ctx.pressSettingsButton(CHATS.source, "source", admin);
      await ctx.pressSettingsButton(CHATS.threads, "threads", admin);
      ctx.resetCalls();
      await ctx.observe({ chat: CHATS.source, from: author, id: 10, at: "10:00:00" });
      await ctx.forward({ user: author, chat: CHATS.source, id: 10, into: CHATS.threads });
      await ctx.completeDialog({ chat: CHATS.source, title: "Lunch", as: author });
      texts.push(...ctx.texts());
    }
    expect(texts.length, "the whole flow must produce bot messages (non-vacuous)").toBeGreaterThan(0);
    for (const t of texts) {
      expect(t.includes("settings.title"), `raw catalog identifier in: ${t}`).toBe(false);
      expect(hasRawCatalogId(t), `raw catalog identifier in: ${t}`).toBe(false);
      expect(hasUnresolvedPlaceholder(t), `unresolved message placeholder in: ${t}`).toBe(false);
    }
  });
});
