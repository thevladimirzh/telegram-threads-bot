/**
 * Unit tests — createBot draft batch semantics (D68 final + D84 + D16, R30).
 *
 * While a draft is open, a new forward from the same author:
 * - from the same source chat JOINS the batch in place (S32) — no second
 *   dialog message, no refusal;
 * - from a DIFFERENT CONNECTED source chat posts a NEW dialog message (chat
 *   buttons + title request) and clears the chat/title selection (S83, D68
 *   final). The replaced messages stay in the batch as D16 mixed-batch
 *   material: completion transfers only the picked chat's messages — S83's
 *   own "the draft holds only msg 20" probe (pick "Other Chat" -> only 20)
 *   and acceptance S64 (pick "Source Chat" -> only 10) both pin this; S64
 *   REQUIRES retention (its `copyMarkerSeq == [10]` is impossible once the
 *   batch is reset) and therefore refutes the "batch = the new forward's
 *   messages" wording of D68 — flagged to the orchestrator in the report;
 * - from an unconnected chat is refused per AC16/S19 and leaves the draft
 *   untouched (S19 class, D84: "regardless of draft state").
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, type RecordedCall } from "../helpers/fake-bot-api";
import { loadConfig } from "../../src/config";
import { InMemoryStore } from "../../src/store/in-memory";
import { createBot, type Logger } from "../../src/bot/createBot";
import { isDifferentSourceChat } from "../../src/domain/batch";

const AUTHOR = { id: 900002, is_bot: false, first_name: "Author", language_code: "en" };

const SOURCE = { id: -1001110000011, type: "supergroup", title: "Source Chat" };
const OTHER = { id: -1001110000012, type: "supergroup", title: "Other Chat" };
const UNCONNECTED = { id: -1001110000013, type: "supergroup", title: "Unconnected Chat" };
const THREADS = { id: -1001110000014, type: "supergroup", title: "Threads Chat" };

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

interface Boot {
  bot: any;
  api: FakeBotApi;
  store: InMemoryStore;
}

async function boot(): Promise<Boot> {
  const config = loadConfig(ENV);
  const store = new InMemoryStore();
  // Connected chats are seeded straight into the store — the /settings flow is
  // covered by acceptance settings.test.ts; these tests pin the draft logic.
  store.saveChat({ chatId: SOURCE.id, type: "supergroup", title: SOURCE.title, isForum: false, source: true, threads: false });
  store.saveChat({ chatId: OTHER.id, type: "supergroup", title: OTHER.title, isForum: false, source: true, threads: false });
  store.saveChat({ chatId: THREADS.id, type: "supergroup", title: THREADS.title, isForum: false, source: false, threads: true });
  const bot = createBot({ store, now: () => new Date(FIXED_DATE * 1000), logger: silentLogger(), config });
  const api = new FakeBotApi();
  // The author is an admin of both source chats (D4: transfer rights) — the
  // dialog pick and the transfer check this via getChatMember.
  api.setMethodResult("getChatMember", {
    status: "administrator",
    user: { id: AUTHOR.id, is_bot: false, first_name: "Author" },
    can_delete_messages: true,
  });
  bot.api.config.use(api.transformer);
  await bot.init();
  return { bot, api, store };
}

let updateId = 1;

async function observe(bot: any, chat: { id: number; type: string; title: string }, id: number, at: number, text: string): Promise<void> {
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: id, date: at, chat: { ...chat }, from: { ...AUTHOR }, text },
  });
}

async function forward(
  bot: any,
  chat: { id: number; type: string; title: string },
  id: number,
  at: number,
  text: string,
  forwardId: number,
): Promise<void> {
  await bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: forwardId,
      date: at + 60,
      chat: { ...THREADS },
      from: { ...AUTHOR },
      text,
      forward_origin: {
        type: "user",
        sender_user: { ...AUTHOR },
        date: at,
        chat: { ...chat },
        sender_chat: { ...chat },
      },
    },
  });
}

function dialogPrompts(api: FakeBotApi): RecordedCall[] {
  return api.callsOf("sendMessage").filter((c) => {
    const kb = c.payload.reply_markup as any;
    return c.payload.chat_id === THREADS.id && Array.isArray(kb?.inline_keyboard) && kb.inline_keyboard.length > 0;
  });
}

function buttonDataOf(call: RecordedCall): string[] {
  const kb = call.payload.reply_markup as any;
  return (kb?.inline_keyboard ?? []).flat().map((b: any) => String(b?.callback_data ?? ""));
}

/** Pick `chat` with the newest dialog button, then send the thread title. */
async function completeDialog(bot: any, api: FakeBotApi, chat: { id: number; type: string; title: string }): Promise<void> {
  const prompts = dialogPrompts(api);
  const data = buttonDataOf(prompts[prompts.length - 1]).find((d) => d.includes(String(chat.id)));
  expect(data, `the dialog must offer a button for ${chat.title}`).toBeDefined();
  await bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: `cb-${updateId}`,
      from: { ...AUTHOR },
      message: { message_id: 1000, date: FIXED_DATE, chat: { ...THREADS } },
      chat_instance: "ci",
      data,
    },
  });
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: 2000, date: FIXED_DATE, chat: { ...THREADS }, from: { ...AUTHOR }, text: "Lunch" },
  });
}

