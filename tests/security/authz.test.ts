/**
 * Security tests — authorization: who may trigger deletions at all.
 *
 * Test-ID map ↔ docs/risk-register.md security section (R48+):
 *   SEC-1 → R3/R48 (non-admin initiating a transfer): a member who is not an
 *           admin of the chosen source chat is refused and NOTHING is deleted
 *   SEC-2 → R11 (bot loses delete rights mid-flow): fail safe — no crash, no
 *           stack traces / secrets in user-visible output
 *   SEC-3 → R49 (non-global-admin /settings + client-side button forgery):
 *           refused, no admin UI exposed, no state change
 *
 * Contract under test (docs/plan.md §7): `src/bot/createBot.ts` —
 *   createBot(deps: { store; now; logger; config }): Bot
 * plus `src/config.ts` (loadConfig) and `src/store/in-memory.ts` (InMemoryStore).
 *
 * RED note: those modules do not exist until T7. They are imported dynamically
 * so every test fails individually with "module missing" (the expected RED
 * state); `@ts-ignore` keeps `npm run typecheck` clean until then.
 *
 * Fixtures below are self-contained; the only external test helper used is the
 * fake Bot API (tests/helpers/fake-bot-api.ts, plan D13).
 */
import { describe, expect, test } from "vitest";
import { FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, type RecordedCall } from "../helpers/fake-bot-api";

// ------------------------------- actors ------------------------------------

const BOT_USER_ID = 1; // the fake getMe reports the bot as user id 1
const GLOBAL_ADMIN = { id: 900001, is_bot: false, first_name: "Global Admin", username: "gadmin" };
const SOURCE_ADMIN = { id: 900002, is_bot: false, first_name: "Source Admin", username: "sadmin" };
const ATTACKER = { id: 900004, is_bot: false, first_name: "Attacker", username: "attacker" };

const SOURCE_A = { id: -1001110000001, type: "supergroup", title: "Source A" };
const THREADS = { id: -1001110000003, type: "supergroup", title: "Threads" };
const DM = { id: GLOBAL_ADMIN.id, type: "private" };

const BOT_USER = { id: BOT_USER_ID, is_bot: true, first_name: "Test Bot", username: "test_bot" };

const SECRET_MARKERS = [TEST_BOT_TOKEN, "TEST-TOKEN", "sup3r-secret-pw"];

const ENV: Record<string, string> = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads",
  ADMIN_IDS: String(GLOBAL_ADMIN.id),
  MODE: "polling",
};

// ------------------------------ update builders -----------------------------

type Update = any;

let nextUpdateId = 1;

function messageUpdate(opts: {
  chat: { id: number; type: string; title?: string };
  from: { id: number; is_bot?: boolean; first_name?: string; username?: string };
  messageId: number;
  date?: number;
  text?: string;
  forwardOrigin?: unknown;
}): Update {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: opts.messageId,
      date: opts.date ?? FIXED_DATE,
      chat: opts.chat,
      from: opts.from,
      ...(opts.text !== undefined ? { text: opts.text } : {}),
      ...(opts.forwardOrigin !== undefined ? { forward_origin: opts.forwardOrigin } : {}),
    },
  };
}

/** An indexed source-chat message: the bot observes it and indexes it (plan §7.4). */
function original(messageId: number, text: string, date: number): Update {
  return messageUpdate({ chat: SOURCE_A, from: SOURCE_ADMIN, messageId, text, date });
}

/** A forwarded copy of a source message arriving in the threads chat (D21). */
function forwarded(messageId: number, text: string, date: number): Update {
  return messageUpdate({
    chat: THREADS,
    from: SOURCE_ADMIN,
    messageId,
    text,
    forwardOrigin: { type: "user", sender_user: SOURCE_ADMIN, date },
  });
}

function textMessage(chat: { id: number; type: string }, from: { id: number }, messageId: number, text: string): Update {
  return messageUpdate({ chat: chat as any, from: from as any, messageId, text });
}

