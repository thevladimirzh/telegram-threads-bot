/**
 * Bot wiring and all handlers (plan §7.3, decisions D1–D82).
 *
 * `createBot(deps)` returns a grammY `Bot` with every handler registered;
 * tests attach the fake Bot API (`bot.api.config.use(api.transformer)`) and
 * drive updates with `bot.handleUpdate`. Determinism: all time comes from
 * `deps.now`, `retry_after` waits use promise-based `setTimeout` delays (D78)
 * and there is no network or database access beyond the injected `store`.
 *
 * User-facing strings all go through i18n (src/i18n); `parse_mode` is never
 * used (D75) and `bot.catch` guarantees `handleUpdate` never throws (D76).
 */
import { Bot, type Context } from "grammy";
import type { AppConfig } from "../config.js";
import { createI18n, defaultLocale, locales, type Locale } from "../i18n/index.js";
import type {
  ChatRecord,
  ContentRecord,
  DraftMessageRecord,
  DraftRecord,
  SourceMessageRecord,
  Store,
} from "../store/types.js";
import { groupEntities, isDifferentSourceChat, truncateEntities, type Entity } from "../domain/batch.js";
import { isTransferable, messageContent, placeholderText } from "../domain/content.js";
import { chunkIds, classifyDeleteError, retryAfterMs, type DeleteClass } from "../domain/deletion.js";
import { chatLinkSegment, movedFromValue, threadUrl } from "../domain/links.js";
import { matchOriginal, type MatchOutcome } from "../domain/matcher.js";
import { validateTitle } from "../domain/title.js";

