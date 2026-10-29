/**
 * Unit tests — closing-message link per D89 (UNIT-24, UNIT-25; R63, TDD).
 *
 * The user-reported bug: the closing message's "moved from" value was a bare
 * `t.me/c/{chat_id}` (or `t.me/{username}`) — not a valid Telegram link, since
 * a `t.me/c/` link REQUIRES a message id (`t.me/c/4327410333` does not open).
 *
 * D89 (amends D7/D62): the closing message `{title} — moved from {…}` links to
 * the ANNOUNCE message in the source chat:
 * `https://t.me/c/{internal_chat_id}/{announce_message_id}` — uniform for
 * public and private chats (`internal_chat_id` = the Telegram chat id with the
 * `-100`/`-` prefix stripped per D62). The announce is sent BEFORE the closing
 * message so its id is known (thread display order unchanged: root, copies…,
 * closing last). When the announce cannot be sent (Telegram error), the SAME
 * template is filled with the plain chat title (no link) and the transfer is
 * not rolled back (S84).
 *
 * UNIT-24: the builder renders exactly `https://t.me/c/{digits}/{digits}` from
 * the chat id + announce id (strips the `-100` supergroup and `-` basic-group
 * prefixes); the announce is sent before the closing message and the closing
 * embeds that announce id; the fallback is the plain chat title and never a
 * URL. UNIT-25 (property, fast-check, fixed seed, 200 runs): for ANY chat id
 * and announce id the built link matches `^https://t\.me/c/\d+/\d+$` — never
 * a bare `t.me/c/{id}`.
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { FakeApiError, FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, type RecordedCall } from "../helpers/fake-bot-api";
import { loadConfig } from "../../src/config";
import { InMemoryStore } from "../../src/store/in-memory";
import { createBot, type Logger } from "../../src/bot/createBot";
import { announceMessageLink, chatLinkSegment, movedFromValue } from "../../src/domain/links";

// ------------------------------ link builder ------------------------------

describe("UNIT-24 D89: the closing link points to the announce message", () => {
  test("the link is exactly https://t.me/c/{stripped_chat_id}/{announce_id}", () => {
    // Supergroup `-100…` prefix stripped (decisions §1 fixture ids).
    expect(announceMessageLink(-1002000000000001, 42)).toBe("https://t.me/c/200000000000001/42");
    // Private source chat (no username): same uniform form.
    expect(announceMessageLink(-1002000000000004, 42)).toBe("https://t.me/c/200000000000004/42");
    // Basic group `-` prefix stripped (D62).
    expect(announceMessageLink(-123456789, 7)).toBe("https://t.me/c/123456789/7");
  });

  test("the link embeds the announce id — never a bare t.me/c/{id} or a username link", () => {
    for (const [chatId, announceId] of [
      [-1002000000000001, 42],
      [-1002000000000004, 42],
      [-123456789, 7],
    ] as const) {
      const link = announceMessageLink(chatId, announceId);
      expect(link, "the link shape is https://t.me/c/{digits}/{digits}").toMatch(/^https:\/\/t\.me\/c\/\d+\/\d+$/);
      expect(link, "the announce message id is the last segment").toBe(
        `https://t.me/c/${chatLinkSegment(chatId)}/${announceId}`,
      );
      expect(link, "the link is never the bare chat link").not.toBe(`https://t.me/c/${chatLinkSegment(chatId)}`);
    }
  });

  test("the D89 'moved from' value is the announce link, or the plain chat title when the announce is unknown", () => {
    const chat = { id: -1002000000000001, title: "Source Chat" };
    expect(movedFromValue(chat, 42)).toBe("https://t.me/c/200000000000001/42");
    // S84 fallback: the plain chat title — no link, no URL of any scheme.
    expect(movedFromValue(chat, undefined)).toBe("Source Chat");
    expect(/t\.me\/|https?:\/\//.test(movedFromValue(chat, undefined))).toBe(false);
  });
});

// ------------------------- transfer-level (D89) ---------------------------

const AUTHOR = { id: 900002, is_bot: false, first_name: "Author", language_code: "en" };
const BOT_USER = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" };
const SOURCE = { id: -1002000000000001, type: "supergroup", title: "Source Chat" };
const THREADS = { id: -1002000000000003, type: "supergroup", title: "Threads Chat" };

const ENV = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads",
  ADMIN_IDS: "900001",
  MODE: "polling",
};

function silentLogger(): Logger {
  const noop = (): void => {};
  return { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop };
}

interface SendRec {
  id: number;
  call: RecordedCall;
  payload: Record<string, unknown>;
}

interface Boot {
  bot: any;
  api: FakeBotApi;
  store: InMemoryStore;
  sends: SendRec[];
  /** Make the next sendMessage into `chatId` fail (Telegram error). */
  failNextSendIn(chatId: number, init: { error_code: number; description: string }): void;
}