function commandUpdate(chat: { id: number; type: string }, from: { id: number }, text: string, messageId: number): Update {
  return messageUpdate({ chat: chat as any, from: from as any, messageId, text });
}

function callbackUpdate(opts: {
  from: { id: number; is_bot?: boolean; first_name?: string };
  chat: { id: number; type: string };
  messageId: number;
  data?: string;
}): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb-${nextUpdateId}`,
      from: opts.from,
      message: {
        message_id: opts.messageId,
        date: FIXED_DATE,
        chat: opts.chat,
        from: BOT_USER,
      },
      chat_instance: "ci-1",
      ...(opts.data !== undefined ? { data: opts.data } : {}),
    },
  };
}

// --------------------------- fake logger (SEC-2/8) --------------------------

function makeLogger(records: Array<{ level: string; args: unknown[] }>): any {
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

// --------------------------- recording store (SEC-3) ------------------------

const WRITE_VERB =
  /^(add|create|insert|save|upsert|put|append|set|write|record|store|index|track|link|map|attach|push|delete|remove|update|mark|touch|clear|reset|merge|bind|bump|note)/i;

/** Wraps a Store so every mutation-method call is recorded by name. */
function recordingStore(raw: unknown): { store: any; writeCalls: string[] } {
  const writeCalls: string[] = [];
  const wrap = (target: any, path: string): any => {
    if (target === null || typeof target !== "object") return target;
    if (target instanceof Promise) return target;
    return new Proxy(target, {
      get(t: any, prop): unknown {
        if (typeof prop !== "string") return t[prop];
        const value = t[prop]; // read on the raw target: safe for private fields
        if (typeof value === "function") {
          return (...args: unknown[]): unknown => {
            if (WRITE_VERB.test(prop)) writeCalls.push(`${path}.${prop}`);
            return value.apply(t, args);
          };
        }
        return wrap(value, `${path}.${prop}`);
      },
    });
  };
  return { store: wrap(raw, "store"), writeCalls };
}

// ------------------------------- boot (T7) ---------------------------------

async function bootBot(): Promise<{
  bot: any;
  api: FakeBotApi;
  writeCalls: string[];
  logRecords: Array<{ level: string; args: unknown[] }>;
}> {
  // @ts-ignore src/config.ts does not exist until T7 (plan §7.1) — expected RED state.
  const { loadConfig } = await import("../../src/config");
  // @ts-ignore src/store/in-memory.ts does not exist until T7 (plan §7.2) — expected RED state.
  const { InMemoryStore } = await import("../../src/store/in-memory");
  // @ts-ignore src/bot/createBot.ts does not exist until T7 (plan §7.3) — expected RED state.
  const { createBot } = await import("../../src/bot/createBot");

  const config = loadConfig(ENV);
  const { store, writeCalls } = recordingStore(new InMemoryStore());
  const logRecords: Array<{ level: string; args: unknown[] }> = [];
  const bot = createBot({
    store,
    now: () => new Date(FIXED_DATE * 1000),
    logger: makeLogger(logRecords),
    config,
  } as any);
  const api = new FakeBotApi();
  bot.api.config.use(api.transformer);
  await bot.init();
  return { bot, api, writeCalls, logRecords };
}

/**
 * Coarse membership fake: the bot and SOURCE_ADMIN are administrators with
 * delete rights in every chat; every other user is a plain member. This is what
 * isolates SEC-1: the only difference between the positive control and the
 * attack is the identity of the forward author.
 */
function installMembershipFake(api: FakeBotApi): void {
  api.setMethodResult("getChatMember", (p: any) => ({
    status: p.user_id === BOT_USER_ID || p.user_id === SOURCE_ADMIN.id ? "administrator" : "member",
    user: { id: p.user_id ?? 0, is_bot: p.user_id === BOT_USER_ID, first_name: "U" },
    can_delete_messages: p.user_id === BOT_USER_ID || p.user_id === SOURCE_ADMIN.id,
  }));
  api.setMethodResult("getChatAdministrators", () => [
    { status: "administrator", user: BOT_USER, can_delete_messages: true, is_anonymous: false },
    { status: "administrator", user: SOURCE_ADMIN, can_delete_messages: true, is_anonymous: false },
  ]);
}

// -------------------------- fake Bot API introspection ----------------------

/**
 * The fake Bot API hands out message ids sequentially from 1000 (one per
 * created message). Reproduce that sequence to learn the id a call received,
 * so callback updates can reference the real dialog message.
 */
function messageIdFor(api: FakeBotApi, target: RecordedCall): number {
  let next = 1000;
  for (const call of api.calls) {
    let n = 0;
    switch (call.method) {
      case "sendMessage":
      case "editMessageText":
      case "copyMessage":
      case "forwardMessage":
        n = 1;
        break;
      case "copyMessages":
        n = (call.payload.message_ids as unknown[] | undefined)?.length ?? 0;
        break;
    }
    const got = next;
    next += n;
    if (call === target) return got;
  }
  throw new Error("messageIdFor: call not recorded");
}

interface Button {
  text: string;
  data: string;
  call: RecordedCall;
}

/** All inline buttons the bot rendered in a chat (sendMessage + editMessageText). */
function flatButtons(api: FakeBotApi, chatId: number): Button[] {
  const out: Button[] = [];
  for (const call of [...api.callsOf("sendMessage"), ...api.callsOf("editMessageText")]) {
    if (call.payload.chat_id !== chatId) continue;
    const keyboard = call.payload.reply_markup as any;
    if (!keyboard || !Array.isArray(keyboard.inline_keyboard)) continue;
    for (const row of keyboard.inline_keyboard) {
      for (const btn of row ?? []) {
        if (btn && typeof btn.callback_data === "string") {
          out.push({ text: String(btn.text ?? ""), data: btn.callback_data, call });
        }
      }
    }
  }
  return out;
}

function refersToChat(data: string, chatId: number): boolean {
  return data.includes(String(chatId)) || data.includes(String(Math.abs(chatId)));
}

async function pressButton(
  bot: any,
  api: FakeBotApi,
  button: Button,
  from: { id: number; is_bot?: boolean; first_name?: string },
  chat: { id: number; type: string },
): Promise<void> {
  await bot.handleUpdate(
    callbackUpdate({ from, chat, messageId: messageIdFor(api, button.call), data: button.data }),
  );
}

// --------------------------- /settings connection (D11) ---------------------

/**
 * D79 fixture plumbing (mirror of the acceptance `botIsAdminOf` seeding):
 * `/settings` chat discovery lists only chats the bot has OBSERVED with admin
 * membership (Telegram has no "list my chats" API), so the discovery signal —
 * a `my_chat_member` update with admin status plus one observed message from
 * the chat — is driven in before the /settings dialog. Fixture plumbing only:
 * the security properties under test are exactly as strict as before.
 */
function myChatMemberUpdate(chat: { id: number; type: string; title?: string }): Update {
  return {
    update_id: nextUpdateId++,
    my_chat_member: {
      chat: { ...chat },
      from: { ...GLOBAL_ADMIN },
      date: FIXED_DATE,
      old_chat_member: { status: "left", user: { ...BOT_USER } },
      new_chat_member: { status: "administrator", user: { ...BOT_USER }, can_delete_messages: true },
    },
  };
}

/** Inbound fixture message ids for discovery seeding (clear of all test ids). */
let nextSeedMessageId = 30_001;

async function seedDiscovery(bot: any, chat: { id: number; type: string; title?: string }): Promise<void> {
  await bot.handleUpdate(myChatMemberUpdate(chat));
  await bot.handleUpdate(
    messageUpdate({ chat, from: GLOBAL_ADMIN, messageId: nextSeedMessageId++, text: `hello-from-${chat.id}` }),
  );
}

/**
 * Chats are connected only through the DM /settings dialog (D11). These tests
 * discover the buttons from the reply markup the bot itself renders and press
 * those whose callback_data references the target chat id, following up on
 * confirm keyboards for a few rounds. No callback_data format is hard-coded;
 * if an implementation encodes chat identity differently, this helper and the
 * acceptance tests must be updated together.
 */
async function connectChat(bot: any, api: FakeBotApi, chat: { id: number; type: string; title?: string }): Promise<void> {
  await seedDiscovery(bot, chat); // D79: the chat must be observed before /settings can list it
  await bot.handleUpdate(commandUpdate(DM, GLOBAL_ADMIN, "/settings", nextUpdateId));
  const pressed = new Set<string>();
  for (let round = 0; round < 4; round++) {
    const candidates = flatButtons(api, DM.id).filter(
      (b) => !pressed.has(b.data) && (refersToChat(b.data, chat.id) || (pressed.size > 0 && /confirm|apply|done|yes|ok/i.test(b.data))),
    );
    if (candidates.length === 0) break;
    for (const button of candidates) {
      pressed.add(button.data);
      await pressButton(bot, api, button, GLOBAL_ADMIN, DM);
    }
  }
  if (pressed.size === 0) {
    throw new Error(
      `connectChat: /settings rendered no button referencing chat ${chat.id}; ` +
        `observed callback_data: ${flatButtons(api, DM.id).map((b) => b.data).join(" | ") || "<none>"}`,
    );
  }
}

/** Press the (newest) dialog button that picks the source chat for the transfer (AC2). */
async function pickSourceChat(bot: any, api: FakeBotApi, chat: { id: number }, author: { id: number }): Promise<void> {
  const matches = flatButtons(api, THREADS.id).filter((b) => refersToChat(b.data, chat.id));
  const button = matches[matches.length - 1];
  if (!button) {
    throw new Error(
      `pickSourceChat: no dialog button referencing chat ${chat.id}; ` +
        `observed callback_data: ${flatButtons(api, THREADS.id).map((b) => b.data).join(" | ") || "<none>"}`,
    );
  }
  await pressButton(bot, api, button, author as any, THREADS);
}

async function feed(bot: any, updates: Update[]): Promise<void> {
  for (const update of updates) {
    await bot.handleUpdate(update); // must never throw (no crash on user input)
  }
}

function destructiveCalls(api: FakeBotApi): RecordedCall[] {
  return api.calls.filter((c) => /^(delete|copy|forward)/.test(c.method));
}

function replyTexts(api: FakeBotApi, chatId: number): string[] {
  return api.callsOf("sendMessage")
    .filter((c) => c.payload.chat_id === chatId)
    .map((c) => String(c.payload.text ?? ""));
}

// ================================== SEC-1 ===================================

describe("SEC-1 (R3/R48): non-admin transfer is refused, nothing is deleted", () => {
  test("an ordinary member cannot move messages; a source-chat admin can (positive control)", async () => {
    const { bot, api } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, THREADS);

    // --- positive control: the very same flow works for the source-chat admin
    const d0 = FIXED_DATE + 10;
    await feed(bot, [original(11, "alpha", d0), original(12, "beta", d0 + 1)]);
    await feed(bot, [forwarded(501, "alpha", d0), forwarded(502, "beta", d0 + 1)]);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 503, "Control thread")]);
    expect(
      destructiveCalls(api).length,
      "positive control: an admin transfer must delete copies/originals",
    ).toBeGreaterThan(0);

    // --- attack: an ordinary member replays the same shape with fresh messages
    const mark = api.calls.length;
    const d1 = FIXED_DATE + 20;
    await feed(bot, [original(13, "gamma", d1), original(14, "delta", d1 + 1)]);
    await feed(bot, [forwarded(504, "gamma", d1), forwarded(505, "delta", d1 + 1)]);
    await feed(bot, [textMessage(THREADS, ATTACKER, 506, "Attack thread")]);

    const after = api.calls.slice(mark);
    expect(after.filter((c) => /^delete/.test(c.method)), "attacker run: no deletions").toEqual([]);
    expect(after.filter((c) => /^copy/.test(c.method)), "attacker run: no thread copies").toEqual([]);
    expect(
      after.filter((c) => c.method === "sendMessage").length,
      "attacker run: a user-visible refusal is required (AC11)",
    ).toBeGreaterThan(0);
  });
});

// ================================== SEC-2 ===================================

describe("SEC-2 (R11): losing delete rights fails safe, no internals leak", () => {
  test("403 on deletion mid-transfer: no crash, no stack traces or secrets in chat output", async () => {
    const { bot, api } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, THREADS);

    // every deletion fails as if the bot was demoted
    api.setMethodError("deleteMessage", { error_code: 403, description: "Forbidden: bot was kicked" });
    api.setMethodError("deleteMessages", { error_code: 403, description: "Forbidden: bot was kicked" });

    const d0 = FIXED_DATE + 30;
    await feed(bot, [original(21, "one", d0), original(22, "two", d0 + 1)]);
    await feed(bot, [forwarded(601, "one", d0), forwarded(602, "two", d0 + 1)]);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 603, "Demoted run")]); // must not throw

    const texts = [...replyTexts(api, THREADS.id), ...replyTexts(api, SOURCE_A.id)];
    expect(texts.length, "a failure report must be visible somewhere (AC11)").toBeGreaterThan(0);
    const leak = /\bat\s+[\w$.<>[\]]+\(.*:\d+:\d+\)|GrammyError|TypeError|ReferenceError|node_modules/;
    for (const text of texts) {
      expect(leak.test(text), `user-visible text leaks internals: ${text}`).toBe(false);
      for (const marker of SECRET_MARKERS) {
        expect(text.includes(marker), `user-visible text leaks secret material: ${text}`).toBe(false);
      }
    }
  });
});

// ================================== SEC-3 ===================================

describe("SEC-3 (R49): non-global admins cannot change settings, even with forged buttons", () => {
  test("/settings by a non-admin shows no admin UI and forges no state change", async () => {
    const { bot, api, writeCalls } = await bootBot();
    installMembershipFake(api);
    await feed(bot, [messageUpdate({ chat: SOURCE_A, from: SOURCE_ADMIN, messageId: 71, text: "hi" })]);

    // --- /settings by an ordinary member: refused, no admin UI, no writes
    writeCalls.length = 0;
    await feed(bot, [commandUpdate(DM, ATTACKER, "/settings", 72)]);
    const replies = api.callsOf("sendMessage").filter((c) => c.payload.chat_id === DM.id);
    expect(replies.length, "a refusal reply is required (AC1/AC11)").toBeGreaterThan(0);
    for (const reply of replies) {
      const keyboard = reply.payload.reply_markup as any;
      expect(keyboard?.inline_keyboard ?? [], "non-admin must not receive admin buttons").toEqual([]);
    }
    expect(writeCalls, "/settings from a non-admin must not change state").toEqual([]);
    expect(api.calls.filter((c) => /^(delete|copy|forward)/.test(c.method))).toEqual([]);

    // --- client-side button forgery: the attacker replays a real admin button
    await feed(bot, [commandUpdate(DM, GLOBAL_ADMIN, "/settings", 73)]);
    const adminButtons = flatButtons(api, DM.id);
    if (adminButtons.length === 0) {
      throw new Error(
        "/settings must render inline buttons for a global admin (AC1); " +
          "observed callback_data: <none>",
      );
    }
    const mark = api.calls.length;
    writeCalls.length = 0;
    await pressButton(bot, api, adminButtons[0], ATTACKER, DM);
    const duringForgery = api.calls.slice(mark).filter((c) => c.method !== "answerCallbackQuery");
    expect(duringForgery.filter((c) => /^(delete|copy|forward)/.test(c.method))).toEqual([]);
    expect(writeCalls, "forged settings callback must not change connections").toEqual([]);
  });
});