function copiedIds(api: FakeBotApi): number[] {
  return api.callsOf("copyMessage").map((c) => Number(c.payload.message_id));
}

function deletedIdsIn(api: FakeBotApi, chatId: number): number[] {
  const ids: number[] = [];
  for (const call of api.callsOf("deleteMessages")) {
    if (call.payload.chat_id === chatId) ids.push(...(call.payload.message_ids as unknown[]).map(Number));
  }
  for (const call of api.callsOf("deleteMessage")) {
    if (call.payload.chat_id === chatId) ids.push(Number(call.payload.message_id));
  }
  return ids;
}

describe("D68 (final)/D84: a forward while a draft is open", () => {
  test("the same source chat joins the open batch in place — no second dialog message (S32)", async () => {
    const { bot, api, store } = await boot();
    await observe(bot, SOURCE, 10, FIXED_DATE - 120, "text-10");
    await observe(bot, SOURCE, 11, FIXED_DATE - 60, "text-11");
    await forward(bot, SOURCE, 10, FIXED_DATE - 120, "text-10", 100);

    await forward(bot, SOURCE, 11, FIXED_DATE - 60, "text-11", 101);

    expect(dialogPrompts(api).length, "no second dialog message — the draft is joined, not re-opened").toBe(1);
    const draft = store.getDraft({ threadsChatId: THREADS.id, authorId: AUTHOR.id });
    expect(draft?.batch.map((m) => m.forwardId), "the draft holds both messages").toEqual([100, 101]);

    await completeDialog(bot, api, SOURCE);
    expect(copiedIds(api), "both messages transfer in source order").toEqual([10, 11]);
  });

  test("a different connected source chat posts a NEW dialog message and clears the chat/title selection (S83)", async () => {
    const { bot, api, store } = await boot();
    await observe(bot, SOURCE, 10, FIXED_DATE - 120, "text-10");
    await observe(bot, OTHER, 20, FIXED_DATE - 60, "text-20");
    await forward(bot, SOURCE, 10, FIXED_DATE - 120, "text-10", 100);

    await forward(bot, OTHER, 20, FIXED_DATE - 60, "text-20", 101);

    const prompts = dialogPrompts(api);
    expect(prompts.length, "a NEW dialog message is posted (the draft is recreated)").toBe(2);
    const fresh = prompts[prompts.length - 1];
    expect(fresh.method, "the new dialog message is a new post, not an edit").toBe("sendMessage");
    expect(String(fresh.payload.text ?? "").length, "the new dialog message asks for the thread title").toBeGreaterThan(0);
    const data = buttonDataOf(fresh);
    expect(data.some((d) => d.includes(String(OTHER.id))), "the new dialog offers 'Other Chat'").toBe(true);
    expect(data.some((d) => d.includes(String(SOURCE.id))), "the new dialog offers 'Source Chat' (it asks for the source chat)").toBe(true);
    expect(data.some((d) => d.endsWith(":sel")), "no chat is preselected — the chat/title selection is cleared").toBe(false);

    const draft = store.getDraft({ threadsChatId: THREADS.id, authorId: AUTHOR.id });
    expect(draft?.pickedChatId, "the explicit chat pick is cleared").toBeNull();
    expect(draft?.preselectedChatId, "the preselection is cleared").toBeNull();
  });

  test("S83 probe: completing with the new chat transfers only the new message", async () => {
    const { bot, api } = await boot();
    await observe(bot, SOURCE, 10, FIXED_DATE - 120, "text-10");
    await observe(bot, OTHER, 20, FIXED_DATE - 60, "text-20");
    await forward(bot, SOURCE, 10, FIXED_DATE - 120, "text-10", 100);
    await forward(bot, OTHER, 20, FIXED_DATE - 60, "text-20", 101);

    await completeDialog(bot, api, OTHER);

    expect(copiedIds(api), "the thread copies hold the message 20").toEqual([20]);
    expect(deletedIdsIn(api, OTHER.id), "exactly the original 20 is deleted in 'Other Chat'").toEqual([20]);
    expect(deletedIdsIn(api, SOURCE.id), "nothing is deleted in 'Source Chat'").toEqual([]);
  });

  test("S64 probe: the replaced messages stay available for the D16 chat pick (batch retention)", async () => {
    const { bot, api } = await boot();
    await observe(bot, SOURCE, 10, FIXED_DATE - 120, "text-10");
    await observe(bot, OTHER, 20, FIXED_DATE - 60, "text-20");
    await forward(bot, SOURCE, 10, FIXED_DATE - 120, "text-10", 100);
    await forward(bot, OTHER, 20, FIXED_DATE - 60, "text-20", 101);

    await completeDialog(bot, api, SOURCE);

    // Acceptance S64 pins this: after a second forward from another connected
    // chat, picking the FIRST chat still transfers its message ("the thread
    // contains only the copy of the message 10") and the whole forwarded batch
    // is deleted. A strict "batch = the new forward's messages" reset makes
    // S64 impossible — the acceptance suite forces retention (see header).
    expect(copiedIds(api), "the thread contains only the copy of the message 10").toEqual([10]);
    expect(deletedIdsIn(api, THREADS.id), "the whole forwarded batch is deleted in the threads chat").toEqual(
      expect.arrayContaining([100, 101]),
    );
  });

  test("an unconnected-chat forward is refused and leaves the draft untouched (S19/D84)", async () => {
    const { bot, api, store } = await boot();
    await observe(bot, SOURCE, 10, FIXED_DATE - 120, "text-10");
    await forward(bot, SOURCE, 10, FIXED_DATE - 120, "text-10", 100);
    const before = store.getDraft({ threadsChatId: THREADS.id, authorId: AUTHOR.id });

    await forward(bot, UNCONNECTED, 30, FIXED_DATE - 60, "text-30", 101);

    const texts = api.callsOf("sendMessage").map((c) => String(c.payload.text ?? ""));
    expect(texts.join("\n"), "the refusal names the not-connected chat").toContain("Unconnected Chat");
    expect(dialogPrompts(api).length, "no second dialog message").toBe(1);
    const after = store.getDraft({ threadsChatId: THREADS.id, authorId: AUTHOR.id });
    expect(after?.batch.map((m) => m.forwardId), "the draft still holds only the original batch").toEqual([100]);
    expect(after?.pickedChatId, "the selection is untouched").toBe(before?.pickedChatId ?? null);

    await completeDialog(bot, api, SOURCE);
    expect(copiedIds(api), "the untouched draft completes with its original message").toEqual([10]);
  });
});

