/**
 * Unit tests — createBot chat discovery / eligibility behaviours (T7).
 *
 * - S7 semantics (docs/plan.md D79 + acceptance settings.test.ts S7): the bot's
 *   membership is learned from `my_chat_member` updates, so rendering /settings
 *   must not issue `getChatMember` calls for chats whose status is already
 *   known ("the created thread must stay untouched" — zero calls on that chat).
 * - S6 semantics (acceptance settings.test.ts S6): a forwarded batch from a
 *   chat where the bot is an admin opens the dialog even before the chat is
 *   connected via /settings; a batch from a chat where the bot is not an admin
 *   (S19) or from the threads chat itself (S5) is refused without a dialog.
 */
import { describe, expect, test } from "vitest";
import { FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, type RecordedCall } from "../helpers/fake-bot-api";
import { loadConfig } from "../../src/config";
import { InMemoryStore } from "../../src/store/in-memory";
import { createBot, type Logger } from "../../src/bot/createBot";

const BOT_USER_ID = 1;
const GLOBAL_ADMIN = { id: 900001, is_bot: false, first_name: "Admin", language_code: "en" };
const AUTHOR = { id: 900002, is_bot: false, first_name: "Author", language_code: "en" };

const SOURCE = { id: -1001110000001, type: "supergroup", title: "Source Chat" };
const THREADS = { id: -1001110000003, type: "supergroup", title: "Threads Chat" };
const NOBODY_CHAT = { id: -1001110000005, type: "supergroup", title: "No Rights Chat" };
const DM = { id: GLOBAL_ADMIN.id, type: "private" };

const ENV = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads",
  ADMIN_IDS: String(GLOBAL_ADMIN.id),
  MODE: "polling",
};

function silentLogger(): Logger {
  const noop = (): void => {};
  return { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

interface Boot {
  bot: any;
  api: FakeBotApi;
  store: InMemoryStore;
}

async function boot(): Promise<Boot> {
  const config = loadConfig(ENV);
  const store = new InMemoryStore();
  const bot = createBot({ store, now: () => new Date(FIXED_DATE * 1000), logger: silentLogger(), config });
  const api = new FakeBotApi();
  // Coarse membership fake (same convention as the acceptance harness): the bot
  // is an admin everywhere — the assertions below are about WHICH mechanism
  // decides membership (my_chat_member, not probing), not about the answers.
  api.setMethodResult("getChatMember", {
    status: "administrator",
    user: { id: BOT_USER_ID, is_bot: true, first_name: "Bot" },
    can_delete_messages: true,
  });
  bot.api.config.use(api.transformer);
  await bot.init();
  return { bot, api, store };
}

let updateId = 1;

async function myChatMember(bot: any, chat: { id: number; type: string; title?: string }, status: "administrator" | "member"): Promise<void> {
  await bot.handleUpdate({
    update_id: updateId++,
    my_chat_member: {
      chat,
      from: { ...GLOBAL_ADMIN },
      date: FIXED_DATE,
      old_chat_member: { status: "left", user: { id: BOT_USER_ID, is_bot: true, first_name: "Bot" } },
      new_chat_member: {
        status,
        user: { id: BOT_USER_ID, is_bot: true, first_name: "Bot" },
        ...(status === "administrator" ? { can_delete_messages: true } : {}),
      },
    },
  });
}

async function message(
  bot: any,
  chat: { id: number; type: string; title?: string },
  from: { id: number; is_bot?: boolean; first_name?: string; language_code?: string },
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: messageId, date: FIXED_DATE, chat, from, text, ...extra },
  });
}

function buttonsOf(api: FakeBotApi, chatId: number): string[] {
  const out: string[] = [];
  for (const call of [...api.callsOf("sendMessage"), ...api.callsOf("editMessageText")]) {
    if (call.payload.chat_id !== chatId) continue;
    const kb = call.payload.reply_markup as any;
    for (const row of kb?.inline_keyboard ?? []) {
      for (const btn of row ?? []) {
        if (btn && typeof btn.callback_data === "string") out.push(btn.callback_data);
      }
    }
  }
  return out;
}

describe("D79/S7: /settings uses observed my_chat_member status and never probes known chats", () => {
  test("admin chats are listed, non-admin chats are not, and no getChatMember is issued", async () => {
    const { bot, api } = await boot();
    await myChatMember(bot, SOURCE, "administrator");
    await myChatMember(bot, NOBODY_CHAT, "member");
    await message(bot, SOURCE, AUTHOR, 10, "hello");
    await message(bot, NOBODY_CHAT, AUTHOR, 11, "hello");
    api.calls.length = 0;

    await message(bot, DM, GLOBAL_ADMIN, 12, "/settings");

    const buttons = buttonsOf(api, DM.id);
    expect(buttons.some((d) => d.includes(String(SOURCE.id)))).toBe(true);
    expect(buttons.some((d) => d.includes(String(NOBODY_CHAT.id)))).toBe(false);
    expect(api.callsOf("getChatMember"), "membership is known from my_chat_member — no probing").toEqual([]);
    expect(api.callsOf("getChatAdministrators")).toEqual([]);
  });

  test("a chat observed without my_chat_member falls back to one cached getChatMember probe", async () => {
    const { bot, api } = await boot();
    await message(bot, SOURCE, AUTHOR, 10, "hello"); // message-only discovery
    api.setMethodResult("getChatMember", {
      status: "administrator",
      user: { id: BOT_USER_ID, is_bot: true, first_name: "Bot" },
      can_delete_messages: true,
    });
    api.calls.length = 0;

    await message(bot, DM, GLOBAL_ADMIN, 12, "/settings");
    await message(bot, DM, GLOBAL_ADMIN, 13, "/settings");

    expect(buttonsOf(api, DM.id).some((d) => d.includes(String(SOURCE.id)))).toBe(true);
    expect(api.callsOf("getChatMember").length, "the probe result is cached across renders").toBe(1);
  });
});

