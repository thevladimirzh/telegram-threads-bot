/**
 * Security tests — dialog abuse and content injection.
 *
 * Test-ID map ↔ docs/risk-register.md security section (R48+):
 *   SEC-4 → R50 (forged callback query): a callback from another user must not
 *           affect the forward author's draft; the victim's transfer still
 *           targets the chat the victim picked
 *   SEC-5 → R50 (callback injection / stale drafts): malformed, stale and
 *           hostile callback payloads never crash and never change state
 *   SEC-6 → R52/R59 (malicious title/text: markup injection, link spoofing,
 *           stored XSS-like payloads): attacker content is delivered as data,
 *           never interpreted as Telegram markup
 *
 * Contract under test (docs/plan.md §7): `src/bot/createBot.ts` —
 *   createBot(deps: { store; now; logger; config }): Bot
 * plus `src/config.ts` (loadConfig) and `src/store/in-memory.ts` (InMemoryStore).
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
const ATTACKER = { id: 900004, is_bot: false, first_name: "Attacker", username: "attacker" };

const SOURCE_A = { id: -1001110000001, type: "supergroup", title: "Source A" };
const SOURCE_B = { id: -1001110000002, type: "supergroup", title: "Source B" };
const THREADS = { id: -1001110000003, type: "supergroup", title: "Threads" };
const DM = { id: GLOBAL_ADMIN.id, type: "private" };

const BOT_USER = { id: BOT_USER_ID, is_bot: true, first_name: "Test Bot", username: "test_bot" };

const ENV: Record<string, string> = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads",
  ADMIN_IDS: String(GLOBAL_ADMIN.id),
  MODE: "polling",
};

/** Markup/link-spoofing payload: HTML anchor, Markdown link, mention, URL, RTL override. */
const EVIL_TITLE =
  '<a href="http://evil.example/">t.me/legit</a> [](http://evil.example/) *bold* @all https://t.me/c/1/2 \u202Eexe.txt';
const EVIL_TEXT = '<img src=x onerror=alert(1)> [spoof](http://evil.example/) \u202Egnp.exe';
const htmlEscaped = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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

