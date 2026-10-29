/**
 * Unit tests — transfer completion audit record (SEC-F1, R61/T-R1, TDD).
 *
 * A destructive transfer deletes originals in the source chat, so its
 * completion log record must carry the audit trail (docs/security/report.md
 * SEC-F1): the initiator (user id), source chat id, thread root id, the ids of
 * the deleted originals and the D74 class counts (deleted / not_found /
 * forbidden / failed). Hard constraints (SEC-8): no secrets and no user
 * content (message text, titles) may appear in log records — ids only.
 */
import { describe, expect, test } from "vitest";
import { FakeApiError, FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, type RecordedCall } from "../helpers/fake-bot-api";
import { loadConfig } from "../../src/config";
import { InMemoryStore } from "../../src/store/in-memory";
import { createBot, type Logger } from "../../src/bot/createBot";

const AUTHOR = { id: 900002, is_bot: false, first_name: "Author", language_code: "en" };

const SOURCE = { id: -1001110000021, type: "supergroup", title: "Source Chat" };
const THREADS = { id: -1001110000022, type: "supergroup", title: "Threads Chat" };

const ENV = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: "postgresql://threads_app:sup3r-secret-pw@db.internal:5432/threads",
  ADMIN_IDS: "900001",
  MODE: "polling",
};

function recordingLogger(sink: Record<string, unknown>[]): Logger {
  const push = (obj: unknown): void => {
    if (obj && typeof obj === "object") sink.push(obj as Record<string, unknown>);
  };
  return { fatal: push, error: push, warn: push, info: push, debug: push, trace: push };
}

interface Boot {
  bot: any;
  api: FakeBotApi;
  store: InMemoryStore;
  records: Record<string, unknown>[];
}

async function boot(): Promise<Boot> {
  const config = loadConfig(ENV);
  const store = new InMemoryStore();
  store.saveChat({ chatId: SOURCE.id, type: "supergroup", title: SOURCE.title, isForum: false, source: true, threads: false });
  store.saveChat({ chatId: THREADS.id, type: "supergroup", title: THREADS.title, isForum: false, source: false, threads: true });
  const records: Record<string, unknown>[] = [];
  const bot = createBot({ store, now: () => new Date(FIXED_DATE * 1000), logger: recordingLogger(records), config });
  const api = new FakeBotApi();
  // The author is an admin of the source chat (D4: transfer rights).
  api.setMethodResult("getChatMember", {
    status: "administrator",
    user: { id: AUTHOR.id, is_bot: false, first_name: "Author" },
    can_delete_messages: true,
  });
  bot.api.config.use(api.transformer);
  await bot.init();
  return { bot, api, store, records };
}

let updateId = 1;

/** An indexed source message (observed in the source chat). */
async function observe(bot: any, id: number, at: number, text: string): Promise<void> {
  await bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: id, date: at, chat: { ...SOURCE }, from: { ...AUTHOR }, text },
  });
}

/** The forward of message `id` into the threads chat (opens/joins the draft). */
async function forward(bot: any, id: number, at: number, text: string, forwardId: number): Promise<void> {
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
        chat: { ...SOURCE },
        sender_chat: { ...SOURCE },
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

/** Pick `chat` with the newest dialog button, then send the thread title. */
async function completeDialog(bot: any, api: FakeBotApi, title: string): Promise<void> {
  const prompts = dialogPrompts(api);
  const kb = prompts[prompts.length - 1].payload.reply_markup as any;
  const data = (kb?.inline_keyboard ?? [])
    .flat()
    .map((b: any) => String(b?.callback_data ?? ""))
    .find((d: string) => d.includes(String(SOURCE.id)));
  expect(data, "the dialog must offer a button for the source chat").toBeDefined();
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
    message: { message_id: 2000, date: FIXED_DATE, chat: { ...THREADS }, from: { ...AUTHOR }, text: title },
  });
}

function completionRecord(records: Record<string, unknown>[]): Record<string, unknown> {
  const record = records.find((r) => r.event === "transfer_completed");
  expect(record, "a transfer_completed log record is emitted").toBeDefined();
  return record as Record<string, unknown>;
}

describe("SEC-F1/R61: the transfer_completed log record carries the audit trail", () => {
  test("initiator, source chat, thread root, deleted ids and D74 class counts (happy path)", async () => {
    const { bot, api, store, records } = await boot();
    await observe(bot, 10, FIXED_DATE - 120, "text-10");
    await observe(bot, 11, FIXED_DATE - 60, "text-11");
    await forward(bot, 10, FIXED_DATE - 120, "text-10", 100);
    await forward(bot, 11, FIXED_DATE - 60, "text-11", 101);

    await completeDialog(bot, api, "Lunch");

    const record = completionRecord(records);
    expect(record).toMatchObject({
      authorId: AUTHOR.id,
      sourceChatId: SOURCE.id,
      threadsChatId: THREADS.id,
      deletedMessageIds: [10, 11],
      deleted: 2,
      notFound: 0,
      forbidden: 0,
      failed: 0,
    });
    expect(Number.isInteger(record.rootMessageId), "thread root id is logged").toBe(true);
    expect(store.getThread(record.rootMessageId as number)?.createdBy, "the logged root matches the created thread").toBe(AUTHOR.id);
  });

  test("D74 class counts per outcome and only really deleted ids in deletedMessageIds", async () => {
    const { bot, api, records } = await boot();
    for (const [id, at, text] of [
      [10, FIXED_DATE - 240, "text-10"],
      [11, FIXED_DATE - 180, "text-11"],
      [12, FIXED_DATE - 120, "text-12"],
      [13, FIXED_DATE - 60, "text-13"],
    ] as const) {
      await observe(bot, id, at, text);
      await forward(bot, id, at, text, id + 100);
    }
    // Batch deletion of the originals fails without retry_after -> per-message
    // fallback: 10 deletes, 11 is forbidden, 12 is not found, 13 fails.
    api.setMethodResult("deleteMessages", (payload: Record<string, unknown>) =>
      payload.chat_id === SOURCE.id
        ? new FakeApiError({ error_code: 400, description: "Bad Request: bulk delete failed" })
        : true,
    );
    api.setMethodResult("deleteMessage", (payload: Record<string, unknown>) => {
      const id = Number(payload.message_id);
      if (id === 11) return new FakeApiError({ error_code: 403, description: "Forbidden: can't delete message" });
      if (id === 12) return new FakeApiError({ error_code: 400, description: "message to delete not found" });
      if (id === 13) return new FakeApiError({ error_code: 400, description: "Bad Request: unknown error" });
      return true;
    });

    await completeDialog(bot, api, "Lunch");

    const record = completionRecord(records);
    expect(record).toMatchObject({
      authorId: AUTHOR.id,
      sourceChatId: SOURCE.id,
      deletedMessageIds: [10],
      deleted: 1,
      notFound: 1,
      forbidden: 1,
      failed: 1,
    });
  });

  test("SEC-8: the audit record carries ids only — no message text, title or token", async () => {
    const { bot, api, records } = await boot();
    await observe(bot, 10, FIXED_DATE - 120, "text-10");
    await forward(bot, 10, FIXED_DATE - 120, "text-10", 100);

    await completeDialog(bot, api, "Lunch");

    const record = completionRecord(records);
    const dump = JSON.stringify(record);
    expect(dump).not.toContain("text-10");
    expect(dump).not.toContain("Lunch");
    expect(dump).not.toContain(TEST_BOT_TOKEN);
  });
});
