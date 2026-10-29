/**
 * Security tests — deletion safety: what the bot is allowed to delete, how
 * much, and when (destruction is the highest-impact capability here).
 *
 * Test-ID map ↔ docs/risk-register.md security section (R48+):
 *   SEC-7  → R51 (forged/replayed updates): replaying a finished transfer is
 *            refused by duplicate protection — zero deletions, no 2nd announce
 *   SEC-10 → R53 (oversized batch DoS): a 500-message batch is capped at 50,
 *            deleteMessages never carries more than 100 ids
 *   SEC-13 → R60 (chat impersonation): a chat the bot is in but that is NOT
 *            connected is ignored — no index write, no API side effects
 *   SEC-14 → R54 (matcher abuse): identical messages in another source chat are
 *            never deleted when transferring from the chosen chat
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
const ATTACKER_CHAT = { id: -1001110000009, type: "supergroup", title: "Attacker chat" }; // never connected
const DM = { id: GLOBAL_ADMIN.id, type: "private" };

const BOT_USER = { id: BOT_USER_ID, is_bot: true, first_name: "Test Bot", username: "test_bot" };

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

function original(
  chat: { id: number; type: string; title?: string },
  from: { id: number; is_bot?: boolean; first_name?: string },
  messageId: number,
  text: string,
  date: number,
): Update {
  return messageUpdate({ chat: chat as any, from, messageId, text, date });
}

function forwarded(
  from: { id: number; is_bot?: boolean; first_name?: string },
  originSender: { id: number; is_bot?: boolean; first_name?: string },
  messageId: number,
  text: string,
  date: number,
): Update {
  return messageUpdate({
    chat: THREADS,
    from,
    messageId,
    text,
    forwardOrigin: { type: "user", sender_user: originSender, date },
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

function deletedIds(api: FakeBotApi, chatId: number): number[] {
  const ids: number[] = [];
  for (const call of api.calls) {
    if (call.method === "deleteMessage" && call.payload.chat_id === chatId) ids.push(call.payload.message_id as number);
    if (call.method === "deleteMessages" && call.payload.chat_id === chatId) {
      ids.push(...(call.payload.message_ids as number[]));
    }
  }
  return ids;
}

// ================================== SEC-7 ===================================

describe("SEC-7 (R51): replayed transfer is refused — no deletions, no second announce", () => {
  test("replaying the finished batch and title again has zero destructive side effects", async () => {
    const { bot, api } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, THREADS);

    const d0 = FIXED_DATE + 60;
    const originals = [original(SOURCE_A, SOURCE_ADMIN, 11, "alpha", d0), original(SOURCE_A, SOURCE_ADMIN, 12, "beta", d0 + 1)];
    const batch = [forwarded(SOURCE_ADMIN, SOURCE_ADMIN, 901, "alpha", d0), forwarded(SOURCE_ADMIN, SOURCE_ADMIN, 902, "beta", d0 + 1)];

    await feed(bot, originals);
    await feed(bot, batch);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 903, "First thread")]);
    expect(api.calls.filter((c) => /^delete/.test(c.method)).length, "control run must delete").toBeGreaterThan(0);

    // --- replay: exactly the same updates (same update_ids and message ids)
    const mark = api.calls.length;
    await feed(bot, batch);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 903, "First thread")]);

    const after = api.calls.slice(mark);
    expect(after.filter((c) => /^delete/.test(c.method)), "replay: duplicate protection forbids re-deletion").toEqual([]);
    expect(after.filter((c) => /^copy/.test(c.method)), "replay: no second thread copies").toEqual([]);
    expect(after.filter((c) => /^forward/.test(c.method)), "replay: nothing re-forwarded").toEqual([]);
    expect(
      after.filter((c) => c.method === "sendMessage" && c.payload.chat_id === SOURCE_A.id),
      "replay: no second announce in the source chat",
    ).toEqual([]);
  });
});

// ================================== SEC-10 ==================================

describe("SEC-10 (R53): oversized batch is capped, deletions stay within API limits", () => {
  test("a 500-message batch transfers at most 50 and chunks deletions by <= 100 ids", async () => {
    const { bot, api } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, THREADS);

    const total = 500;
    const d0 = FIXED_DATE + 70;
    const originals: Update[] = [];
    const batch: Update[] = [];
    for (let i = 0; i < total; i++) {
      originals.push(original(SOURCE_A, SOURCE_ADMIN, 1000 + i, `m${i}`, d0 + i));
      batch.push(forwarded(SOURCE_ADMIN, SOURCE_ADMIN, 2000 + i, `m${i}`, d0 + i));
    }
    await feed(bot, originals);
    await feed(bot, batch);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 9000, "Big batch")]);

    // (1) Telegram Bot API hard limit: at most 100 ids per deleteMessages call
    for (const call of api.callsOf("deleteMessages")) {
      const ids = call.payload.message_ids as unknown[];
      expect(ids.length, "deleteMessages exceeds the 100-id API limit").toBeLessThanOrEqual(100);
    }
    // (2) the transferred set is capped at the batch limit (50): bounded work, bounded deletions
    const copied = api.calls
      .filter((c) => c.method === "copyMessage" || c.method === "copyMessages")
      .reduce((n, c) => n + (c.method === "copyMessages" ? (c.payload.message_ids as unknown[]).length : 1), 0);
    expect(copied, "oversized batch must be capped at the batch limit").toBeLessThanOrEqual(50);
    const sourceDeleted = new Set(deletedIds(api, SOURCE_A.id));
    expect(sourceDeleted.size, "originals of the dropped tail must never be deleted").toBeLessThanOrEqual(50);
  });
});

// ================================== SEC-13 ==================================

describe("SEC-13 (R60): a chat the bot is in but that is not connected is ignored", () => {
  test("no index write and no API side effects for an unconnected chat", async () => {
    const { bot, api, writeCalls } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, THREADS);

    // --- ordinary traffic in the (never connected) attacker chat: fully inert
    const mark = api.calls.length;
    writeCalls.length = 0;
    await feed(bot, [
      original(ATTACKER_CHAT, ATTACKER, 11, "poison", FIXED_DATE + 80),
      original(ATTACKER_CHAT, ATTACKER, 12, "poison two", FIXED_DATE + 81),
    ]);
    const inert = api.calls.slice(mark).filter((c) => /^(send|edit|delete|copy|forward)/.test(c.method));
    expect(inert, "unconnected chat traffic must produce no API side effects").toEqual([]);
    expect(writeCalls, "unconnected chat traffic must not be indexed or stored").toEqual([]);

    // --- a transfer attempt claiming that chat must be refused, never executed
    await feed(bot, [
      forwarded(ATTACKER, ATTACKER, 21, "poison", FIXED_DATE + 80),
      forwarded(ATTACKER, ATTACKER, 22, "poison two", FIXED_DATE + 81),
      textMessage(THREADS, ATTACKER, 23, "Impersonated thread"),
    ]);
    const after = api.calls.slice(mark);
    expect(after.filter((c) => /^delete/.test(c.method)), "no deletions for an unconnected source").toEqual([]);
    expect(after.filter((c) => /^copy/.test(c.method)), "no thread may be created from an unconnected source").toEqual([]);
  });
});

// ================================== SEC-14 ==================================

describe("SEC-14 (R54): matcher abuse cannot delete innocent messages in another chat", () => {
  test("identical messages in a second source chat survive a transfer from the first", async () => {
    const { bot, api } = await bootBot();
    installMembershipFake(api);
    await connectChat(bot, api, SOURCE_A);
    await connectChat(bot, api, SOURCE_B);
    await connectChat(bot, api, THREADS);

    // identical date + sender + content in BOTH source chats (same-second collision)
    const d0 = FIXED_DATE + 90;
    await feed(bot, [original(SOURCE_A, SOURCE_ADMIN, 11, "same words", d0)]);
    await feed(bot, [original(SOURCE_B, SOURCE_ADMIN, 21, "same words", d0)]);
    await feed(bot, [forwarded(SOURCE_ADMIN, SOURCE_ADMIN, 31, "same words", d0)]);
    await pickSourceChat(bot, api, SOURCE_A, SOURCE_ADMIN);
    await feed(bot, [textMessage(THREADS, SOURCE_ADMIN, 32, "Cross chat")]);

    expect(deletedIds(api, SOURCE_A.id), "the chosen chat's original is deleted").toContain(11);
    for (const call of api.calls.filter((c) => /^delete/.test(c.method))) {
      expect(call.payload.chat_id, "matcher must be scoped to the chosen source chat").not.toBe(SOURCE_B.id);
    }
    expect(deletedIds(api, SOURCE_B.id), "the twin original in chat B must survive").toEqual([]);
  });
});