function original(chat: { id: number; type: string; title?: string }, messageId: number, text: string, date: number): Update {
  return messageUpdate({ chat: chat as any, from: SOURCE_ADMIN, messageId, text, date });
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

function textMessage(chat: { id: number; type: string }, from: { id: number }, messageId: number, text: string): Update {
  return messageUpdate({ chat: chat as any, from: from as any, messageId, text });
}

function commandUpdate(chat: { id: number; type: string }, from: { id: number }, text: string, messageId: number): Update {
  return messageUpdate({ chat: chat as any, from: from as any, messageId, text });
}

function callbackUpdate(opts: {
  from: { id: number; is_bot?: boolean; first_name?: string };
  chat?: { id: number; type: string };
  messageId?: number;
  data?: string;
  omitData?: boolean;
}): Update {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cb-${nextUpdateId}`,
      from: opts.from,
      ...(opts.chat !== undefined
        ? {
            message: {
              message_id: opts.messageId ?? 424242,
              date: FIXED_DATE,
              chat: opts.chat,
              from: BOT_USER,
            },
          }
        : {}),
      chat_instance: "ci-1",
      ...(opts.omitData ? {} : { data: opts.data ?? "" }),
    },
  };
}

// ------------------------------- fake logger -------------------------------

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

// ------------------------------ recording store -----------------------------

const WRITE_VERB =
  /^(add|create|insert|save|upsert|put|append|set|write|record|store|index|track|link|map|attach|push|delete|remove|update|mark|touch|clear|reset|merge|bind|bump|note)/i;

function recordingStore(raw: unknown): { store: any; writeCalls: string[] } {
  const writeCalls: string[] = [];
  const wrap = (target: any, path: string): any => {
    if (target === null || typeof target !== "object") return target;
    if (target instanceof Promise) return target;
    return new Proxy(target, {
      get(t: any, prop): unknown {
        if (typeof prop !== "string") return t[prop];
        const value = t[prop];
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

// -------------------------- fake Bot API introspection ----------------------

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

/** Press the (newest) dialog button that picks the source chat for the transfer. */
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

// ================================== SEC-4 ===================================

describe("SEC-4 (R50): a forged callback from another user cannot touch the draft", () => {
  test("attacker pressing the dialog buttons does not derail the author's transfer", async () => {
    const { bot, api } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, SOURCE_B);
    await connectChat(bot, api, THREADS);

    const d0 = FIXED_DATE + 40;
    await feed(bot, [original(SOURCE_A, 11, "alpha", d0), original(SOURCE_A, 12, "beta", d0 + 1)]);
    await feed(bot, [original(SOURCE_B, 21, "alpha-B", d0), original(SOURCE_B, 22, "beta-B", d0 + 1)]);
    await feed(bot, [forwarded(701, "alpha", d0), forwarded(702, "beta", d0 + 1)]);

    // the attacker forges a press of the button that would pick the WRONG chat (B)
    const wrongButton = flatButtons(api, THREADS.id).find((b) => refersToChat(b.data, SOURCE_B.id));
    if (!wrongButton) {
      throw new Error(
        "SEC-4: the transfer dialog must offer a source-chat button per connected chat (AC2); " +
          `observed callback_data: ${flatButtons(api, THREADS.id).map((b) => b.data).join(" | ") || "<none>"}`,
      );
    }
    const mark = api.calls.length;
    await pressButton(bot, api, wrongButton, ATTACKER, THREADS);
    const duringForgery = api.calls.slice(mark).filter((c) => c.method !== "answerCallbackQuery");
    expect(
      duringForgery.filter((c) => /^(delete|copy|forward)/.test(c.method)),
      "a forged callback alone must have no side effects",
    ).toEqual([]);

    // the real author finishes the dialog — the draft must be exactly as left
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 703, "Victim thread")]);

    const deletes = api.calls.filter((c) => /^delete/.test(c.method));
    expect(api.calls.filter((c) => /^copy/.test(c.method)).length, "the victim's thread must be created").toBeGreaterThan(0);
    expect(
      deletes.some((c) => c.payload.chat_id === SOURCE_A.id),
      "originals are deleted in the chat the author's batch came from",
    ).toBe(true);
    for (const call of deletes) {
      expect(call.payload.chat_id, "the forged pick of chat B must never be honoured").not.toBe(SOURCE_B.id);
    }
  });
});

// ================================== SEC-5 ===================================

describe("SEC-5 (R50): hostile callback payloads never crash and never change state", () => {
  test("injection, oversized, stale and malformed callback data are inert", async () => {
    const { bot, api, writeCalls } = await bootBot();
    installMembershipFake(api);

    const hostile: Update[] = [
      callbackUpdate({ from: ATTACKER, chat: THREADS, data: "settings:connect_source:-100999; DROP TABLE users--" }),
      callbackUpdate({ from: ATTACKER, chat: THREADS, data: "x".repeat(10_000) }),
      callbackUpdate({ from: ATTACKER, chat: THREADS, data: "" }),
      callbackUpdate({ from: ATTACKER, chat: THREADS, omitData: true }),
      callbackUpdate({ from: ATTACKER, omitData: true }), // no message at all (stale/foreign)
      callbackUpdate({ from: ATTACKER, chat: THREADS, data: "../../../etc/passwd" }),
      callbackUpdate({ from: ATTACKER, chat: THREADS, data: "\u202Eevil\u0000\u001b[31m" }),
    ];

    for (const update of hostile) {
      writeCalls.length = 0;
      const mark = api.calls.length;
      await feed(bot, [update]); // must not throw
      const sideEffects = api.calls.slice(mark).filter((c) => c.method !== "answerCallbackQuery");
      expect(sideEffects.filter((c) => /^(delete|copy|forward)/.test(c.method))).toEqual([]);
      expect(writeCalls, "a hostile callback must not mutate stored state").toEqual([]);
    }

    // the bot stays functional afterwards
    await feed(bot, [commandUpdate(DM, ATTACKER, "/settings", nextUpdateId)]);
  });
});

// ================================== SEC-6 ===================================

describe("SEC-6 (R52/R59): attacker content is data, never Telegram markup", () => {
  test("a markup-laden title and message text cannot alter the message layout", async () => {
    const { bot, api } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, THREADS);

    const d0 = FIXED_DATE + 50;
    await feed(bot, [original(SOURCE_A, 31, EVIL_TEXT, d0)]);
    await feed(bot, [forwarded(801, EVIL_TEXT, d0)]);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 802, EVIL_TITLE)]);
    expect(api.calls.filter((c) => /^copy/.test(c.method)).length, "the flow must complete (non-vacuous)").toBeGreaterThan(0);

    // (1) no call may hand raw attacker markup to a markup parser
    for (const call of api.calls) {
      if (!["sendMessage", "editMessageText", "copyMessage", "copyMessages", "forwardMessage"].includes(call.method)) continue;
      const text = String(call.payload.text ?? call.payload.caption ?? "");
      const carriesRawEvil = text.includes("<a href") || text.includes("<img") || text.includes("*bold*");
      if (carriesRawEvil) {
        expect(call.payload.parse_mode, `${call.method} parses attacker text as markup`).toBeUndefined();
        expect(call.payload.entities ?? call.payload.caption_entities, `${call.method} adds entities to attacker text`).toBeUndefined();
      }
    }

    // (2) the title is delivered verbatim as plain text (or safely escaped) — not stripped, not re-linked
    const texts = api.callsOf("sendMessage").map((c) => String(c.payload.text ?? ""));
    const delivered = texts.some((t) => t.includes(EVIL_TITLE) || t.includes(htmlEscaped(EVIL_TITLE)));
    expect(delivered, "the title must reach the chat as data (verbatim or escaped), not be re-rendered").toBe(true);

    // (3) the announce link is exactly one URL built by the bot — no attacker URL becomes a link target
    for (const call of api.calls) {
      const text = String(call.payload.text ?? call.payload.caption ?? "");
      if (text.includes("evil.example") && (call.payload.parse_mode !== undefined || call.payload.entities !== undefined)) {
        throw new Error(`${call.method} renders an attacker-controlled URL as a link`);
      }
    }
  });
});