async function boot(): Promise<Boot> {
  const config = loadConfig(ENV);
  const store = new InMemoryStore();
  store.saveChat({
    chatId: SOURCE.id,
    type: "supergroup",
    title: SOURCE.title,
    isForum: false,
    source: true,
    threads: false,
  });
  store.saveChat({
    chatId: THREADS.id,
    type: "supergroup",
    title: THREADS.title,
    isForum: false,
    source: false,
    threads: true,
  });
  const bot = createBot({ store, now: () => new Date(FIXED_DATE * 1000), logger: silentLogger(), config });
  const api = new FakeBotApi();
  api.setMethodResult("getChatMember", {
    status: "administrator",
    user: { id: AUTHOR.id, is_bot: false, first_name: "Author" },
    can_delete_messages: true,
  });
  const sends: SendRec[] = [];
  const failSend = new Map<number, { error_code: number; description: string }>();
  let nextSendId = 1000;
  api.setMethodResult("sendMessage", (payload: Record<string, unknown>) => {
    const chatId = Number(payload.chat_id ?? 0);
    const failure = failSend.get(chatId);
    if (failure !== undefined) {
      failSend.delete(chatId);
      return new FakeApiError(failure);
    }
    const id = nextSendId++;
    sends.push({ id, call: api.calls[api.calls.length - 1], payload });
    return {
      message_id: id,
      date: FIXED_DATE,
      chat: { id: chatId, type: "supergroup", title: "Fake chat" },
      from: { ...BOT_USER },
      ...(payload.text !== undefined ? { text: payload.text } : {}),
    };
  });
  bot.api.config.use(api.transformer);
  await bot.init();
  return {
    bot,
    api,
    store,
    sends,
    failNextSendIn: (chatId, init) => void failSend.set(chatId, init),
  };
}

let updateId = 1;

/** Given "the message … was observed by the bot" (source chat). */
async function observe(b: Boot, id: number): Promise<void> {
  await b.bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: id,
      date: FIXED_DATE - 120 + id,
      chat: { ...SOURCE },
      from: { ...AUTHOR },
      text: `msg-${id}`,
    },
  });
}

/** The forward of the message `id` into the threads chat (draft batch). */
async function forward(b: Boot, id: number, forwardId: number): Promise<void> {
  await b.bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: forwardId,
      date: FIXED_DATE - 60 + id,
      chat: { ...THREADS },
      from: { ...AUTHOR },
      text: `msg-${id}`,
      forward_origin: {
        type: "user",
        sender_user: { ...AUTHOR },
        date: FIXED_DATE - 120 + id,
        chat: { ...SOURCE },
        sender_chat: { ...SOURCE },
      },
    },
  });
}

/** Pick the source chat with the newest dialog button, then send the title. */
async function completeDialog(b: Boot, title: string): Promise<void> {
  const prompts = b.api.callsOf("sendMessage").filter((c) => {
    const kb = c.payload.reply_markup as any;
    return c.payload.chat_id === THREADS.id && Array.isArray(kb?.inline_keyboard) && kb.inline_keyboard.length > 0;
  });
  const prompt = prompts[prompts.length - 1];
  expect(prompt, "the dialog must offer a button for the source chat").toBeDefined();
  const data = ((prompt!.payload.reply_markup as any).inline_keyboard as any[][])
    .flat()
    .map((btn: any) => String(btn?.callback_data ?? ""))
    .find((d: string) => d.includes(String(SOURCE.id)));
  expect(data, "the dialog must offer a button for the source chat").toBeDefined();
  await b.bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: `cb-${updateId}`,
      from: { ...AUTHOR },
      message: { message_id: 3000, date: FIXED_DATE, chat: { ...THREADS } },
      chat_instance: "ci",
      data,
    },
  });
  await b.bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: 4000, date: FIXED_DATE, chat: { ...THREADS }, from: { ...AUTHOR }, text: title },
  });
}

/** The transfer fixture: observe msg 10, forward it, complete the dialog. */
async function transfer(b: Boot, title = "Lunch"): Promise<void> {
  await observe(b, 10);
  await forward(b, 10, 5000);
  await completeDialog(b, title);
}

/** The announce call: the bot's sendMessage into the source chat. */
function announceCall(b: Boot): SendRec | undefined {
  return b.sends.find((s) => s.payload.chat_id === SOURCE.id);
}

/** The closing call: the "moved from" sendMessage into the threads chat. */
function closingCall(b: Boot): SendRec | undefined {
  return b.sends.find(
    (s) => s.payload.chat_id === THREADS.id && /moved from/.test(String(s.payload.text ?? "")),
  );
}

/** Message id a send/copy call replies to (`reply_to_message_id` / `reply_parameters`). */
function replyToOf(call: RecordedCall): number | undefined {
  const direct = call.payload.reply_to_message_id;
  if (direct !== undefined) return Number(direct);
  const params = call.payload.reply_parameters as { message_id?: unknown } | undefined;
  if (params?.message_id !== undefined) return Number(params.message_id);
  return undefined;
}

