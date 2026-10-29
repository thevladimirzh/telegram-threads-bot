/**
 * Security tests — secret leakage.
 *
 * Test-ID map ↔ docs/risk-register.md security section (R48+):
 *   SEC-8 → R55 (secret leakage into logs): neither happy nor failure paths may
 *           ever log BOT_TOKEN / DATABASE_URL material, and it must never reach
 *           chat output either (e.g. via grammY error objects carrying the
 *           request URL with the bot token)
 *
 * Contract under test (docs/plan.md §7): `src/bot/createBot.ts` —
 *   createBot(deps: { store; now; logger; config }): Bot
 * with `logger: Logger` injected; `src/config.ts` + `src/store/in-memory.ts`.
 *
 * RED note: those modules do not exist until T7. They are imported dynamically
 * so every test fails individually with "module missing" (the expected RED
 * state); `@ts-ignore` keeps `npm run typecheck` clean until then.
 */
import { describe, expect, test } from "vitest";
import { FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, type RecordedCall } from "../helpers/fake-bot-api";

// ------------------------------- actors ------------------------------------

const BOT_USER_ID = 1; // the fake getMe reports the bot as user id 1
const GLOBAL_ADMIN = { id: 900001, is_bot: false, first_name: "Global Admin", username: "gadmin" };
const SOURCE_ADMIN = { id: 900002, is_bot: false, first_name: "Source Admin", username: "sadmin" };

const SOURCE_A = { id: -1001110000001, type: "supergroup", title: "Source A" };
const THREADS = { id: -1001110000003, type: "supergroup", title: "Threads" };
const DM = { id: GLOBAL_ADMIN.id, type: "private" };

const BOT_USER = { id: BOT_USER_ID, is_bot: true, first_name: "Test Bot", username: "test_bot" };

const SECRET_MARKERS = [TEST_BOT_TOKEN, "TEST-TOKEN", "123456:TEST", "sup3r-secret-pw", "threads_app@db.internal"];

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

function original(messageId: number, text: string, date: number): Update {
  return messageUpdate({ chat: SOURCE_A, from: SOURCE_ADMIN, messageId, text, date });
}

function forwarded(messageId: number, text: string, date: number): Update {
  return messageUpdate({
    chat: THREADS,
    from: SOURCE_ADMIN,
    messageId,
    text,
    forwardOrigin: { type: "user", sender_user: SOURCE_ADMIN, date },
  });
}

function textMessage(messageId: number, text: string): Update {
  return messageUpdate({ chat: THREADS, from: SOURCE_ADMIN, messageId, text });
}

function commandUpdate(chat: { id: number; type: string }, from: { id: number }, text: string, messageId: number): Update {
  return messageUpdate({ chat: chat as any, from: from as any, messageId, text });
}