describe("isDifferentSourceChat properties (fast-check, fixed seed)", () => {
  const origin = fc.option(fc.integer({ min: -1000, max: 1000 }), { nil: null });

  test("never throws and is total on arbitrary batches", () => {
    fc.assert(
      fc.property(fc.array(origin, { maxLength: 10 }), origin, (batch, incoming) => {
        const chats = batch.map((originChatId) => ({ originChatId }));
        expect(typeof isDifferentSourceChat(chats, incoming)).toBe("boolean");
      }),
      { seed: 20261028, numRuns: 200 },
    );
  });

  test("a hidden-sender forward or an empty batch is never 'different'", () => {
    fc.assert(
      fc.property(fc.array(origin, { maxLength: 10 }), (batch) => {
        const chats = batch.map((originChatId) => ({ originChatId }));
        expect(isDifferentSourceChat(chats, null)).toBe(false);
        expect(isDifferentSourceChat([], null)).toBe(false);
      }),
      { seed: 20261028, numRuns: 100 },
    );
  });

  test("a chat already named in the batch is never 'different' (join invariant)", () => {
    fc.assert(
      fc.property(origin, fc.array(origin, { maxLength: 10 }), (chat, rest) => {
        const chats = [{ originChatId: chat }, ...rest.map((originChatId) => ({ originChatId }))];
        if (chat === null) return;
        expect(isDifferentSourceChat(chats, chat)).toBe(false);
      }),
      { seed: 20261028, numRuns: 200 },
    );
  });

  test("a named incoming chat absent from a batch that names chats is 'different'", () => {
    fc.assert(
      fc.property(
        fc.array(origin, { minLength: 1, maxLength: 10 }).map((batch) =>
          batch.map((originChatId) => ({ originChatId })),
        ),
        fc.integer({ min: -1000, max: 1000 }),
        (chats, incoming) => {
          const named = chats.some((m) => m.originChatId !== null);
          const seen = chats.some((m) => m.originChatId === incoming);
          expect(isDifferentSourceChat(chats, incoming)).toBe(named && !seen);
        },
      ),
      { seed: 20261028, numRuns: 200 },
    );
  });
});
