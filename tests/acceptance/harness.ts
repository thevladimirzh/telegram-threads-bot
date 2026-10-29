/**
 * Acceptance-test harness (T6, qa-engineer) for the 82 Gherkin scenarios in
 * `tests/features/*.feature`. Black-box: Telegram updates are driven into the
 * bot returned by `createBot(deps)` (docs/plan.md §7) against the in-process
 * fake Bot API (`tests/helpers/fake-bot-api.ts`, plan D13).
 *
 * RED note (expected state until T7): the contract modules
 * `src/config.ts`, `src/store/in-memory.ts`, `src/bot/createBot.ts` and
 * `src/health.ts` do not exist yet. They are imported dynamically with
 * `@ts-ignore` so `npm run typecheck` stays clean and every test fails
 * individually with "module missing" — the expected RED state.
 *
 * ============================================================================
 * DE-FACTO UPDATE CONTRACT (fixtures per docs/spec/decisions.md §1)
 * ============================================================================
 * The feature files do not pin raw update shapes; the conventions below make
 * the scenarios observable and are the de-facto contract for T7 (also listed
 * in docs/qa/open-questions.md):
 *
 * 1. Plain "forwards the message N of C into T" builds a forward whose
 *    `forward_origin` is a superset that both the matcher (D21: date + sender +
 *    content) and the preselection (D29/D66: "origin naming a chat") can read:
 *      `{ type: "user", sender_user: <original sender>, date: <original date>,
 *          chat: <source chat>, sender_chat: <source chat> }`
 *    The hidden-sender variant (S18) is
 *      `{ type: "hidden_user", sender_user_name: "...", date }` — no chat.
 * 2. Service messages carry `service_event_type` on the message (the D27
 *    placeholder slot `[service] {service_event_type}` is named after it).
 * 3. Polls carry `poll: { question }`; invoices carry `invoice: {...}`
 *    (content type "invoice" -> `[unsupported] invoice`).
 * 4. "the bot is an admin of X" is signalled with a `my_chat_member` update
 *    (bot promoted to administrator) AND an ordinary message in X AND
 *    membership fakes (`getChatMember`/`getChatAdministrators`). Per D79
 *    (OQ-QA-7 resolved) chat discovery is by observed updates — both
 *    `my_chat_member` AND message updates are stored as chats and /settings
 *    lists those where the bot's membership is admin; this fixture feeds
 *    both signals so either implementation is exercised.
 * 5. "the inline button for C is marked as selected" (preselection, S17) is
 *    observable as a selection marker: the button text contains "✓"/"☑"/"✔"
 *    or its callback_data contains a `sel`/`selected`/`on`/`chosen`/`active`
 *    token. Buttons are located by the chat-id substring in callback_data
 *    (D77).
 * 6. Settings buttons are located on the chat-id substring (D77) and
 *    disambiguated by action tokens in callback_data:
 *    source  ~ /source|src|connect|from|add/i  (not /thread|disc/…),
 *    threads ~ /thread|dst|dest|target|to/i,
 *    disconnect ~ /disc|off|remove|leave|del|un/i,
 *    language switch ~ the language code (e.g. "ru") or /lang|locale/i.
 *    Confirmation buttons ~ /confirm|apply|done|yes|ok/i (same convention the
 *    security tests use in their connectChat helper).
 * 7. The root (title) message gets `message_id` 42 — the fixture convention
 *    ("root id 42", decisions §1). `setNextBotMessageId(42)` stubs the id the
 *    fake API returns for the next bot-created message (step "the next message
 *    created by the bot gets the id 42").
 * 8. Deletion failure injection is per message id. A `deleteMessages` call
 *    fails as a whole when any of its ids is registered as failing (Telegram
 *    style); the per-class, per-count report (D74) therefore implies
 *    individual deletes or a batch-then-retry-individually strategy
 *    (OQ-QA-8 resolved: report classes `deleted`, `not_found`, `forbidden`,
 *    `failed`, each with a count).
 * 9. `retry_after` (S72/S73) is verified with vitest fake timers: the bot is
 *    expected to wait via timers (`setTimeout`) because the fixed `deps`
 *    (store, now, logger, config) contain no sleep hook. Only those two tests
 *    enable fake timers; everything else uses the injected virtual clock.
 * 10. Copying may use `copyMessage`/`copyMessages` OR `sendMessage` with the
 *    copied text: the introspection below accepts either so assertions stay
 *    black-box (the fake API is method-agnostic).
 * 11. Thread assembly (D87, iteration 2): the thread is a REPLY CHAIN — every
 *    thread-body message (copy, placeholder, closing, failure report) is a
 *    reply to the root (the title message, id 42) via `reply_parameters.message_id`
 *    or `reply_to_message_id`; `message_thread_id` is NEVER used for thread
 *    assembly (it is ignored outside forum topics and remains only on the
 *    source-chat announce of forum sources, D18/D69). Albums (D88) are copied
 *    per item — one post per item, contiguous, in source order, each a reply to
 *    the root; media-group grouping is intentionally lost.
 * 12. Closing-message link (D89, iteration 3, R63): the closing message
 *    `{title} — moved from {…}` links to the ANNOUNCE message in the source
 *    chat — `https://t.me/c/{internal_chat_id}/{announce_message_id}` (uniform
 *    for public and private chats; `internal_chat_id` = chat id with the
 *    `-100`/`-` prefix stripped per D62). The announce is sent BEFORE the
 *    closing message so its id is known (thread display order unchanged:
 *    root, copies…, closing last). When the announce cannot be sent, the same
 *    template is filled with the plain chat title (no link). Harness support:
 *    `setNextSendIdIn(chatId, id)` implements the step "the announce message
 *    gets the id N" (one-shot id stub for the next sendMessage into that chat),
 *    `failNextSendIn(chatId, init)` implements "sending the announce in X fails
 *    with a Telegram error" (one-shot failure), and `announceCallIn`/
 *    `closingCallIn` locate those messages. Bot-created message ids are
 *    tracked per chat: the root id 42 (threads chat) and the stubbed announce
 *    id 42 (source chat) are different messages.
 *
 * Determinism: injected clock (`setTime`), fixed ids, no network, no real DB
 * (`new InMemoryStore()`), no timers outside S72/S73 (fake timers there).
 */