function callbackUpdate(opts: {
  from: { id: number; is_bot?: boolean; first_name?: string };
  chat: { id: number; type: string };
  messageId: number;
  data: string;
}): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb-${nextUpdateId}`,
      from: opts.from,
      message: { message_id: opts.messageId, date: FIXED_DATE, chat: opts.chat, from: BOT_USER },
      chat_instance: "ci-1",
      data: opts.data,
    },
  };
}

// --------------------------- fake logger (the SUT gets this) ----------------

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

/**
 * Renders captured log arguments (and API payloads) as text, keeping Error
 * message/stack fields and breaking circular references.
 */
function deepText(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

// ------------------------------- boot (T7) ---------------------------------

async function bootBot(): Promise<{
  bot: any;
  api: FakeBotApi;
  logRecords: Array<{ level: string; args: unknown[] }>;
}> {
  // @ts-ignore src/config.ts does not exist until T7 (plan §7.1) — expected RED state.
  const { loadConfig } = await import("../../src/config");
  // @ts-ignore src/store/in-memory.ts does not exist until T7 (plan §7.2) — expected RED state.
  const { InMemoryStore } = await import("../../src/store/in-memory");
  // @ts-ignore src/bot/createBot.ts does not exist until T7 (plan §7.3) — expected RED state.
  const { createBot } = await import("../../src/bot/createBot");

  const config = loadConfig(ENV);
  const logRecords: Array<{ level: string; args: unknown[] }> = [];
  const bot = createBot({
    store: new InMemoryStore(),
    now: () => new Date(FIXED_DATE * 1000),
    logger: makeLogger(logRecords),
    config,
  } as any);
  const api = new FakeBotApi();
  bot.api.config.use(api.transformer);
  await bot.init();
  return { bot, api, logRecords };
}

function installMembershipFake(api: FakeBotApi): void {
  api.setMethodResult("getChatMember", (p: any) => ({
    status: p.user_id === BOT_USER_ID || p.user_id === SOURCE_ADMIN.id ? "administrator" : "member",
    user: { id: p.user_id ?? 0, is_bot: p.user_id === BOT_USER_ID, first_name: "U" },
    can_delete_messages: true,
  }));
  api.setMethodResult("getChatAdministrators", () => [
    { status: "administrator", user: BOT_USER, can_delete_messages: true, is_anonymous: false },
    { status: "administrator", user: SOURCE_ADMIN, can_delete_messages: true, is_anonymous: false },
  ]);
}

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

async function pressButton(bot: any, api: FakeBotApi, button: Button, from: { id: number }): Promise<void> {
  await bot.handleUpdate(
    callbackUpdate({ from: from as any, chat: DM, messageId: messageIdFor(api, button.call), data: button.data }),
  );
}

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
      await pressButton(bot, api, button, GLOBAL_ADMIN);
    }
  }
  if (pressed.size === 0) {
    throw new Error(
      `connectChat: /settings rendered no button referencing chat ${chat.id}; ` +
        `observed callback_data: ${flatButtons(api, DM.id).map((b) => b.data).join(" | ") || "<none>"}`,
    );
  }
}

async function pickSourceChat(bot: any, api: FakeBotApi, chat: { id: number }, author: { id: number }): Promise<void> {
  const matches = flatButtons(api, THREADS.id).filter((b) => refersToChat(b.data, chat.id));
  const button = matches[matches.length - 1];
  if (!button) {
    throw new Error(
      `pickSourceChat: no dialog button referencing chat ${chat.id}; ` +
        `observed callback_data: ${flatButtons(api, THREADS.id).map((b) => b.data).join(" | ") || "<none>"}`,
    );
  }
  await bot.handleUpdate(
    callbackUpdate({
      from: author as any,
      chat: THREADS,
      messageId: messageIdFor(api, button.call),
      data: button.data,
    }),
  );
}

async function feed(bot: any, updates: Update[]): Promise<void> {
  for (const update of updates) {
    await bot.handleUpdate(update); // must never throw (no crash on user input)
  }
}

// ================================== SEC-8 ===================================

describe("SEC-8 (R55): secrets never reach logs or chat output", () => {
  test("happy path and API-failure path keep BOT_TOKEN and DATABASE_URL out of every log record", async () => {
    const { bot, api, logRecords } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, THREADS);

    // happy path: a complete transfer logs plenty of operational context
    const d0 = FIXED_DATE + 100;
    await feed(bot, [original(41, "alpha", d0), original(42, "beta", d0 + 1)]);
    await feed(bot, [forwarded(1001, "alpha", d0), forwarded(1002, "beta", d0 + 1)]);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(1003, "Happy thread")]);

    // failure path: Telegram API errors (grammY error objects can embed the
    // request URL — which contains the bot token) must be sanitized before logging
    api.setMethodError("deleteMessages", { error_code: 500, description: "boom" });
    api.setMethodError("deleteMessage", { error_code: 500, description: "boom" });
    await feed(bot, [original(43, "gamma", d0 + 2)]);
    await feed(bot, [forwarded(1004, "gamma", d0 + 2)]);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(1005, "Failing thread")]);

    expect(logRecords.length, "the bot must log something (AC9) — otherwise this test is vacuous").toBeGreaterThan(0);

    const logs = deepText(logRecords);
    const sent = deepText(api.calls);
    for (const marker of SECRET_MARKERS) {
      expect(logs.includes(marker), `log records leak '${marker}'`).toBe(false);
      expect(sent.includes(marker), `API payloads leak '${marker}'`).toBe(false);
    }
  });
});