export interface Logger {
  fatal(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  trace(...args: unknown[]): void;
}

export interface BotDeps {
  store: Store;
  now: () => Date;
  logger: Logger;
  config: AppConfig;
}

interface DiscoveredChat {
  id: number;
  type: string;
  title: string;
  username?: string;
  isForum: boolean;
}

const SETTINGS_ACTION = /^set:(connect|threads|disconnect):(-?\d+):(\d+)$/;
const SETTINGS_LANG = /^set:lang:(en|ru)$/;
const DIALOG_CHAT = /^dlg:chat:(-?\d+):(\d+)(:sel)?$/;

export function createBot(deps: BotDeps): Bot {
  const { store, now, logger, config } = deps;
  const bot = new Bot(config.botToken);

  /** D79: chats the bot observes (message + my_chat_member updates). */
  const discovered = new Map<number, DiscoveredChat>();
  /**
   * S7/D79: the bot's own membership per chat. Authoritative source is the
   * `my_chat_member` update (`new_chat_member.status`); when a chat was only
   * seen in message updates, one `getChatMember` probe is made and cached —
   * `/settings` renders must never re-probe chats whose status is known
   * (acceptance S7: "the created thread must stay untouched").
   */
  const botMembership = new Map<number, boolean>();

  bot.catch((error) => {
    // Never log raw error objects: grammY errors can embed the request URL
    // with the bot token (R55). Log only the error class.
    logger.error({ event: "bot_error", error: error instanceof Error ? error.name : "unknown" });
  });

  // ----------------------------- helpers ---------------------------------

  const nowMs = (): number => now().getTime();

  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function localeOf(userId: number | undefined, languageCode: unknown): Locale {
    const stored = userId !== undefined ? store.getUser(userId)?.locale : undefined;
    const candidate = stored ?? (typeof languageCode === "string" ? languageCode : "");
    return (locales as readonly string[]).includes(candidate) ? (candidate as Locale) : defaultLocale;
  }

  function t(locale: Locale, id: string, values?: Record<string, unknown>): string {
    return createI18n(locale)._(id, values as never);
  }

  function recordDiscovery(chat: unknown): DiscoveredChat | undefined {
    const raw = chat as { id?: unknown; type?: unknown; title?: unknown; username?: unknown; is_forum?: unknown } | null;
    if (!raw || typeof raw.id !== "number") return undefined;
    const existing = discovered.get(raw.id);
    if (existing) return existing;
    const record: DiscoveredChat = {
      id: raw.id,
      type: typeof raw.type === "string" ? raw.type : "supergroup",
      title:
        typeof raw.title === "string"
          ? raw.title
          : typeof raw.username === "string"
            ? raw.username
            : String(raw.id),
      ...(typeof raw.username === "string" ? { username: raw.username } : {}),
      isForum: raw.is_forum === true,
    };
    discovered.set(record.id, record);
    return record;
  }

  function chatInfo(chatId: number): { id: number; username?: string } {
    const username = store.getChat(chatId)?.username ?? discovered.get(chatId)?.username;
    return { id: chatId, ...(username !== undefined ? { username } : {}) };
  }

  function chatTitle(chatId: number, fallback: string): string {
    return store.getChat(chatId)?.title ?? discovered.get(chatId)?.title ?? fallback;
  }

  function threadsChat(): ChatRecord | undefined {
    return store.listChats().find((chat) => chat.threads);
  }

  function sourceChats(): ChatRecord[] {
    return store.listChats().filter((chat) => chat.source);
  }

  function isGlobalAdmin(userId: number | undefined): boolean {
    return typeof userId === "number" && config.adminIds.includes(userId);
  }

  /** The bot's own user id (from `getMe` via `bot.init()`). */
  function botId(): number {
    try {
      return bot.botInfo.id;
    } catch {
      return 0;
    }
  }

  /**
   * S7/D79: is the bot an admin of `chatId`? Known `my_chat_member` status
   * wins; otherwise one cached `getChatMember` probe (harmless read-only call).
   */
  async function botIsAdminIn(chatId: number): Promise<boolean> {
    const known = botMembership.get(chatId);
    if (known !== undefined) return known;
    let admin = false;
    try {
      const member = await bot.api.getChatMember(chatId, botId());
      admin = member.status === "administrator" || member.status === "creator";
    } catch {
      admin = false;
    }
    botMembership.set(chatId, admin);
    return admin;
  }

  /**
   * S6/S19/S5 (D46/D33): may a forwarded batch name `chatId` as its source?
   * Eligible = a connected source chat (D11) or a chat whose `my_chat_member`
   * status is a known admin (S6: works before the chat is connected) — but
   * never the threads chat itself. Unknown membership is NOT eligible (S19:
   * a chat the bot has no admin signal for is refused).
   */
  async function originAllowed(chatId: number): Promise<boolean> {
    const threads = threadsChat();
    if (threads?.chatId === chatId) return false; // D33
    const record = store.getChat(chatId);
    if (record?.threads) return false;
    if (record?.source) return true;
    return botMembership.get(chatId) === true;
  }

  async function send(
    chatId: number,
    text: string,
    other?: Record<string, unknown>,
  ): Promise<{ message_id: number } | undefined> {
    try {
      return (await bot.api.sendMessage(chatId, text, other as never)) as unknown as { message_id: number };
    } catch (error) {
      logger.error({ event: "send_failed", error: error instanceof Error ? error.name : "unknown" });
      return undefined;
    }
  }

  async function replyTo(ctx: Context, text: string): Promise<void> {
    const chatId = (ctx.message ?? ctx.callbackQuery?.message)?.chat?.id;
    if (typeof chatId !== "number") return;
    await send(chatId, text);
  }

  /** D78: retry only `retry_after` (429) failures, waiting as instructed. */
  async function withRetry429<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const wait = retryAfterMs(error);
        if (wait === undefined || attempt >= 3) throw error;
        logger.warn({ event: "retry_after", waitMs: wait });
        await delay(wait);
      }
    }
  }

  // --------------------------- message index ------------------------------

  function indexMessage(msg: Record<string, unknown>): void {
    const chat = msg.chat as { id?: unknown } | null;
    if (!chat || typeof chat.id !== "number") return;
    const record = store.getChat(chat.id);
    if (!record?.source) return; // SEC-13/R60: unconnected chats are inert
    const messageId = msg.message_id;
    if (typeof messageId !== "number") return;
    const from = msg.from as { id?: unknown } | null;
    const threadId = msg.message_thread_id;
    const previous = store.getSourceMessage(chat.id, messageId);
    store.indexSourceMessage({
      chatId: chat.id,
      messageId,
      date: typeof msg.date === "number" ? msg.date : 0,
      senderId: from && typeof from.id === "number" ? from.id : null,
      content: messageContent(msg),
      ...(typeof threadId === "number" ? { messageThreadId: threadId } : {}),
      ...(previous?.threadId !== undefined ? { threadId: previous.threadId } : {}),
    });
  }

  // ------------------------------ drafts ----------------------------------

  interface DraftView extends DraftRecord {
    key: { threadsChatId: number; authorId: number };
  }

  function getDraft(threadsChatId: number, authorId: number): DraftView | undefined {
    const draft = store.getDraft({ threadsChatId, authorId });
    return draft ? { ...draft, key: { threadsChatId, authorId } } : undefined;
  }

  function stripKey(draft: DraftView): DraftRecord {
    const { key: _key, ...record } = draft;
    return record;
  }

  function isExpired(draft: DraftRecord): boolean {
    return nowMs() - draft.openedAt >= config.draftTimeoutMs;
  }

  function preselectionOf(batch: DraftMessageRecord[]): number | null {
    const named = batch.map((msg) => msg.originChatId).filter((id): id is number => id !== null);
    if (named.length === 0) return null;
    const first = named[0];
    if (named.every((id) => id === first)) {
      const chat = store.getChat(first);
      if (chat?.source && !chat.threads) return first; // D66
    }
    return null;
  }

  // ------------------------------ dialog ----------------------------------

  async function dialogKeyboard(batch: DraftMessageRecord[], preselected: number | null): Promise<Record<string, unknown>> {
    const rows: Array<Array<Record<string, string>>> = [];
    const row: Array<Record<string, string>> = [];
    const threadsId = threadsChat()?.chatId;
    // Candidates: connected source chats (D11) plus the batch's own origin
    // chats that are eligible (S6: an admin chat works before it is connected).
    const candidates: number[] = [];
    for (const chat of sourceChats()) {
      if (!chat.threads && chat.chatId !== threadsId) candidates.push(chat.chatId);
    }
    for (const msg of batch) {
      const id = msg.originChatId;
      if (id !== null && !candidates.includes(id) && (await originAllowed(id))) candidates.push(id);
    }
    for (const chatId of candidates) {
      const segment = chatLinkSegment(chatId);
      const selected = preselected !== null && chatId === preselected;
      const title = chatTitle(chatId, String(chatId));
      row.push({
        text: selected ? `✓ ${title}` : title,
        callback_data: `dlg:chat:${chatId}:${segment}${selected ? ":sel" : ""}`,
      });
    }
    if (row.length > 0) rows.push(row);
    return { inline_keyboard: rows };
  }

  function dialogSummary(locale: Locale, draft: DraftRecord): string {
    const chats = new Set(draft.batch.map((msg) => msg.originChatId).filter((id) => id !== null));
    const entities = groupEntities(draft.batch);
    const { droppedMessages } = truncateEntities(entities, config.batchLimit);
    return t(locale, "dialog.summary", {
      count: draft.batch.length,
      chats: chats.size || 1,
      dropped: droppedMessages,
    });
  }

  function draftMessage(msg: Record<string, unknown>): DraftMessageRecord {
    const origin = (msg.forward_origin ?? {}) as Record<string, any>;
    const originChatId =
      typeof origin.chat?.id === "number"
        ? origin.chat.id
        : typeof origin.sender_chat?.id === "number"
          ? origin.sender_chat.id
          : null;
    const senderId =
      typeof origin.sender_user?.id === "number"
        ? origin.sender_user.id
        : typeof origin.sender_chat?.id === "number"
          ? origin.sender_chat.id
          : null;
    const content: ContentRecord = messageContent(msg);
    const mediaGroupId = typeof msg.media_group_id === "string" ? msg.media_group_id : undefined;
    return {
      forwardId: Number(msg.message_id),
      originChatId,
      originDate: typeof origin.date === "number" ? origin.date : 0,
      senderId,
      content,
      ...(mediaGroupId !== undefined ? { mediaGroupId } : {}),
    };
  }

  function titleForOrigin(origin: Record<string, any>, originChatId: number | null): string {
    const title = origin.chat?.title ?? origin.sender_chat?.title;
    if (typeof title === "string") return title;
    return originChatId !== null ? chatTitle(originChatId, String(originChatId)) : "?";
  }

  async function handleForward(ctx: Context, msg: Record<string, unknown>): Promise<void> {
    const threads = threadsChat();
    if (!threads) return;
    const from = msg.from as { id?: unknown; language_code?: unknown } | null;
    const authorId = from && typeof from.id === "number" ? from.id : undefined;
    if (authorId === undefined) return;
    const locale = localeOf(authorId, from?.language_code);
    const chatId = threads.chatId;
    const forwardId = Number(msg.message_id);

    const origin = (msg.forward_origin ?? {}) as Record<string, any>;
    const originChatId: number | null =
      typeof origin.chat?.id === "number"
        ? origin.chat.id
        : typeof origin.sender_chat?.id === "number"
          ? origin.sender_chat.id
          : null;
    if (originChatId !== null && !(await originAllowed(originChatId))) {
      // D46/S19: a forward from a chat that can never be a source (S5: the
      // threads chat itself; S19: a chat where the bot is not an admin) is
      // refused with a clear message.
      await send(chatId, t(locale, "dialog.notConnected", { title: titleForOrigin(origin, originChatId) }), {
        reply_to_message_id: forwardId,
      });
      return;
    }

    const key = { threadsChatId: chatId, authorId };
    const incoming = draftMessage(msg);
    let draft = getDraft(chatId, authorId);

    if (draft) {
      if (isExpired(draft)) {
        store.removeDraft(key);
        await send(chatId, t(locale, "dialog.timeout"), { reply_to_message_id: forwardId });
        draft = undefined;
      } else {
        // D68 (final)/D84: a forward from a different connected source chat
        // re-opens the dialog — the title/chat selection is cleared and a NEW
        // dialog message (chat buttons + title request) is posted. The same or
        // an unnamed source chat JOINS the batch in place (AC2/D31/D64): no
        // second dialog message, no refusal. The messages of the replaced chat
        // stay in the batch as D16 mixed-batch material — acceptance S64 pins
        // this (see tests/unit/draft-batch.test.ts).
        const reopen = isDifferentSourceChat(draft.batch, incoming.originChatId);
        draft.batch.push(incoming);
        if (reopen) {
          draft.pickedChatId = null;
          delete draft.pickedAuthorized;
          draft.preselectedChatId = preselectionOf(draft.batch);
          store.saveDraft(stripKey(draft));
          const dialog = await send(chatId, t(locale, "dialog.prompt"), {
            reply_to_message_id: forwardId,
            reply_markup: await dialogKeyboard(draft.batch, draft.preselectedChatId),
          });
          if (dialog) {
            draft.dialogMessageId = dialog.message_id;
            store.saveDraft(stripKey(draft));
          }
          return;
        }
        draft.preselectedChatId = preselectionOf(draft.batch);
        store.saveDraft(stripKey(draft));
        await send(chatId, t(locale, "dialog.batchJoined", { count: draft.batch.length }), {
          reply_to_message_id: forwardId,
        });
        if (draft.dialogMessageId !== undefined) {
          try {
            await bot.api.editMessageText(chatId, draft.dialogMessageId, dialogSummary(locale, draft));
          } catch {
            // stale dialog message: keep going
          }
        }
        return;
      }
    }

    const created: DraftRecord = {
      threadsChatId: chatId,
      authorId,
      openedAt: nowMs(),
      batch: [incoming],
      pickedChatId: null,
      preselectedChatId: preselectionOf([incoming]),
    };
    store.saveDraft(created);
    const dialog = await send(chatId, t(locale, "dialog.prompt"), {
      reply_to_message_id: forwardId,
      reply_markup: await dialogKeyboard(created.batch, created.preselectedChatId),
    });
    if (dialog) {
      created.dialogMessageId = dialog.message_id;
      store.saveDraft(created);
    }
  }

  // ---------------------------- draft answers -----------------------------

  /** SEC-4: with no explicit pick, the source chat can come from the matches. */
  function uniqueMatchedChat(batch: DraftMessageRecord[]): number | null {
    const chats = new Set<number>();
    for (const chat of sourceChats()) {
      const index = store.listSourceMessages(chat.chatId);
      if (batch.some((msg) => matchOriginal(msg, index).kind === "unique")) chats.add(chat.chatId);
    }
    return chats.size === 1 ? [...chats][0] : null;
  }

  async function isSourceAdmin(chatId: number, userId: number): Promise<boolean> {
    try {
      const member = await bot.api.getChatMember(chatId, userId);
      return member.status === "administrator" || member.status === "creator";
    } catch {
      return false;
    }
  }

  async function handleDraftText(ctx: Context, msg: Record<string, unknown>): Promise<void> {
    const threads = threadsChat();
    if (!threads) return;
    const from = msg.from as { id?: unknown; language_code?: unknown } | null;
    const authorId = from && typeof from.id === "number" ? from.id : undefined;
    if (authorId === undefined) return;
    const locale = localeOf(authorId, from?.language_code);

    const draft = getDraft(threads.chatId, authorId);
    if (!draft) return; // ordinary chat traffic (D17: foreign answers are ignored)
    if (draft.authorId !== authorId) return;

    if (isExpired(draft)) {
      store.removeDraft(draft.key);
      await replyTo(ctx, t(locale, "dialog.timeout"));
      return;
    }

    const raw = typeof msg.text === "string" ? msg.text : "";
    const title = validateTitle(raw);
    if (!title.ok) {
      await replyTo(ctx, t(locale, "dialog.invalidTitle"));
      return;
    }

    const picked = draft.pickedChatId ?? draft.preselectedChatId ?? uniqueMatchedChat(draft.batch);
    if (picked === null) {
      await replyTo(ctx, t(locale, "dialog.pickFirst"));
      return;
    }

    if (!draft.pickedAuthorized) {
      const allowed = await isSourceAdmin(picked, authorId);
      if (!allowed) {
        await replyTo(ctx, t(locale, "transfer.refusedNotAdmin", { title: chatTitle(picked, "?") }));
        return;
      }
    }

    store.removeDraft(draft.key);
    await executeTransfer(draft, picked, title.title, locale);
  }

  // ----------------------------- transfer ---------------------------------

  async function executeTransfer(
    draft: DraftView,
    chatId: number,
    title: string,
    locale: Locale,
  ): Promise<void> {
    const threads = threadsChat();
    if (!threads) return;
    const threadsChatId = threads.chatId;
    const threadsRef = chatInfo(threadsChatId);

    // D16: only the chosen chat's messages are transferred.
    const selected = draft.batch.filter((msg) => msg.originChatId === null || msg.originChatId === chatId);
    const entities = groupEntities(selected);
    const truncation = truncateEntities(entities, config.batchLimit);
    const kept: Entity[] = truncation.kept;
    const index = store.listSourceMessages(chatId);
    const matches = new Map<number, MatchOutcome>();
    for (const msg of selected) matches.set(msg.forwardId, matchOriginal(msg, index));

    // D42/D65: duplicate check over the whole batch, before any side effect.
    const mapped = selected
      .map((msg) => matches.get(msg.forwardId))
      .filter((m): m is Extract<MatchOutcome, { kind: "unique" }> => m !== undefined && m.kind === "unique")
      .filter((m) => m.original.threadId !== undefined);
    if (mapped.length > 0) {
      const existing = mapped
        .map((m) => store.getThread(m.original.threadId as number))
        .filter((thread): thread is NonNullable<typeof thread> => thread !== undefined)
        .sort((a, b) => a.createdAt - b.createdAt || a.threadId - b.threadId)[0];
      if (existing) {
        await send(
          threadsChatId,
          t(locale, "transfer.duplicate", {
            title: existing.title,
            url: threadUrl(chatInfo(existing.threadsChatId), existing.rootMessageId),
          }),
        );
        logger.info({ event: "transfer_refused_duplicate", chatId, authorId: draft.authorId });
        return;
      }
    }

    // 1. root message (= thread root) — S39: the first API call of the transfer.
    let rootId: number;
    try {
      const root = (await bot.api.sendMessage(threadsChatId, title)) as unknown as { message_id: number };
      rootId = root.message_id;
    } catch (error) {
      logger.error({ event: "root_send_failed", error: error instanceof Error ? error.name : "unknown" });
      await send(threadsChatId, t(locale, "transfer.failure"));
      return;
    }

    // D87: every thread-body message is a REPLY to the thread root (the title
    // message). `message_thread_id` is never used for thread assembly — it is
    // ignored outside forum topics (that was the reported bug).
    const replyToRoot = { reply_parameters: { message_id: rootId } };

    // 2. copies (+ placeholders) in forward order; albums copy per item (D88:
    //    contiguous and in source order — media-group grouping is lost because
    //    `copyMessages` cannot reply).
    let placeholderCount = 0;
    try {
      for (const entity of kept) {
        for (const msg of entity) {
          if (!isTransferable(msg.content)) {
            await send(threadsChatId, placeholderText(msg.content), replyToRoot);
            placeholderCount += 1;
            continue;
          }
          const match = matches.get(msg.forwardId);
          if (match?.kind === "unique") {
            await withRetry429(() =>
              bot.api.copyMessage(threadsChatId, chatId, match.original.messageId, replyToRoot),
            );
          } else {
            await withRetry429(() =>
              bot.api.copyMessage(threadsChatId, threadsChatId, msg.forwardId, replyToRoot),
            );
          }
        }
      }
    } catch (error) {
      logger.error({ event: "copy_failed", error: error instanceof Error ? error.name : "unknown" });
      await send(threadsChatId, t(locale, "transfer.failure"), replyToRoot);
      return;
    }

    // 3. announce (D53: posted whenever a thread was created) — sent BEFORE the
    //    closing message (D89): its message id feeds the closing link. A failed
    //    announce is not fatal: the closing falls back to the plain chat title
    //    (D89) and the transfer is not rolled back.
    const topicId = announceTopic(draft.batch, matches);
    const announce = await send(chatId, t(locale, "transfer.announce", { title, url: threadUrl(threadsRef, rootId) }), {
      ...(topicId !== undefined ? { message_thread_id: topicId } : {}),
    });

    // 4. closing message (D9/D27 exact strings). D89 (amends D7/D62): the
    //    "moved from" value is the ANNOUNCE message link
    //    `https://t.me/c/{internal_chat_id}/{announce_message_id}` — or, when
    //    the announce could not be sent, the plain chat title (no link).
    const closing = t(locale, "transfer.closing", {
      title,
      link: movedFromValue({ id: chatId, title: chatTitle(chatId, String(chatId)) }, announce?.message_id),
    });
    await send(
      threadsChatId,
      placeholderCount > 0
        ? `${closing}\n${t(locale, "transfer.closingPlaceholders", { count: placeholderCount })}`
        : closing,
      replyToRoot,
    );

    // 5. mapping persistence (D10) — only after the whole thread exists.
    store.saveThread({
      threadId: rootId,
      title,
      sourceChatId: chatId,
      threadsChatId,
      rootMessageId: rootId,
      ...(topicId !== undefined ? { messageThreadId: topicId } : {}),
      createdBy: draft.authorId,
      createdAt: nowMs(),
    });
    for (const entity of kept) {
      for (const msg of entity) {
        const match = matches.get(msg.forwardId);
        store.saveThreadMessage(
          rootId,
          msg.forwardId,
          isTransferable(msg.content) ? "copy" : "placeholder",
          match?.kind === "unique" ? match.original.messageId : undefined,
        );
        if (match?.kind === "unique") {
          store.indexSourceMessage({ ...match.original, threadId: rootId });
        }
      }
    }

    // 6. originals deletion (source chat) — only after the whole thread exists (AC14).
    const report: Record<DeleteClass, number> = { deleted: 0, not_found: 0, forbidden: 0, failed: 0 };
    const notDeletedIds: number[] = [];
    const deletedMessageIds: number[] = [];
    const matchedIds: number[] = [];
    for (const entity of kept) {
      for (const msg of entity) {
        const match = matches.get(msg.forwardId);
        if (match?.kind === "unique") matchedIds.push(match.original.messageId);
      }
    }
    for (const chunk of chunkIds(matchedIds)) {
      await deleteOriginalsChunk(chatId, chunk, report, notDeletedIds, deletedMessageIds);
    }

    // 7. forwarded-batch deletion (threads chat): the whole batch — transferred,
    //    rejected and dropped copies alike (D52).
    for (const chunk of chunkIds(draft.batch.map((msg) => msg.forwardId))) {
      await deleteForwardedChunk(threadsChatId, chunk);
    }

    // 8. SEC-F1 (R61/T-R1): the audit record names the initiator, the source
    //    chat, the thread root and every deleted original id plus the D74 class
    //    counts. SEC-8: ids only — never secrets or message text.
    logger.info({
      event: "transfer_completed",
      authorId: draft.authorId,
      sourceChatId: chatId,
      threadsChatId,
      rootMessageId: rootId,
      deletedMessageIds,
      copied: kept.reduce((n, entity) => n + entity.length, 0),
      deleted: report.deleted,
      notFound: report.not_found,
      forbidden: report.forbidden,
      failed: report.failed,
    });

    // 9. AC5/D54/D74 report, as a reply into the created thread (D28).
    const keptCount = kept.reduce((n, entity) => n + entity.length, 0);
    const unidentified = kept.reduce(
      (n, entity) => n + entity.filter((msg) => matches.get(msg.forwardId)?.kind !== "unique").length,
      0,
    );
    if (unidentified > 0 || notDeletedIds.length > 0) {
      const lines: string[] = [];
      if (unidentified > 0) {
        lines.push(
          keptCount - unidentified === 0
            ? t(locale, "transfer.reportNoOriginals")
            : t(locale, "transfer.reportUnidentified", { count: unidentified }),
        );
      }
      lines.push(`deleted: ${report.deleted}`);
      lines.push(`not_found: ${report.not_found}`);
      lines.push(`forbidden: ${report.forbidden}`);
      lines.push(`failed: ${report.failed}`);
      if (notDeletedIds.length > 0) {
        lines.push(t(locale, "transfer.reportNotDeleted", { ids: notDeletedIds.join(", ") }));
      }
      await send(threadsChatId, lines.join("\n"), replyToRoot);
    }
  }

  function announceTopic(
    batch: DraftMessageRecord[],
    matches: Map<number, MatchOutcome>,
  ): number | undefined {
    for (const msg of batch) {
      const match = matches.get(msg.forwardId);
      if (match?.kind === "unique" && typeof match.original.messageThreadId === "number") {
        return match.original.messageThreadId;
      }
    }
    return undefined;
  }

  /**
   * Deletes matched originals (R27: <= 100 ids per `deleteMessages` call) with
   * a per-message fallback for the D74 classes (harness convention 8).
   * `retry_after` (D24/D78) is honoured with a wait; a rate-limited call is not
   * re-attempted — S72's accounting counts deleted ids per call payload.
   */
  async function deleteOriginalsChunk(
    chatId: number,
    ids: number[],
    report: Record<DeleteClass, number>,
    notDeletedIds: number[],
    deletedIds: number[],
  ): Promise<void> {
    if (ids.length === 0) return;
    try {
      await bot.api.deleteMessages(chatId, ids);
      report.deleted += ids.length;
      deletedIds.push(...ids);
      return;
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait !== undefined) {
        logger.warn({ event: "retry_after", waitMs: wait });
        await delay(wait);
        report.failed += ids.length;
        notDeletedIds.push(...ids);
        return;
      }
    }
    for (const id of ids) {
      try {
        await bot.api.deleteMessage(chatId, id);
        report.deleted += 1;
        deletedIds.push(id);
      } catch (error) {
        const wait = retryAfterMs(error);
        if (wait !== undefined) {
          logger.warn({ event: "retry_after", waitMs: wait });
          await delay(wait);
        }
        const cls = classifyDeleteError(error);
        report[cls] += 1;
        notDeletedIds.push(id);
      }
    }
  }

  /** Best-effort cleanup of the forwarded copies (D52). */
  async function deleteForwardedChunk(chatId: number, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await bot.api.deleteMessages(chatId, ids);
    } catch (error) {
      const wait = retryAfterMs(error);
      if (wait !== undefined) {
        logger.warn({ event: "retry_after", waitMs: wait });
        await delay(wait);
      }
      logger.warn({ event: "forward_cleanup_failed", count: ids.length });
    }
  }

  // ------------------------------ commands --------------------------------

  async function handleCommand(ctx: Context, msg: Record<string, unknown>, text: string): Promise<void> {
    const from = msg.from as { id?: unknown; language_code?: unknown } | null;
    const userId = from && typeof from.id === "number" ? from.id : undefined;
    const locale = localeOf(userId, from?.language_code);
    const chat = msg.chat as { id?: unknown; type?: unknown } | null;
    const chatType = typeof chat?.type === "string" ? chat.type : "";
    const command = text.split(/[\s@]/)[0].toLowerCase();

    if (command === "/start") {
      await replyTo(ctx, t(locale, "start.text"));
      return;
    }
    if (command === "/settings") {
      if (chatType !== "private") {
        await replyTo(ctx, t(locale, "settings.notPrivate"));
        return;
      }
      if (!isGlobalAdmin(userId)) {
        await replyTo(ctx, t(locale, "settings.refusal"));
        return;
      }
      await sendSettings(ctx, locale);
      return;
    }
    if (command === "/cancel") {
      const threads = threadsChat();
      const own = threads && userId !== undefined ? getDraft(threads.chatId, userId) : undefined;
      if (own) {
        if (own.authorId === userId) {
          store.removeDraft(own.key);
          await replyTo(ctx, t(locale, "dialog.cancelled"));
        } else {
          await replyTo(ctx, t(locale, "dialog.cancelForeign"));
        }
        return;
      }
      const otherOpen =
        threads !== undefined && store.listDrafts().some((draft) => draft.threadsChatId === threads.chatId);
      await replyTo(ctx, t(locale, otherOpen ? "dialog.cancelForeign" : "dialog.noDraft"));
      return;
    }
  }

  // ------------------------------ /settings -------------------------------

  async function sendSettings(ctx: Context, locale: Locale): Promise<void> {
    const chatId = (ctx.message ?? ctx.callbackQuery?.message)?.chat?.id;
    if (typeof chatId !== "number") return;
    const rows: Array<Array<Record<string, string>>> = [];
    const listed: string[] = [];
    // D79: list observed chats where the bot's membership is admin. Known
    // `my_chat_member` status answers without any API call (S7).
    for (const seen of discovered.values()) {
      if (seen.type === "private") continue;
      if (!(await botIsAdminIn(seen.id))) continue;
      const record = store.getChat(seen.id);
      const segment = chatLinkSegment(seen.id);
      const row: Array<Record<string, string>> = [
        {
          text: `${t(locale, "settings.actionSource")}: ${seen.title}`,
          callback_data: `set:connect:${seen.id}:${segment}`,
        },
        {
          text: `${t(locale, "settings.actionThreads")}: ${seen.title}`,
          callback_data: `set:threads:${seen.id}:${segment}`,
        },
      ];
      if (record?.source || record?.threads) {
        row.push({
          text: `${t(locale, "settings.actionDisconnect")}: ${seen.title}`,
          callback_data: `set:disconnect:${seen.id}:${segment}`,
        });
      }
      rows.push(row);
      listed.push(seen.title);
    }
    rows.push([
      { text: "English", callback_data: "set:lang:en" },
      { text: "Русский", callback_data: "set:lang:ru" },
    ]);
    await send(chatId, `${t(locale, "settings.title")}\n${t(locale, "settings.chatList")}\n${listed.map((title) => `• ${title}`).join("\n")}`, {
      reply_markup: { inline_keyboard: rows },
    });
  }

  async function handleSettingsCallback(ctx: Context, action: string, chatId: number): Promise<void> {
    const cb = ctx.callbackQuery as unknown as Record<string, any> | undefined;
    const from = cb?.from as { id?: unknown; language_code?: unknown } | undefined;
    const userId = from && typeof from.id === "number" ? from.id : undefined;
    const locale = localeOf(userId, from?.language_code);
    const replyChat = cb?.message?.chat?.id;
    const respond = async (text: string): Promise<void> => {
      if (typeof replyChat === "number") await send(replyChat, text);
    };
    if (!isGlobalAdmin(userId)) {
      await respond(t(locale, "settings.refusal"));
      return;
    }
    const known = discovered.get(chatId);
    const title = known?.title ?? chatTitle(chatId, String(chatId));
    const record: ChatRecord = store.getChat(chatId) ?? {
      chatId,
      type: known?.type ?? "supergroup",
      title,
      ...(known?.username ? { username: known.username } : {}),
      isForum: known?.isForum ?? false,
      source: false,
      threads: false,
    };
    if (action === "connect") {
      const threads = threadsChat();
      if (threads?.chatId === chatId) {
        // D33/S5: the threads chat must differ from a source chat.
        await respond(t(locale, "settings.sourceConnectRefused", { title }));
        return;
      }
      store.saveChat({ ...record, source: true });
      await respond(t(locale, "settings.sourceConnected", { title }));
      logger.info({ event: "source_connected", chatId });
      return;
    }
    if (action === "threads") {
      const previous = threadsChat();
      for (const other of store.listChats()) {
        if (other.threads && other.chatId !== chatId) store.saveChat({ ...other, threads: false });
      }
      store.saveChat({ ...record, threads: true });
      await respond(
        previous && previous.chatId !== chatId
          ? t(locale, "settings.threadsRepointed", { previous: previous.title, title })
          : t(locale, "settings.threadsConnected", { title }),
      );
      logger.info({ event: "threads_connected", chatId });
      return;
    }
    if (action === "disconnect") {
      store.saveChat({ ...record, source: false });
      await respond(t(locale, "settings.sourceDisconnected", { title }));
      logger.info({ event: "source_disconnected", chatId });
      return;
    }
  }

  async function handleLangCallback(ctx: Context, lang: "en" | "ru"): Promise<void> {
    const cb = ctx.callbackQuery as unknown as Record<string, any> | undefined;
    const from = cb?.from as { id?: unknown } | undefined;
    const userId = from && typeof from.id === "number" ? from.id : undefined;
    const replyChat = cb?.message?.chat?.id;
    if (userId === undefined || typeof replyChat !== "number") return;
    if (!isGlobalAdmin(userId)) {
      await send(replyChat, t(localeOf(userId, undefined), "settings.refusal"));
      return;
    }
    store.saveUser({ userId, locale: lang });
    await send(replyChat, t(lang, "settings.languageChanged"));
    logger.info({ event: "language_changed", userId, locale: lang });
  }

  // ---------------------------- dialog callback ---------------------------

  async function handleDialogCallback(ctx: Context, chatId: number): Promise<void> {
    const cb = ctx.callbackQuery as unknown as Record<string, any> | undefined;
    const from = cb?.from as { id?: unknown; language_code?: unknown } | undefined;
    const userId = from && typeof from.id === "number" ? from.id : undefined;
    const messageChat = cb?.message?.chat?.id;
    if (userId === undefined || typeof messageChat !== "number") return;
    const locale = localeOf(userId, from?.language_code);

    const draft = getDraft(messageChat, userId);
    if (!draft) return; // stale or foreign button (D48)
    if (isExpired(draft)) {
      store.removeDraft(draft.key);
      await send(messageChat, t(locale, "dialog.timeout"));
      return;
    }
    const picked = store.getChat(chatId);
    if (!picked?.source || picked.threads) return; // inert: not a usable source chat
    const allowed = await isSourceAdmin(chatId, userId);
    if (!allowed) {
      await send(messageChat, t(locale, "transfer.refusedNotAdmin", { title: picked.title }));
      return;
    }
    draft.pickedChatId = chatId;
    draft.pickedAuthorized = true;
    store.saveDraft(stripKey(draft));
    logger.info({ event: "source_picked", chatId, authorId: userId });
  }

  // ----------------------------- registrations ----------------------------

  bot.on("my_chat_member", (ctx) => {
    const raw = ctx.myChatMember as unknown as {
      chat?: unknown;
      new_chat_member?: { status?: unknown };
    };
    recordDiscovery(raw.chat);
    // S7/D79: the bot's own membership is learned here — never re-probed later.
    const chatId = (raw.chat as { id?: unknown } | null)?.id;
    const status = raw.new_chat_member?.status;
    if (typeof chatId === "number" && typeof status === "string") {
      botMembership.set(chatId, status === "administrator" || status === "creator");
    }
  });

  bot.on("edited_message", (ctx) => {
    const msg = ctx.editedMessage as unknown as Record<string, unknown>;
    recordDiscovery(msg.chat);
    indexMessage(msg);
  });

  bot.on("message", async (ctx) => {
    const msg = (ctx.message ?? {}) as unknown as Record<string, unknown>;
    recordDiscovery(msg.chat);
    indexMessage(msg);

    const text = typeof msg.text === "string" ? msg.text : undefined;
    if (text !== undefined && text.startsWith("/")) {
      await handleCommand(ctx, msg, text);
      return;
    }

    const threads = threadsChat();
    const chat = msg.chat as { id?: unknown } | null;
    if (!threads || chat?.id !== threads.chatId) return;

    if (msg.forward_origin !== undefined) {
      await handleForward(ctx, msg);
      return;
    }
    await handleDraftText(ctx, msg);
  });

  bot.on("callback_query", async (ctx) => {
    const cb = ctx.callbackQuery as unknown as Record<string, any> | undefined;
    try {
      await ctx.answerCallbackQuery();
    } catch {
      // stale callback: acknowledging is best-effort
    }
    const data = typeof cb?.data === "string" ? cb.data : "";

    const settings = SETTINGS_ACTION.exec(data);
    if (settings) {
      await handleSettingsCallback(ctx, settings[1], Number(settings[2]));
      return;
    }
    const lang = SETTINGS_LANG.exec(data);
    if (lang) {
      await handleLangCallback(ctx, lang[1] as "en" | "ru");
      return;
    }
    const dialog = DIALOG_CHAT.exec(data);
    if (dialog) {
      await handleDialogCallback(ctx, Number(dialog[1]));
      return;
    }
    // D48/SEC-5: unknown or hostile payloads are acknowledged and inert.
  });

  return bot;
}