describe("UNIT-24 D89: announce before the closing, the closing links to the announce", () => {
  test("the announce is sent BEFORE the closing message and the closing embeds its id", async () => {
    const b = await boot();
    await transfer(b);

    const announce = announceCall(b);
    const closing = closingCall(b);
    expect(announce, "the announce is posted in the source chat").toBeDefined();
    expect(closing, "the closing message is posted in the threads chat").toBeDefined();
    expect(
      b.api.calls.indexOf(announce!.call),
      "the announce is sent BEFORE the closing message (its id feeds the link)",
    ).toBeLessThan(b.api.calls.indexOf(closing!.call));
    expect(
      closing!.payload.text,
      "the closing message is exactly 'Lunch — moved from https://t.me/c/200000000000001/{announce_id}'",
    ).toBe(`Lunch — moved from ${announceMessageLink(SOURCE.id, announce!.id)}`);
    // The closing message is still the last thread message (root, copies…, closing).
    const root = b.sends.find((s) => s.payload.chat_id === THREADS.id && s.payload.text === "Lunch");
    expect(root, "the root (title) message is posted").toBeDefined();
    const threadPosts = b.sends.filter(
      (s) =>
        s.payload.chat_id === THREADS.id &&
        (s.payload.reply_markup as unknown) == null,
    );
    expect(threadPosts[threadPosts.length - 1]!.call, "the closing is the last thread message").toBe(closing!.call);
    expect(replyToOf(closing!.call), "the closing is a reply to the root (D87)").toBe(root!.id);
  });

  test("S84 fallback: a failed announce makes the closing name the plain chat title without a link", async () => {
    const b = await boot();
    await observe(b, 10);
    await forward(b, 10, 5000);
    b.failNextSendIn(SOURCE.id, { error_code: 400, description: "Bad Request: oops" });
    await completeDialog(b, "Lunch");

    const attempted = b.api.callsOf("sendMessage").find((c) => c.payload.chat_id === SOURCE.id);
    expect(attempted, "the announce send was attempted in the source chat (non-vacuous)").toBeDefined();
    expect(announceCall(b), "the failed announce produced no message").toBeUndefined();
    const closing = closingCall(b);
    expect(closing, "the closing message is still sent (the transfer is not rolled back)").toBeDefined();
    expect(
      closing!.payload.text,
      "the closing message is exactly 'Lunch — moved from Source Chat' (the plain chat title)",
    ).toBe("Lunch — moved from Source Chat");
    expect(/t\.me\/|https?:\/\//.test(String(closing!.payload.text ?? "")), "the fallback carries no link").toBe(
      false,
    );
    // The transfer is not rolled back: the copy happened and the closing is a
    // reply to the root as usual (D87).
    expect(b.api.callsOf("copyMessage").length, "the copy is kept (no rollback)").toBeGreaterThan(0);
    const root = b.sends.find((s) => s.payload.chat_id === THREADS.id && s.payload.text === "Lunch");
    expect(root, "the root (title) message is posted").toBeDefined();
    expect(replyToOf(closing!.call), "the closing is a reply to the root (D87)").toBe(root!.id);
  });
});

// ------------------------------- UNIT-25 --------------------------------

/**
 * Edge-covering id generator: explicit edges (0, ±1, small negatives, the
 * `-100…` supergroup and `-` basic-group prefix shapes, safe-integer extremes)
 * mixed with full-range safe integers.
 */
const anyIdArb = fc.oneof(
  fc.constantFrom(
    0,
    -1,
    1,
    -99,
    -123456789,
    -1002000000000001,
    -1002000000000004,
    -100200000000001,
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  ),
  fc.integer({ min: -Number.MAX_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
);

describe("UNIT-25 property: the closing link is always https://t.me/c/{digits}/{digits} (fast-check, fixed seed)", () => {
  test("for any chat id and announce id the link matches ^https://t\\.me/c/\\d+/\\d+$ — never a bare t.me/c/{id}", async () => {
    await fc.assert(
      fc.property(anyIdArb, anyIdArb, (chatId, announceId) => {
        const link = announceMessageLink(chatId, announceId);
        expect(
          /^https:\/\/t\.me\/c\/\d+\/\d+$/.test(link),
          `chat ${chatId}, announce ${announceId}: ${JSON.stringify(link)} must match ^https://t\\.me/c/\\d+/\\d+$`,
        ).toBe(true);
        expect(
          /^https:\/\/t\.me\/c\/\d+$/.test(link),
          `chat ${chatId}, announce ${announceId}: ${JSON.stringify(link)} must never be a bare t.me/c/{id}`,
        ).toBe(false);
        // Oracle: the middle segment is exactly the D62-stripped chat id.
        expect(link, `chat ${chatId}: the stripped chat id is the middle segment`).toBe(
          `https://t.me/c/${chatLinkSegment(chatId)}/${link.split("/").pop()}`,
        );
      }),
      { seed: 20261029, numRuns: 200, endOnFailure: true },
    );
  });
});