describe("D46/S6/S19/S5: forward eligibility of the origin chat", () => {
  async function connectThreadsChat(bot: any, api: FakeBotApi): Promise<void> {
    await myChatMember(bot, THREADS, "administrator");
    await message(bot, THREADS, AUTHOR, 20, "hello");
    await message(bot, DM, GLOBAL_ADMIN, 21, "/settings");
    // press the "threads" button for the threads chat
    const data = buttonsOf(api, DM.id).find((d) => d.startsWith("set:threads:") && d.includes(String(THREADS.id)));
    expect(data, "the threads button must be rendered").toBeDefined();
    await bot.handleUpdate({
      update_id: updateId++,
      callback_query: {
        id: "cb-1",
        from: { ...GLOBAL_ADMIN },
        message: { message_id: 1, date: FIXED_DATE, chat: { ...DM } },
        chat_instance: "ci",
        data,
      },
    });
  }

  test("a forward from a bot-admin chat opens the dialog even before it is connected (S6)", async () => {
    const { bot, api } = await boot();
    await connectThreadsChat(bot, api);
    await myChatMember(bot, SOURCE, "administrator");
    await message(bot, SOURCE, AUTHOR, 30, "hello");
    api.calls.length = 0;

    await message(bot, THREADS, AUTHOR, 31, "text-30", {
      forward_origin: { type: "user", sender_user: { ...AUTHOR }, date: FIXED_DATE, chat: { ...SOURCE }, sender_chat: { ...SOURCE } },
    });

    const dialogs = [...api.callsOf("sendMessage"), ...api.callsOf("editMessageText")].filter((c) => {
      const kb = c.payload.reply_markup as any;
      return c.payload.chat_id === THREADS.id && Array.isArray(kb?.inline_keyboard) && kb.inline_keyboard.length > 0;
    });
    expect(dialogs.length, "the dialog opens in the threads chat").toBe(1);
    expect(buttonsOf(api, THREADS.id).some((d) => d.includes(String(SOURCE.id))), "the origin chat is offered for picking").toBe(true);
  });

  test("a forward from a chat where the bot is not an admin is refused without a dialog (S19)", async () => {
    const { bot, api } = await boot();
    await connectThreadsChat(bot, api);
    await myChatMember(bot, NOBODY_CHAT, "member");
    await message(bot, NOBODY_CHAT, AUTHOR, 40, "hello");
    api.calls.length = 0;

    await message(bot, THREADS, AUTHOR, 41, "text-40", {
      forward_origin: { type: "user", sender_user: { ...AUTHOR }, date: FIXED_DATE, chat: { ...NOBODY_CHAT }, sender_chat: { ...NOBODY_CHAT } },
    });

    expect(buttonsOf(api, THREADS.id), "no dialog keyboard is rendered").toEqual([]);
    const texts = api.callsOf("sendMessage").map((c) => String(c.payload.text ?? ""));
    expect(texts.join("\n"), "the refusal names the chat").toContain("No Rights Chat");
  });

  test("a forward from a chat with no admin signal at all is refused (S19 world: membership fake alone is not a signal)", async () => {
    const { bot, api } = await boot();
    await connectThreadsChat(bot, api);
    await message(bot, NOBODY_CHAT, AUTHOR, 45, "hello"); // message-only discovery, no my_chat_member
    api.calls.length = 0;

    await message(bot, THREADS, AUTHOR, 46, "text-45", {
      forward_origin: { type: "user", sender_user: { ...AUTHOR }, date: FIXED_DATE, chat: { ...NOBODY_CHAT }, sender_chat: { ...NOBODY_CHAT } },
    });

    expect(buttonsOf(api, THREADS.id), "no dialog keyboard is rendered").toEqual([]);
    const texts = api.callsOf("sendMessage").map((c) => String(c.payload.text ?? ""));
    expect(texts.join("\n"), "the refusal names the chat").toContain("No Rights Chat");
  });

  test("a forward naming the threads chat itself is refused without a dialog (S5)", async () => {
    const { bot, api } = await boot();
    await connectThreadsChat(bot, api);
    api.calls.length = 0;

    await message(bot, THREADS, AUTHOR, 50, "text-50", {
      forward_origin: { type: "user", sender_user: { ...AUTHOR }, date: FIXED_DATE, chat: { ...THREADS }, sender_chat: { ...THREADS } },
    });

    expect(buttonsOf(api, THREADS.id), "no dialog keyboard is rendered").toEqual([]);
  });
});