import { vi } from "vitest";
import { FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, FakeApiError, type FakeApiErrorInit, type RecordedCall } from "../helpers/fake-bot-api";

// ------------------------------- fixtures ----------------------------------

export type Update = any;

export interface UserFixture {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface ChatFixture {
  id: number;
  type: string;
  title: string;
  username?: string;
  is_forum?: boolean;
}

export const BOT_USER: UserFixture = { id: 1, is_bot: true, first_name: "Test Bot", username: "test_bot" };

/** Fixture actors — decisions §1. `language_code: "en"` unless stated. */
export const USERS: Record<"admin" | "author" | "other_author" | "stranger", UserFixture> = {
  admin: { id: 777, is_bot: false, first_name: "Ada", last_name: "Admin", username: "admin_user", language_code: "en" },
  author: { id: 111, is_bot: false, first_name: "Alice", last_name: "Authorson", username: "author_user", language_code: "en" },
  other_author: { id: 113, is_bot: false, first_name: "Bob", last_name: "Cowriter", username: "other_author_user", language_code: "en" },
  stranger: { id: 222, is_bot: false, first_name: "Sam", last_name: "Stranger", username: "stranger_user", language_code: "en" },
};

/** Fixture chats — decisions §1 (ids, titles, usernames exactly as listed there). */
export const CHATS: Record<
  "source" | "privateSource" | "forum" | "threads" | "privateThreads" | "threads2" | "other",
  ChatFixture
> = {
  source: { id: -1002000000000001, type: "supergroup", title: "Source Chat", username: "main_chat" },
  privateSource: { id: -1002000000000004, type: "supergroup", title: "Private Source Chat" },
  forum: { id: -1002000000000002, type: "supergroup", title: "Forum Chat", username: "forum_chat", is_forum: true },
  threads: { id: -1002000000000003, type: "supergroup", title: "Threads Chat", username: "threads_chat" },
  privateThreads: { id: -1002000000000005, type: "supergroup", title: "Private Threads Chat" },
  threads2: { id: -1002000000000007, type: "supergroup", title: "Threads Chat 2", username: "threads_chat_2" },
  other: { id: -1002000000000006, type: "supergroup", title: "Other Chat", username: "other_chat" },
};

/** Fixed env for `loadConfig` (test token + fake DB URL — never used for real I/O). */
export const ENV_BASE: Record<string, string | undefined> = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads",
  ADMIN_IDS: "777",
  MODE: "polling",
};

/** `at("10:00:00")` — deterministic seconds offset from the fixed base date. */
export function at(hms: string): number {
  const parts = hms.split(":").map(Number);
  return FIXED_DATE + parts[0] * 3600 + parts[1] * 60 + (parts[2] ?? 0);
}

// --------------------------- message content -------------------------------

export type Content =
  | { kind: "text"; text: string }
  | { kind: "poll"; question: string }
  | { kind: "service"; serviceEventType: string }
  | { kind: "invoice" }
  | { kind: "photo"; caption?: string; fileId: string };

export function contentFields(content: Content): Record<string, unknown> {
  switch (content.kind) {
    case "text":
      return { text: content.text };
    case "poll":
      return { poll: { question: content.question } };
    case "service":
      return { service_event_type: content.serviceEventType };
    case "invoice":
      return { invoice: { title: "Invoice", total_amount: 100, currency: "USD" } };
    case "photo":
      return {
        photo: [{ file_id: content.fileId, file_unique_id: content.fileId, width: 1, height: 1 }],
        ...(content.caption !== undefined ? { caption: content.caption } : {}),
      };
  }
}

interface ObservedMsg {
  chat: ChatFixture;
  from: UserFixture;
  id: number;
  date: number;
  content: Content;
  mediaGroupId?: string;
  replyTo?: number;
  messageThread?: number;
}

// ------------------------------ introspection ------------------------------

export interface Button {
  text: string;
  data: string;
  call: RecordedCall;
  messageId: number;
}

/** A content post into the threads chat, normalized across copy mechanisms. */
export type ThreadPost =
  | { kind: "ref"; ids: number[]; call: RecordedCall }
  | { kind: "text"; text: string; call: RecordedCall };

export interface LogRecord {
  level: string;
  args: unknown[];
}

/** "marked as selected" (preselection) — see convention 5 in the header. */
export function isMarkedSelected(button: Button): boolean {
  return /✓|☑|✔|◉|\[x\]/.test(button.text) || /(^|:)(sel|selected|on|chosen|active)(:|$)/i.test(button.data);
}

export function refersToChat(data: string, chatId: number): boolean {
  return data.includes(String(chatId)) || data.includes(String(Math.abs(chatId)));
}

// --------------------------------- boot -----------------------------------

function makeLogger(records: LogRecord[]): any {
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

const WRITE_VERB =
  /^(add|create|insert|save|upsert|put|append|set|write|record|store|index|track|link|map|attach|push|delete|remove|update|mark|touch|clear|reset|merge|bind|bump|note)/i;

/** Wraps a Store so every mutating method call is recorded by name. */
function recordingStore(raw: unknown): { store: any; writes: string[] } {
  const writes: string[] = [];
  const wrap = (target: any, path: string): any => {
    if (target === null || typeof target !== "object") return target;
    if (target instanceof Promise) return target;
    return new Proxy(target, {
      get(t: any, prop): unknown {
        if (typeof prop !== "string") return t[prop];
        const value = t[prop];
        if (typeof value === "function") {
          return (...args: unknown[]): unknown => {
            if (WRITE_VERB.test(prop)) writes.push(`${path}.${prop}`);
            return value.apply(t, args);
          };
        }
        return wrap(value, `${path}.${prop}`);
      },
    });
  };
  return { store: wrap(raw, "store"), writes };
}

export interface BootOptions {
  /** Extra/override env vars for loadConfig (e.g. `{ BOT_TOKEN: undefined }`). */
  env?: Record<string, string | undefined>;
  /** Enable vitest fake timers (needed only for retry_after scenarios). */
  fakeTimers?: boolean;
  /** Initial clock ("HH:MM:SS"); default "10:00:00". */
  time?: string;
}

export class Ctx {
  bot: any;
  api: FakeBotApi;
  store: any;
  writes: string[];
  logRecords: LogRecord[];
  config: any;

  /** Every API call's clock sample (same order as api.calls) — retry_after gaps. */
  callTimes: number[] = [];

  // clock
  private clockMs: number;
  private readonly useFakeTimers: boolean;

  // update plumbing
  private updateId = 1;
  private nextForwardId = 5000;
  private nextSendId = 1000;
  private nextCopyId = 3000;
  /** Result id assigned to each sendMessage, aligned with api.callsOf("sendMessage"). */
  readonly sentIds: number[] = [];
  /**
   * Every bot-created sendMessage result id (keyed `chatId:messageId` — ids
   * are per chat, e.g. root id 42 and stubbed announce id 42) -> its call and
   * reply target (never cleared).
   */
  private readonly botSendById = new Map<string, { call: RecordedCall; replyTo: number | undefined }>();
  private readonly observed = new Map<string, ObservedMsg>();

  // membership
  private readonly chatAdmins = new Map<number, Set<number>>();
  private readonly botAdmin = new Set<number>();

  // failure injection
  private failCopyAt: number | null = null;
  private copyError: FakeApiErrorInit | null = null;
  private copyPostCount = 0;
  private failNextPlainSend: FakeApiErrorInit | null = null;
  /** D89: one-shot per-chat id stub ("the announce message gets the id N"). */
  private readonly sendIdStubPerChat = new Map<number, number>();
  /** D89: one-shot per-chat sendMessage failure ("sending the announce in X fails"). */
  private readonly failSendPerChat = new Map<number, FakeApiErrorInit>();
  private readonly failDeletePerId = new Map<number, FakeApiErrorInit>();
  private failFirstDeleteInChat: number | null = null;
  private firstDeleteError: FakeApiErrorInit | null = null;
  private readonly demotedChats = new Set<number>();
  /** Index into api.calls of the most recent injected failure. */
  lastFailedCallIndex = -1;

  constructor(opts: BootOptions, bot: any, api: FakeBotApi, store: any, writes: string[], logRecords: LogRecord[], config: any) {
    this.useFakeTimers = opts.fakeTimers === true;
    this.clockMs = at(opts.time ?? "10:00:00") * 1000;
    this.bot = bot;
    this.api = api;
    this.store = store;
    this.writes = writes;
    this.logRecords = logRecords;
    this.config = config;
    this.installDefaults();
  }

  // ------------------------------ clock ----------------------------------

  nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  nowMs(): number {
    return this.useFakeTimers ? Date.now() : this.clockMs;
  }

  setTime(hms: string): void {
    const ms = at(hms) * 1000;
    if (this.useFakeTimers) vi.setSystemTime(ms);
    else this.clockMs = ms;
  }

  /** Sets the id the fake API returns for the next bot-created sendMessage. */
  setNextBotMessageId(id: number): void {
    this.nextSendId = id;
  }

  /**
   * D89: "the announce message gets the id N" — one-shot id stub for the next
   * sendMessage into `chatId` (the announce is the only bot message posted
   * into the source chat during a transfer).
   */
  setNextSendIdIn(chatId: number, id: number): void {
    this.sendIdStubPerChat.set(chatId, id);
  }

  // ------------------------------ fakes ----------------------------------

  private installDefaults(): void {
    const api = this.api;

    // Bot admin everywhere with delete rights by default (plan §5); scenarios
    // may demote/flip via setBotAdminOf / demoteBotIn.
    for (const chat of Object.values(CHATS)) {
      this.botAdmin.add(chat.id);
      this.chatAdmins.set(chat.id, new Set([BOT_USER.id, USERS.author.id, USERS.other_author.id]));
    }
    // stranger has no rights anywhere (fixture table); author + other_author
    // are admins of the fixture source chats only (see the explicit sets below).
    this.chatAdmins.set(CHATS.threads.id, new Set([BOT_USER.id]));
    this.chatAdmins.set(CHATS.privateThreads.id, new Set([BOT_USER.id]));
    this.chatAdmins.set(CHATS.threads2.id, new Set([BOT_USER.id]));
    this.chatAdmins.set(CHATS.other.id, new Set([BOT_USER.id]));

    const chatById = new Map<number, ChatFixture>(Object.values(CHATS).map((c) => [c.id, c]));

    api.setMethodResult("getChat", (p: any) => {
      const chat = chatById.get(Number(p.chat_id));
      return chat ? { ...chat } : { id: p.chat_id ?? 0, type: "supergroup", title: "Fake chat" };
    });
    api.setMethodResult("getChatMember", (p: any) => {
      const admins = this.chatAdmins.get(Number(p.chat_id)) ?? new Set<number>();
      const isAdmin = admins.has(Number(p.user_id));
      return {
        status: isAdmin ? "administrator" : "member",
        user: { id: p.user_id ?? 0, is_bot: Number(p.user_id) === BOT_USER.id, first_name: "U" },
        can_delete_messages: isAdmin,
      };
    });
    api.setMethodResult("getChatAdministrators", (p: any) => {
      const admins = this.chatAdmins.get(Number(p.chat_id)) ?? new Set<number>();
      return [...admins].map((id) => ({
        status: "administrator",
        user: { id, is_bot: id === BOT_USER.id, first_name: "U" },
        can_delete_messages: true,
        is_anonymous: false,
      }));
    });

    api.setMethodResult("sendMessage", (p: any) => {
      // failRootPost targets the root (title) message: a plain send with no
      // reply target at all (D87: thread-body messages carry reply targets).
      if (
        this.failNextPlainSend &&
        p.reply_markup == null &&
        p.message_thread_id == null &&
        p.reply_to_message_id == null &&
        p.reply_parameters == null
      ) {
        const init = this.failNextPlainSend;
        this.failNextPlainSend = null;
        this.lastFailedCallIndex = api.calls.length - 1;
        return new FakeApiError(init);
      }
      const chatId = Number(p.chat_id);
      // D89 (convention 12): one-shot per-chat failure — "sending the announce
      // in X fails with a Telegram error".
      const failInit = this.failSendPerChat.get(chatId);
      if (failInit !== undefined) {
        this.failSendPerChat.delete(chatId);
        this.lastFailedCallIndex = api.calls.length - 1;
        return new FakeApiError(failInit);
      }
      // D89 (convention 12): one-shot per-chat id stub — "the announce message
      // gets the id N".
      const stubbedId = this.sendIdStubPerChat.get(chatId);
      if (stubbedId !== undefined) this.sendIdStubPerChat.delete(chatId);
      const id = stubbedId ?? this.nextSendId++;
      this.sentIds.push(id);
      const call = api.calls[api.calls.length - 1];
      if (call !== undefined) this.botSendById.set(`${chatId}:${id}`, { call, replyTo: this.replyToOf(call) });
      return this.makeMessageResult(p, id);
    });
    api.setMethodResult("copyMessage", (p: any) => {
      this.copyPostCount += 1;
      if (this.failCopyAt !== null && this.copyPostCount >= this.failCopyAt) {
        const init = this.copyError ?? { error_code: 400, description: "copy failed" };
        this.failCopyAt = null;
        this.lastFailedCallIndex = api.calls.length - 1;
        return new FakeApiError(init);
      }
      return { message_id: this.nextCopyId++ };
    });
    api.setMethodResult("copyMessages", (p: any) => {
      const ids = Array.isArray(p.message_ids) ? (p.message_ids as unknown[]) : [];
      this.copyPostCount += ids.length;
      if (this.failCopyAt !== null && this.copyPostCount >= this.failCopyAt) {
        const init = this.copyError ?? { error_code: 400, description: "copy failed" };
        this.failCopyAt = null;
        this.lastFailedCallIndex = api.calls.length - 1;
        return new FakeApiError(init);
      }
      return ids.map(() => ({ message_id: this.nextCopyId++ }));
    });
    api.setMethodResult("deleteMessage", (p: any) => this.deleteResult([Number(p.message_id)], Number(p.chat_id)));
    api.setMethodResult("deleteMessages", (p: any) => {
      const ids = Array.isArray(p.message_ids) ? (p.message_ids as unknown[]).map(Number) : [];
      return this.deleteResult(ids, Number(p.chat_id));
    });
  }

  private deleteResult(ids: number[], chatId: number): true | FakeApiError {
    if (this.demotedChats.has(chatId)) {
      this.lastFailedCallIndex = this.api.calls.length - 1;
      return new FakeApiError({ error_code: 403, description: "Forbidden: bot was kicked" });
    }
    if (this.failFirstDeleteInChat === chatId) {
      this.failFirstDeleteInChat = null;
      this.lastFailedCallIndex = this.api.calls.length - 1;
      return new FakeApiError(
        this.firstDeleteError ?? { error_code: 429, description: "Too Many Requests", retry_after: 3 },
      );
    }
    for (const id of ids) {
      const init = this.failDeletePerId.get(id);
      if (init) {
        this.lastFailedCallIndex = this.api.calls.length - 1;
        return new FakeApiError(init);
      }
    }
    return true;
  }

  private makeMessageResult(payload: Record<string, any>, id: number): Record<string, unknown> {
    return {
      message_id: id,
      date: this.nowSec(),
      chat: { id: payload.chat_id ?? 0, type: "supergroup", title: "Fake chat" },
      from: { ...BOT_USER },
      ...(payload.text !== undefined ? { text: payload.text } : {}),
      ...(payload.caption !== undefined ? { caption: payload.caption } : {}),
      ...(payload.message_thread_id !== undefined ? { message_thread_id: payload.message_thread_id } : {}),
    };
  }

  // --------------------------- failure injection --------------------------

  /** Fail the n-th content post (copyMessage/copyMessages/thread messages). */
  failNthCopyPost(n: number, init: FakeApiErrorInit): void {
    this.failCopyAt = n;
    this.copyError = init;
    this.copyPostCount = 0;
  }

  /** Fail posting the root (title) message: the next plain sendMessage. */
  failRootPost(init: FakeApiErrorInit): void {
    this.failNextPlainSend = init;
  }

  /**
   * D89: "sending the announce in X fails with a Telegram error" — one-shot
   * failure of the next sendMessage into `chatId`.
   */
  failNextSendIn(chatId: number, init: FakeApiErrorInit): void {
    this.failSendPerChat.set(chatId, init);
  }

  /** Fail deletion of these source message ids (per message, D74 granularity). */
  failDeleteOf(ids: number[], init: FakeApiErrorInit): void {
    for (const id of ids) this.failDeletePerId.set(id, init);
  }

  /** Fail the first deletion call in `chatId` once (e.g. 429 + retry_after). */
  failFirstDeleteIn(chatId: number, init: FakeApiErrorInit): void {
    this.failFirstDeleteInChat = chatId;
    this.firstDeleteError = init;
  }

  /** Bot loses its rights in `chatId`: 403 on every deletion there. */
  demoteBotIn(chatId: number): void {
    this.demotedChats.add(chatId);
    this.botAdmin.delete(chatId);
    const admins = this.chatAdmins.get(chatId) ?? new Set<number>();
    admins.delete(BOT_USER.id);
    this.chatAdmins.set(chatId, admins);
  }

  setBotAdminOf(chat: ChatFixture, isAdmin: boolean): void {
    if (isAdmin) this.botAdmin.add(chat.id);
    else this.botAdmin.delete(chat.id);
    const admins = this.chatAdmins.get(chat.id) ?? new Set<number>();
    if (isAdmin) admins.add(BOT_USER.id);
    else admins.delete(BOT_USER.id);
    this.chatAdmins.set(chat.id, admins);
  }

  setUserAdminOf(user: UserFixture, chat: ChatFixture, isAdmin: boolean): void {
    const admins = this.chatAdmins.get(chat.id) ?? new Set<number>();
    if (isAdmin) admins.add(user.id);
    else admins.delete(user.id);
    this.chatAdmins.set(chat.id, admins);
  }

  // ----------------------------- declarations -----------------------------

  /** Given "the bot is an admin of X": signal + membership (convention 4). */
  async botIsAdminOf(chats: ChatFixture[]): Promise<void> {
    for (const chat of chats) {
      this.setBotAdminOf(chat, true);
      await this.myChatMember(chat, "administrator");
      await this.text(USERS.admin, chat, `hello-from-${chat.id}`, at("09:00:00"));
    }
  }

  /** Given "the bot is not an admin of X". */
  async botIsNotAdminOf(chats: ChatFixture[]): Promise<void> {
    for (const chat of chats) {
      this.setBotAdminOf(chat, false);
      await this.myChatMember(chat, "member");
      await this.text(USERS.admin, chat, `hello-from-${chat.id}`, at("09:00:00"));
    }
  }

  /** Given "user U is an admin of C" (and the bot learns about the chat). */
  async userIsAdminOf(user: UserFixture, chats: ChatFixture[]): Promise<void> {
    for (const chat of chats) {
      this.setUserAdminOf(user, chat, true);
      await this.text(user, chat, `seen-${user.id}-${chat.id}`, at("09:00:01"));
    }
  }

  async userHasNoRightsIn(user: UserFixture, chats: ChatFixture[]): Promise<void> {
    for (const chat of chats) {
      this.setUserAdminOf(user, chat, false);
      await this.text(user, chat, `seen-${user.id}-${chat.id}`, at("09:00:01"));
    }
  }

  dm(user: UserFixture): ChatFixture {
    return { id: user.id, type: "private", title: user.first_name, ...(user.username ? { username: user.username } : {}) };
  }

  // ------------------------------ updates --------------------------------

  private buildMessage(
    chat: ChatFixture,
    from: UserFixture,
    messageId: number,
    date: number,
    content: Content,
    extra: Record<string, unknown> = {},
  ): Update {
    return {
      update_id: this.updateId++,
      message: {
        message_id: messageId,
        date,
        chat: { ...chat },
        from: { ...from },
        ...contentFields(content),
        ...extra,
      },
    };
  }

  /** Given "the message N from user U sent at T in C was observed by the bot". */
  async observe(spec: {
    chat: ChatFixture;
    from?: UserFixture;
    id: number;
    at?: string;
    content?: Content;
    mediaGroupId?: string;
    replyTo?: number;
    messageThread?: number;
  }): Promise<void> {
    const from = spec.from ?? USERS.author;
    const date = spec.at !== undefined ? at(spec.at) : at("10:00:00");
    const content = spec.content ?? { kind: "text", text: `text-${spec.id}` };
    const extra: Record<string, unknown> = {};
    if (spec.mediaGroupId !== undefined) extra.media_group_id = spec.mediaGroupId;
    if (spec.replyTo !== undefined) extra.reply_to_message = { message_id: spec.replyTo, date: date - 60, chat: { ...spec.chat }, from: { ...from }, text: `text-${spec.replyTo}` };
    if (spec.messageThread !== undefined) extra.message_thread_id = spec.messageThread;
    const msg: ObservedMsg = {
      chat: spec.chat,
      from,
      id: spec.id,
      date,
      content,
      ...(spec.mediaGroupId !== undefined ? { mediaGroupId: spec.mediaGroupId } : {}),
      ...(spec.replyTo !== undefined ? { replyTo: spec.replyTo } : {}),
      ...(spec.messageThread !== undefined ? { messageThread: spec.messageThread } : {}),
    };
    this.observed.set(this.key(spec.chat, spec.id), msg);
    await this.bot.handleUpdate(this.buildMessage(spec.chat, from, spec.id, date, content, extra));
  }

  /** Given "the message N … was edited to … and the edit was observed" (D45). */
  async observeEdit(spec: { chat: ChatFixture; id: number; content: Content }): Promise<void> {
    const prev = this.observed.get(this.key(spec.chat, spec.id));
    const from = prev?.from ?? USERS.author;
    const date = prev?.date ?? at("10:00:00");
    const msg: ObservedMsg = { chat: spec.chat, from, id: spec.id, date, content: spec.content };
    this.observed.set(this.key(spec.chat, spec.id), msg);
    await this.bot.handleUpdate({
      update_id: this.updateId++,
      edited_message: {
        message_id: spec.id,
        date,
        edit_date: date + 120,
        chat: { ...spec.chat },
        from: { ...from },
        ...contentFields(spec.content),
      },
    });
  }

  private key(chat: ChatFixture, id: number): string {
    return `${chat.id}:${id}`;
  }

  /** Lookup an observed source message (fixture text etc.). */
  observedMsg(chat: ChatFixture, id: number): ObservedMsg | undefined {
    return this.observed.get(this.key(chat, id));
  }

  /**
   * When "user U forwards the message N of C into T" — a forward update whose
   * origin names C (convention 1). `hidden: true` builds the hidden-sender
   * variant (S18). Content defaults to the observed message's content.
   * Returns the id of the forwarded copy in T.
   */
  async forward(spec: {
    user?: UserFixture;
    chat: ChatFixture;
    id: number;
    into: ChatFixture;
    hidden?: boolean;
    at?: string;
    content?: Content;
    date?: number;
    from?: UserFixture;
    forwardId?: number;
  }): Promise<number> {
    const user = spec.user ?? USERS.author;
    const src = this.observed.get(this.key(spec.chat, spec.id));
    const from = spec.from ?? src?.from ?? user;
    const date = spec.date ?? src?.date ?? at(spec.at ?? "10:00:00");
    const content = spec.content ?? src?.content ?? { kind: "text", text: `text-${spec.id}` };
    const forwardId = spec.forwardId ?? this.nextForwardId++;
    const origin = spec.hidden
      ? { type: "hidden_user", sender_user_name: "Hidden User", date }
      : { type: "user", sender_user: { ...from }, date, chat: { ...spec.chat }, sender_chat: { ...spec.chat } };
    const extra: Record<string, unknown> = {
      forward_origin: origin,
      ...(src?.mediaGroupId !== undefined ? { media_group_id: src.mediaGroupId } : {}),
    };
    await this.bot.handleUpdate(
      this.buildMessage(spec.into, user, forwardId, date + 60, content, extra),
    );
    return forwardId;
  }

  /** Forwards several source messages one by one ("forwards the messages …"). */
  async forwardMany(spec: {
    user?: UserFixture;
    chat: ChatFixture;
    ids: number[];
    into: ChatFixture;
    at?: string;
    contents?: Record<number, Content>;
  }): Promise<number[]> {
    const ids: number[] = [];
    for (const id of spec.ids) {
      ids.push(
        await this.forward({
          ...(spec.user !== undefined ? { user: spec.user } : {}),
          chat: spec.chat,
          id,
          into: spec.into,
          ...(spec.at !== undefined ? { at: spec.at } : {}),
          ...(spec.contents?.[id] !== undefined ? { content: spec.contents[id] } : {}),
        }),
      );
    }
    return ids;
  }

  /** Ordinary text message (dialog answers, commands). */
  async text(user: UserFixture, chat: ChatFixture, body: string, dateSec?: number): Promise<void> {
    await this.bot.handleUpdate(
      this.buildMessage(chat, user, this.nextForwardId++, dateSec ?? this.nowSec(), { kind: "text", text: body }),
    );
  }

  async command(user: UserFixture, chat: ChatFixture, body: string): Promise<void> {
    await this.text(user, chat, body);
  }

  async callback(user: UserFixture, chat: ChatFixture, data: string, messageId = 0): Promise<void> {
    await this.bot.handleUpdate({
      update_id: this.updateId++,
      callback_query: {
        id: `cb-${this.updateId}`,
        from: { ...user },
        message: { message_id: messageId, date: this.nowSec(), chat: { ...chat }, from: { ...BOT_USER } },
        chat_instance: "ci-1",
        data,
      },
    });
  }

  /** Given "the bot is an admin of X" signal (convention 4). */
  async myChatMember(chat: ChatFixture, status: "administrator" | "member"): Promise<void> {
    await this.bot.handleUpdate({
      update_id: this.updateId++,
      my_chat_member: {
        chat: { ...chat },
        from: { ...USERS.admin },
        date: this.nowSec(),
        old_chat_member: { status: "left", user: { ...BOT_USER } },
        new_chat_member: {
          status,
          user: { ...BOT_USER },
          ...(status === "administrator" ? { can_delete_messages: true } : {}),
        },
      },
    });
  }

  // ---------------------------- /settings flow ----------------------------

  async openSettings(as: UserFixture = USERS.admin): Promise<void> {
    await this.command(as, this.dm(as), "/settings");
  }

  buttons(chatId: number): Button[] {
    const out: Button[] = [];
    for (const call of [...this.api.callsOf("sendMessage"), ...this.api.callsOf("editMessageText")]) {
      if (call.payload.chat_id !== chatId) continue;
      const keyboard = call.payload.reply_markup as any;
      if (!keyboard || !Array.isArray(keyboard.inline_keyboard)) continue;
      for (const row of keyboard.inline_keyboard) {
        for (const btn of row ?? []) {
          if (btn && typeof btn.callback_data === "string") {
            out.push({
              text: String(btn.text ?? ""),
              data: btn.callback_data,
              call,
              messageId: this.messageIdOf(call),
            });
          }
        }
      }
    }
    return out;
  }

  /** Result id of a sendMessage call (fake API returns it as message_id). */
  messageIdOf(call: RecordedCall): number {
    if (call.method === "editMessageText") return Number(call.payload.message_id ?? 0);
    const sends = this.api.callsOf("sendMessage");
    const idx = sends.indexOf(call);
    return idx >= 0 && idx < this.sentIds.length ? this.sentIds[idx] : 0;
  }

  /** Locate the settings button for `chat` performing `action` (convention 6). */
  settingsButton(chat: ChatFixture, action: "source" | "threads" | "disconnect" | string): Button {
    const candidates = this.buttons(USERS.admin.id).filter((b) => refersToChat(b.data, chat.id));
    const score = (b: Button): number => {
      const d = b.data.toLowerCase();
      if (action === "source") {
        let s = /source|src|connect|from|add/.test(d) ? 2 : 0;
        if (/thread|dst|dest|target|disc|off|remove|leave|del/.test(d)) s -= 3;
        return s;
      }
      if (action === "threads") {
        let s = /thread|dst|dest|target|to/.test(d) ? 2 : 0;
        if (/disc|off|remove|leave|del|source|src|connect/.test(d)) s -= 3;
        return s;
      }
      if (action === "disconnect") {
        return /disc|off|remove|leave|del|un/.test(d) ? 2 : -3;
      }
      return d.includes(action.toLowerCase()) || /lang|locale/.test(d) ? 2 : -3;
    };
    const best = [...candidates].sort((a, b) => score(b) - score(a))[0];
    if (!best || score(best) <= 0) {
      throw new Error(
        `settings: no '${action}' button referencing ${chat.title} (${chat.id}); ` +
          `observed callback_data: ${candidates.map((b) => b.data).join(" | ") || "<none>"}`,
      );
    }
    return best;
  }

  async pressSettingsButton(
    chat: ChatFixture,
    action: "source" | "threads" | "disconnect" | string,
    as: UserFixture = USERS.admin,
  ): Promise<void> {
    await this.openSettings(as);
    const button = this.settingsButton(chat, action);
    await this.callback(as, this.dm(as), button.data, button.messageId);
    await this.pressConfirmRounds(as);
  }

  /** Follow-up "confirm" buttons (convention 6, same as the security tests). */
  private async pressConfirmRounds(as: UserFixture): Promise<void> {
    const pressed = new Set<string>();
    for (let round = 0; round < 2; round++) {
      const candidates = this.buttons(as.id).filter(
        (b) => !pressed.has(b.data) && /confirm|apply|done|yes|ok/i.test(b.data),
      );
      if (candidates.length === 0) return;
      for (const button of candidates) {
        pressed.add(button.data);
        await this.callback(as, this.dm(as), button.data, button.messageId);
      }
    }
  }

  /** Given "X is connected as a source chat". */
  async connectSource(chat: ChatFixture): Promise<void> {
    await this.pressSettingsButton(chat, "source");
  }

  /** Given "X is connected as the threads chat". */
  async connectThreads(chat: ChatFixture): Promise<void> {
    await this.pressSettingsButton(chat, "threads");
  }

  /** When "user U disconnects X". */
  async disconnectSource(chat: ChatFixture): Promise<void> {
    await this.pressSettingsButton(chat, "disconnect");
  }

  /** When "user U switches the language to 'ru'". */
  async switchLang(user: UserFixture, lang: string): Promise<void> {
    await this.openSettings(user);
    const all = this.buttons(user.id);
    const button = [...all]
      .map((b) => ({ b, score: (b.data.toLowerCase().includes(lang.toLowerCase()) ? 2 : 0) + (/lang|locale/i.test(b.data) ? 1 : 0) }))
      .sort((x, y) => y.score - x.score)[0];
    if (!button || button.score <= 0) {
      throw new Error(
        `settings: no language button for '${lang}'; observed callback_data: ` +
          (all.map((b) => b.data).join(" | ") || "<none>"),
      );
    }
    await this.callback(user, this.dm(user), button.b.data, button.b.messageId);
    await this.pressConfirmRounds(user);
  }

  // ---------------------------- transfer dialog ---------------------------

  dialogReplies(chatId: number): RecordedCall[] {
    return [...this.api.callsOf("sendMessage"), ...this.api.callsOf("editMessageText")].filter((c) => {
      if (c.payload.chat_id !== chatId) return false;
      const kb = c.payload.reply_markup as any;
      return kb && Array.isArray(kb.inline_keyboard) && kb.inline_keyboard.length > 0;
    });
  }

  /** Press the (newest) dialog button that picks the source chat (D77). */
  async pickChat(chat: ChatFixture, as: UserFixture = USERS.author, into: ChatFixture = CHATS.threads): Promise<void> {
    const matches = this.buttons(into.id).filter((b) => refersToChat(b.data, chat.id));
    const button = matches[matches.length - 1];
    if (!button) {
      throw new Error(
        `pickChat: no dialog button referencing ${chat.title} (${chat.id}); ` +
          `observed callback_data: ${matches.map((b) => b.data).join(" | ") || "<none>"}`,
      );
    }
    await this.callback(as, into, button.data, button.messageId);
  }

  /**
   * Send the thread title (the transfer starts immediately, D67/D50).
   * The root message gets id 42 unless given (fixture convention 7).
   */
  async sendTitle(title: string, as: UserFixture = USERS.author, into: ChatFixture = CHATS.threads, rootId = 42): Promise<void> {
    this.setNextBotMessageId(rootId);
    await this.text(as, into, title);
  }

  /** "user U picks C and sends the text 'Title'" (step vocabulary §2). */
  async completeDialog(spec: { chat: ChatFixture; title: string; as?: UserFixture; into?: ChatFixture }): Promise<void> {
    const into = spec.into ?? CHATS.threads;
    await this.pickChat(spec.chat, spec.as ?? USERS.author, into);
    await this.sendTitle(spec.title, spec.as ?? USERS.author, into);
  }

  /**
   * Run a whole prior transfer (Given "a thread … was already created …").
   * Seeds the source message unless already observed.
   */
  async createPriorThread(spec: {
    title: string;
    rootId?: number;
    sourceChat: ChatFixture;
    sourceIds: number[];
    threadsChat?: ChatFixture;
    author?: UserFixture;
  }): Promise<void> {
    const into = spec.threadsChat ?? CHATS.threads;
    const author = spec.author ?? USERS.author;
    for (const id of spec.sourceIds) {
      if (!this.observedMsg(spec.sourceChat, id)) {
        await this.observe({ chat: spec.sourceChat, from: author, id, at: "10:00:00" });
      }
    }
    await this.forwardMany({ user: author, chat: spec.sourceChat, ids: spec.sourceIds, into });
    this.setNextBotMessageId(spec.rootId ?? 42);
    await this.pickChat(spec.sourceChat, author);
    await this.text(author, into, spec.title);
  }

  // ---------------------------- introspection -----------------------------

  mark(): number {
    return this.api.calls.length;
  }

  /** Clears the recorded call log (Background setup noise) — ids keep flowing. */
  resetCalls(): void {
    this.api.calls.length = 0;
    this.callTimes.length = 0;
    this.sentIds.length = 0;
  }

  callsSince(mark: number): RecordedCall[] {
    return this.api.calls.slice(mark);
  }

  /** All sendMessage texts to a chat (or everywhere). */
  texts(chatId?: number): string[] {
    return this.api
      .callsOf("sendMessage")
      .filter((c) => chatId === undefined || c.payload.chat_id === chatId)
      .map((c) => String(c.payload.text ?? ""));
  }

  /** A sendMessage whose text is exactly `body`. */
  hasExactText(chatId: number, body: string): boolean {
    return this.api
      .callsOf("sendMessage")
      .some((c) => c.payload.chat_id === chatId && String(c.payload.text ?? "") === body);
  }

  deletedIds(chatId: number): number[] {
    const ids: number[] = [];
    for (const call of this.api.calls) {
      if (call.method === "deleteMessage" && call.payload.chat_id === chatId) {
        ids.push(Number(call.payload.message_id));
      }
      if (call.method === "deleteMessages" && call.payload.chat_id === chatId) {
        ids.push(...(call.payload.message_ids as unknown[]).map(Number));
      }
    }
    return ids;
  }

  /** Normalized content posts into `chatId` in call order (convention 10). */
  threadPosts(chatId: number): ThreadPost[] {
    const out: ThreadPost[] = [];
    for (const call of this.api.calls) {
      if (call.payload.chat_id !== chatId) continue;
      if (call.method === "sendMessage") {
        out.push({ kind: "text", text: String(call.payload.text ?? ""), call });
      } else if (call.method === "copyMessage") {
        out.push({ kind: "ref", ids: [Number(call.payload.message_id)], call });
      } else if (call.method === "copyMessages") {
        out.push({ kind: "ref", ids: (call.payload.message_ids as unknown[]).map(Number), call });
      }
    }
    return out;
  }

  /**
   * Thread-body posts of one transfer (D87): every content post into `chatId`
   * at/after `mark` except the root (the title message, id `rootId` — fixture
   * convention 7). Each of them must be a reply to the root.
   */
  bodyPostsSince(chatId: number, mark: number, rootId = 42): ThreadPost[] {
    return this.threadPosts(chatId).filter(
      (p) => this.api.calls.indexOf(p.call) >= mark && this.messageIdOf(p.call) !== rootId,
    );
  }

  /**
   * Sequence of source-message markers posted into the thread: reference ids
   * (copyMessage/copyMessages) or the id whose fixture text/caption matches a
   * sent text (sendMessage-based copies). Accepts either copy mechanism.
   */
  copyMarkerSeq(chatId: number): number[] {
    const seq: number[] = [];
    for (const post of this.threadPosts(chatId)) {
      if (post.kind === "ref") {
        seq.push(...post.ids);
      } else {
        const id = this.markerTextId(post.text);
        if (id !== undefined) seq.push(id);
      }
    }
    return seq;
  }

  /** Id of the observed message whose text/caption equals `text` (copy marker). */
  private markerTextId(text: string): number | undefined {
    for (const [, msg] of this.observed) {
      const t =
        msg.content.kind === "text"
          ? msg.content.text
          : msg.content.kind === "photo"
            ? msg.content.caption
            : undefined;
      if (t !== undefined && t === text) return msg.id;
    }
    return undefined;
  }

  /** Source-message markers carried by one thread post (copy refs or matched text). */
  postMarkers(post: ThreadPost): number[] {
    if (post.kind === "ref") return post.ids;
    const id = this.markerTextId(post.text);
    return id !== undefined ? [id] : [];
  }

  /**
   * Markers of one thread, identified by being replies to the thread root
   * (D87: the thread is a reply chain; `message_thread_id` is never used for
   * thread assembly — the old D44 reading is superseded).
   */
  threadMarkers(rootId: number): number[] {
    const seq: number[] = [];
    for (const call of this.api.calls) {
      if (this.replyToOf(call) !== rootId) continue;
      if (call.method === "sendMessage") {
        const id = this.markerTextId(String(call.payload.text ?? ""));
        if (id !== undefined) seq.push(id);
      } else if (call.method === "copyMessage") {
        seq.push(Number(call.payload.message_id));
      } else if (call.method === "copyMessages") {
        seq.push(...(call.payload.message_ids as unknown[]).map(Number));
      }
    }
    return seq;
  }

  /** Message id a sendMessage call replies to (reply_to_message_id / reply_parameters). */
  replyToOf(call: RecordedCall): number | undefined {
    const direct = call.payload.reply_to_message_id;
    if (direct !== undefined) return Number(direct);
    const params = call.payload.reply_parameters as any;
    if (params && params.message_id !== undefined) return Number(params.message_id);
    return undefined;
  }

  /**
   * D87: the call posts a thread-body message — it is a reply to a bot-created
   * message that itself replies to nothing (the thread root). Replies to user
   * messages (dialog replies to forwards) and forum-topic announces
   * (`message_thread_id`, D18/D69) are not thread-body messages.
   */
  isThreadBodyCall(call: RecordedCall): boolean {
    const target = this.replyToOf(call);
    if (target === undefined) return false;
    const root = this.botSendById.get(`${Number(call.payload.chat_id)}:${target}`);
    return root !== undefined && root.replyTo === undefined;
  }

  /** Calls (of the given methods) after a mark, with their clock samples. */
  timedCallsSince(mark: number, methods?: string[]): Array<{ call: RecordedCall; time: number }> {
    const out: Array<{ call: RecordedCall; time: number }> = [];
    for (let i = mark; i < this.api.calls.length; i++) {
      const call = this.api.calls[i];
      if (methods && !methods.includes(call.method)) continue;
      out.push({ call, time: this.callTimes[i] ?? 0 });
    }
    return out;
  }
}

/** D89: the announce message call posted into `sourceChatId` (the only bot
 * message the transfer posts into the source chat — "Thread created …"). */
export function announceCallIn(ctx: Ctx, sourceChatId: number): RecordedCall | undefined {
  return ctx.api.callsOf("sendMessage").find((c) => c.payload.chat_id === sourceChatId);
}

/** D89: the closing-message call in `threadsChatId` ("{title} — moved from …"). */
export function closingCallIn(ctx: Ctx, threadsChatId: number): RecordedCall | undefined {
  return ctx.api
    .callsOf("sendMessage")
    .find((c) => c.payload.chat_id === threadsChatId && /moved from/.test(String(c.payload.text ?? "")));
}

export async function boot(opts: BootOptions = {}): Promise<Ctx> {
  if (opts.fakeTimers) {
    vi.useFakeTimers({ now: at(opts.time ?? "10:00:00") * 1000 });
  }
  // @ts-ignore src/config.ts does not exist until T7 (plan §7.1) — expected RED state.
  const { loadConfig } = await import("../../src/config");
  // @ts-ignore src/store/in-memory.ts does not exist until T7 (plan §7.2) — expected RED state.
  const { InMemoryStore } = await import("../../src/store/in-memory");
  // @ts-ignore src/bot/createBot.ts does not exist until T7 (plan §7.3) — expected RED state.
  const { createBot } = await import("../../src/bot/createBot");

  const config = loadConfig({ ...ENV_BASE, ...opts.env });
  const { store, writes } = recordingStore(new InMemoryStore());
  const logRecords: LogRecord[] = [];
  // Injected clock: `now` delegates to the harness Ctx (never the real clock).
  let ctxRef: Ctx | null = null;
  const bot = createBot({
    store,
    now: () => new Date(ctxRef !== null ? ctxRef.nowMs() : at(opts.time ?? "10:00:00") * 1000),
    logger: makeLogger(logRecords),
    config,
  });
  const api = new FakeBotApi();

  const ctx = new Ctx(opts, bot, api, store, writes, logRecords, config);
  ctxRef = ctx;
  bot.api.config.use((prev: any, method: any, payload: any) => {
    ctx.callTimes.push(ctx.nowMs());
    return api.transformer(prev, method, payload);
  });
  await bot.init();
  return ctx;
}

/** Undo harness-level fake timers (use in afterEach of retry_after tests). */
export function cleanup(): void {
  vi.useRealTimers();
}

/** Raw catalog identifiers / unresolved placeholders (S79). */
export function stripUrls(t: string): string {
  return t.replace(/https?:\/\/\S+/g, " ").replace(/\bt\.me\/\S+/g, " ");
}

export function hasRawCatalogId(t: string): boolean {
  return /\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b/.test(stripUrls(t));
}

export function hasUnresolvedPlaceholder(t: string): boolean {
  return /\{[a-zA-Z_][a-zA-Z0-9_]*\}/.test(t);
}

export function hasCyrillic(t: string): boolean {
  return /[А-Яа-яЁё]/.test(t);
}

/** "no message contains a raw error dump" (S59/S74) — SEC-2 style leak scan. */
export function leaksRawError(t: string): boolean {
  return /\bat\s+[\w$.<>[\]]+\(.*:\d+:\d+\)|GrammyError|TypeError|ReferenceError|node_modules|error_code|at Object\./.test(t);
}
