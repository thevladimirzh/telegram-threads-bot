/**
 * Unit tests — thread assembly per D87/D88 (UNIT-22, UNIT-23; R62, TDD).
 *
 * The user-reported bug: thread-body messages were attached with
 * `message_thread_id`, which only works in forum topics — in the plain threads
 * chat Telegram ignored it, so the reply thread never formed and `?thread=`
 * links broke.
 *
 * D87: every thread-body message of a transfer (each copy, each placeholder,
 * the closing message, the failure report) is sent as a REPLY to the thread
 * root (the first bot message carrying the title) — `reply_parameters.message_id`
 * / `reply_to_message_id` == root id — and NEVER carries `message_thread_id`.
 * `message_thread_id` remains only for the source-chat announce of a forum
 * source (D18/D69).
 * D88: albums are copied PER ITEM via `copyMessage` with reply to the root
 * (contiguous, in source order; `copyMessages` cannot reply and is not used
 * for thread assembly — media-group grouping is intentionally lost).
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { FakeApiError, FakeBotApi, FIXED_DATE, TEST_BOT_TOKEN, type RecordedCall } from "../helpers/fake-bot-api";
import { loadConfig } from "../../src/config";
import { InMemoryStore } from "../../src/store/in-memory";
import { createBot, type Logger } from "../../src/bot/createBot";

const AUTHOR = { id: 900002, is_bot: false, first_name: "Author", language_code: "en" };
const BOT_USER = { id: 1, is_bot: true, first_name: "Bot", username: "test_bot" };

const SOURCE = { id: -1001110000031, type: "supergroup", title: "Source Chat" };
const THREADS = { id: -1001110000032, type: "supergroup", title: "Threads Chat" };

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

// ------------------------------ fixtures ---------------------------------

type ContentKind = "text" | "photo" | "poll" | "service" | "invoice";

interface MsgSpec {
  id: number;
  date: number;
  kind: ContentKind;
  mediaGroup?: string;
}

function contentFields(spec: MsgSpec): Record<string, unknown> {
  switch (spec.kind) {
    case "text":
      return { text: `msg-${spec.id}` };
    case "photo":
      return {
        photo: [{ file_id: `ph-${spec.id}`, file_unique_id: `ph-${spec.id}`, width: 1, height: 1 }],
        caption: `cap-${spec.id}`,
      };
    case "poll":
      return { poll: { question: `Poll ${spec.id}?` } };
    case "service":
      return { service_event_type: "message_chat_join_by_link" };
    case "invoice":
      return { invoice: { title: "Invoice", total_amount: 100, currency: "USD" } };
  }
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
  /** Every sendMessage result id aligned with its recorded call. */
  sends: SendRec[];
}

async function boot(opts: { forumSource?: boolean } = {}): Promise<Boot> {
  const config = loadConfig(ENV);
  const store = new InMemoryStore();
  store.saveChat({
    chatId: SOURCE.id,
    type: "supergroup",
    title: SOURCE.title,
    isForum: opts.forumSource === true,
    source: true,
    threads: false,
  });
  store.saveChat({ chatId: THREADS.id, type: "supergroup", title: THREADS.title, isForum: false, source: false, threads: true });
  const bot = createBot({ store, now: () => new Date(FIXED_DATE * 1000), logger: silentLogger(), config });
  const api = new FakeBotApi();
  // The author is an admin of the source chat (D4: transfer rights).
  api.setMethodResult("getChatMember", {
    status: "administrator",
    user: { id: AUTHOR.id, is_bot: false, first_name: "Author" },
    can_delete_messages: true,
  });
  const sends: SendRec[] = [];
  let nextSendId = 1000;
  api.setMethodResult("sendMessage", (payload: Record<string, unknown>) => {
    const id = nextSendId++;
    sends.push({ id, call: api.calls[api.calls.length - 1], payload });
    return {
      message_id: id,
      date: FIXED_DATE,
      chat: { id: payload.chat_id ?? 0, type: "supergroup", title: "Fake chat" },
      from: { ...BOT_USER },
      ...(payload.text !== undefined ? { text: payload.text } : {}),
    };
  });
  bot.api.config.use(api.transformer);
  await bot.init();
  return { bot, api, store, sends };
}

let updateId = 1;

/** Given "the message … was observed by the bot" (source chat). */
async function observe(boot: Boot, spec: MsgSpec, messageThread?: number): Promise<void> {
  await boot.bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: spec.id,
      date: spec.date,
      chat: { ...SOURCE },
      from: { ...AUTHOR },
      ...contentFields(spec),
      ...(spec.mediaGroup !== undefined ? { media_group_id: spec.mediaGroup } : {}),
      ...(messageThread !== undefined ? { message_thread_id: messageThread } : {}),
    },
  });
}

/** The forward of the message `spec` into the threads chat (draft batch). */
async function forward(boot: Boot, spec: MsgSpec, forwardId: number): Promise<void> {
  await boot.bot.handleUpdate({
    update_id: updateId++,
    message: {
      message_id: forwardId,
      date: spec.date + 60,
      chat: { ...THREADS },
      from: { ...AUTHOR },
      ...contentFields(spec),
      ...(spec.mediaGroup !== undefined ? { media_group_id: spec.mediaGroup } : {}),
      forward_origin: {
        type: "user",
        sender_user: { ...AUTHOR },
        date: spec.date,
        chat: { ...SOURCE },
        sender_chat: { ...SOURCE },
      },
    },
  });
}

/** Pick the source chat with the newest dialog button, then send the title. */
async function completeDialog(boot: Boot, title: string): Promise<void> {
  const prompts = boot.api.callsOf("sendMessage").filter((c) => {
    const kb = c.payload.reply_markup as any;
    return c.payload.chat_id === THREADS.id && Array.isArray(kb?.inline_keyboard) && kb.inline_keyboard.length > 0;
  });
  const prompt = prompts[prompts.length - 1];
  expect(prompt, "the dialog must offer a button for the source chat").toBeDefined();
  const data = ((prompt!.payload.reply_markup as any).inline_keyboard as any[][])
    .flat()
    .map((b: any) => String(b?.callback_data ?? ""))
    .find((d: string) => d.includes(String(SOURCE.id)));
  expect(data, "the dialog must offer a button for the source chat").toBeDefined();
  await boot.bot.handleUpdate({
    update_id: updateId++,
    callback_query: {
      id: `cb-${updateId}`,
      from: { ...AUTHOR },
      message: { message_id: 3000, date: FIXED_DATE, chat: { ...THREADS } },
      chat_instance: "ci",
      data,
    },
  });
  await boot.bot.handleUpdate({
    update_id: updateId++,
    message: { message_id: 4000, date: FIXED_DATE, chat: { ...THREADS }, from: { ...AUTHOR }, text: title },
  });
}

// ---------------------------- observations -------------------------------

/** Message id a send/copy call replies to (`reply_to_message_id` / `reply_parameters`). */
function replyToOf(call: RecordedCall): number | undefined {
  const direct = call.payload.reply_to_message_id;
  if (direct !== undefined) return Number(direct);
  const params = call.payload.reply_parameters as { message_id?: unknown } | undefined;
  if (params?.message_id !== undefined) return Number(params.message_id);
  return undefined;
}

/** The thread root: the first bot message carrying the title. */
function rootRecord(boot: Boot, title: string): { id: number; call: RecordedCall; idx: number } {
  const rec = boot.sends.find((s) => s.payload.chat_id === THREADS.id && s.payload.text === title);
  expect(rec, "the root (title) message is posted into the threads chat").toBeDefined();
  return { id: rec!.id, call: rec!.call, idx: boot.api.calls.indexOf(rec!.call) };
}

/**
 * Thread-body posts after the root: content posts into the threads chat
 * (copies and non-dialog sendMessages) — everything that must reply to the root.
 */
function bodyCalls(boot: Boot, rootIdx: number): RecordedCall[] {
  return boot.api.calls.slice(rootIdx + 1).filter((c) => {
    if (c.payload.chat_id !== THREADS.id) return false;
    if (/^copy/.test(c.method)) return true;
    return c.method === "sendMessage" && (c.payload.reply_markup as any) == null;
  });
}

function hasExactText(boot: Boot, chatId: number, text: string): boolean {
  return boot.sends.some((s) => s.payload.chat_id === chatId && String(s.payload.text ?? "") === text);
}

// ------------------------------- UNIT-22 --------------------------------

describe("UNIT-22 thread-body sends reply to the root and never carry message_thread_id (D87/D88)", () => {
  test("copies, the placeholder and the closing message are replies to the root", async () => {
    const b = await boot();
    const batch: MsgSpec[] = [
      { id: 10, date: FIXED_DATE - 120, kind: "text" },
      { id: 11, date: FIXED_DATE - 60, kind: "photo" },
      { id: 12, date: FIXED_DATE - 30, kind: "poll" },
    ];
    for (const m of batch) await observe(b, m);
    for (const [i, m] of batch.entries()) await forward(b, m, 5000 + i);

    await completeDialog(b, "Lunch");

    const root = rootRecord(b, "Lunch");
    expect(replyToOf(root.call), "the root itself is not a reply").toBeUndefined();
    expect(root.call.payload.message_thread_id, "the root carries no message_thread_id (D87)").toBeUndefined();

    const body = bodyCalls(b, root.idx);
    expect(body.length, "copies + placeholder + closing are posted").toBeGreaterThanOrEqual(4);
    for (const c of body) {
      expect(replyToOf(c), `every thread-body message replies to the root (D87): ${c.method}`).toBe(root.id);
      expect(c.payload.message_thread_id, `no thread-body message carries message_thread_id (D87): ${c.method}`).toBeUndefined();
    }
    // per-item copies and the exact placeholder (D27) are present.
    expect(body.some((c) => c.method === "copyMessage" && c.payload.message_id === 10)).toBe(true);
    expect(body.some((c) => c.method === "copyMessage" && c.payload.message_id === 11)).toBe(true);
    expect(hasExactText(b, THREADS.id, "[poll] Poll 12?"), "the poll is replaced by its placeholder").toBe(true);
    expect(
      body.some((c) => c.method === "sendMessage" && /moved from/.test(String(c.payload.text ?? ""))),
      "the closing message is a thread-body message",
    ).toBe(true);
  });

  test("the failure report after a copy failure is a reply to the root (S40)", async () => {
    const b = await boot();
    const batch: MsgSpec[] = [
      { id: 10, date: FIXED_DATE - 120, kind: "text" },
      { id: 11, date: FIXED_DATE - 60, kind: "text" },
    ];
    for (const m of batch) await observe(b, m);
    for (const [i, m] of batch.entries()) await forward(b, m, 5000 + i);
    // The second copy post fails (non-429 -> no retry).
    let copies = 0;
    b.api.setMethodResult("copyMessage", () => {
      copies += 1;
      return copies >= 2 ? new FakeApiError({ error_code: 400, description: "Bad Request: copy failed" }) : { message_id: 3000 + copies };
    });

    await completeDialog(b, "Lunch");

    const root = rootRecord(b, "Lunch");
    const body = bodyCalls(b, root.idx);
    const failure = body.filter((c) => c.method === "sendMessage").pop();
    expect(failure, "the bot posts a localized failure message").toBeDefined();
    expect(
      replyToOf(failure!),
      "the failure report is a thread-body message — a reply to the root (D87, S40)",
    ).toBe(root.id);
    expect(failure!.payload.message_thread_id, "the failure report carries no message_thread_id").toBeUndefined();
  });

  test("album copies are per item and each is a reply to the root (D88)", async () => {
    const b = await boot();
    const album: MsgSpec[] = [
      { id: 20, date: FIXED_DATE - 60, kind: "photo", mediaGroup: "grp1" },
      { id: 21, date: FIXED_DATE - 30, kind: "photo", mediaGroup: "grp1" },
    ];
    for (const m of album) await observe(b, m);
    for (const [i, m] of album.entries()) await forward(b, m, 5000 + i);

    await completeDialog(b, "Lunch");

    const root = rootRecord(b, "Lunch");
    expect(b.api.callsOf("copyMessages"), "copyMessages is not used for thread assembly (D88)").toEqual([]);
    const copies = bodyCalls(b, root.idx).filter((c) => /^copy/.test(c.method));
    expect(copies.length, "the album is copied per item (D88)").toBe(2);
    expect(
      copies.map((c) => Number(c.payload.message_id)),
      "the album copies are contiguous and in source order (D88)",
    ).toEqual([20, 21]);
    for (const c of copies) {
      expect(replyToOf(c), "each album item is a reply to the root (D87/D88)").toBe(root.id);
      expect(c.payload.message_thread_id, "no album copy carries message_thread_id").toBeUndefined();
    }
  });

  test("the forum announce keeps message_thread_id while the thread body does not (D18/D69/D87)", async () => {
    const b = await boot({ forumSource: true });
    const batch: MsgSpec[] = [
      { id: 10, date: FIXED_DATE - 120, kind: "text" },
      { id: 11, date: FIXED_DATE - 60, kind: "text" },
    ];
    for (const m of batch) await observe(b, m, 7);
    for (const [i, m] of batch.entries()) await forward(b, m, 5000 + i);

    await completeDialog(b, "Lunch");

    const root = rootRecord(b, "Lunch");
    for (const c of bodyCalls(b, root.idx)) {
      expect(replyToOf(c), "every thread-body message replies to the root (D87)").toBe(root.id);
      expect(c.payload.message_thread_id, "no thread-body message carries message_thread_id (D87)").toBeUndefined();
    }
    const announce = b.api.callsOf("sendMessage").find((c) => c.payload.chat_id === SOURCE.id);
    expect(announce, "the announce is posted in the source chat").toBeDefined();
    expect(
      announce!.payload.message_thread_id,
      "the forum announce keeps message_thread_id (D18/D69)",
    ).toBe(7);
    expect(announce!.payload.message_thread_id).not.toBe(root.id);
  });
});

// ------------------------------- UNIT-23 --------------------------------

interface GenBatch {
  /** Messages in source order (ids and dates ascending). */
  messages: MsgSpec[];
  /** Forward (draft) arrival order — may split and reorder albums. */
  arrival: MsgSpec[];
}

const contentKindArb = fc.constantFrom<ContentKind>("text", "photo", "poll", "service", "invoice");

/** A batch group: a single message or an album of 2–3 items. */
const groupArb = fc.oneof(
  { weight: 3, arbitrary: contentKindArb.map((kind) => [kind]) },
  { weight: 2, arbitrary: fc.tuple(contentKindArb, contentKindArb) },
  { weight: 1, arbitrary: fc.tuple(contentKindArb, contentKindArb, contentKindArb) },
);

const batchArb: fc.Arbitrary<GenBatch> = fc
  .tuple(fc.array(groupArb, { minLength: 1, maxLength: 5 }), fc.array(fc.nat(), { minLength: 0, maxLength: 24 }))
  .map(([groups, keys]) => {
    const messages: MsgSpec[] = [];
    let id = 10;
    groups.forEach((kinds, groupIdx) => {
      const mediaGroup = kinds.length > 1 ? `g${groupIdx}` : undefined;
      for (const kind of kinds) {
        id += 1;
        messages.push({
          id,
          date: FIXED_DATE - 1000 + id * 2,
          kind,
          ...(mediaGroup !== undefined ? { mediaGroup } : {}),
        });
      }
    });
    const arrival = messages
      .map((m, i) => ({ m, k: keys[i] ?? i }))
      .sort((a, b) => a.k - b.k || a.m.id - b.m.id)
      .map((x) => x.m);
    return { messages, arrival };
  });

/**
 * Naive reference (oracle) for the expected copy order: D88 — albums are one
 * contiguous run in source order at their batch position; everything else
 * follows the (draft) batch order; placeholders produce no copy marker.
 */
function expectedMarkerSeq(batch: GenBatch): number[] {
  const byGroup = new Map<string, MsgSpec[]>();
  const entities: MsgSpec[][] = [];
  for (const m of batch.arrival) {
    if (m.mediaGroup !== undefined) {
      const existing = byGroup.get(m.mediaGroup);
      if (existing !== undefined) {
        existing.push(m);
        continue;
      }
      const entity = [m];
      byGroup.set(m.mediaGroup, entity);
      entities.push(entity);
      continue;
    }
    entities.push([m]);
  }
  for (const entity of entities) entity.sort((a, b) => a.date - b.date || a.id - b.id);
  return entities
    .flat()
    .filter((m) => m.kind === "text" || m.kind === "photo")
    .map((m) => m.id);
}

describe("UNIT-23 property: every body post names the root, albums per item (fast-check, fixed seed)", () => {
  test("reply target == root id, no message_thread_id, per-item album copies, ?thread= == root id", async () => {
    await fc.assert(
      fc.asyncProperty(batchArb, async (batch) => {
        const b = await boot();
        for (const m of batch.messages) await observe(b, m);
        for (const [i, m] of batch.arrival.entries()) await forward(b, m, 5000 + i);

        await completeDialog(b, "Lunch");

        const root = rootRecord(b, "Lunch");
        expect(replyToOf(root.call), "the root itself is not a reply").toBeUndefined();
        expect(root.call.payload.message_thread_id, "the root carries no message_thread_id").toBeUndefined();

        // D88: copyMessages cannot reply — it is never used for thread assembly.
        expect(b.api.callsOf("copyMessages")).toEqual([]);

        const body = bodyCalls(b, root.idx);
        for (const c of body) {
          expect(replyToOf(c), `every thread-body message replies to the root (D87): ${c.method}`).toBe(root.id);
          expect(c.payload.message_thread_id, `no thread-body message carries message_thread_id (D87): ${c.method}`).toBeUndefined();
        }

        // D88: one post per item — copies are per-item and follow the expected
        // order (albums contiguous and in source order).
        const markers = body
          .filter((c) => /^copy/.test(c.method))
          .map((c) => {
            expect(c.method, "copies are per item (D88)").toBe("copyMessage");
            return Number(c.payload.message_id);
          });
        expect(markers, "copy markers match the oracle order (D88)").toEqual(expectedMarkerSeq(batch));

        // The closing message completes the thread.
        expect(
          body.some((c) => c.method === "sendMessage" && /moved from/.test(String(c.payload.text ?? ""))),
          "the closing message is posted",
        ).toBe(true);

        // The ?thread= link of the announce names the root id.
        const announce = b.api.callsOf("sendMessage").find((c) => c.payload.chat_id === SOURCE.id);
        expect(announce, "the announce is posted in the source chat").toBeDefined();
        expect(
          String(announce!.payload.text ?? "").includes(`?thread=${root.id}`),
          `the ?thread= link equals the root id (${root.id})`,
        ).toBe(true);
      }),
      { seed: 20261029, numRuns: 200, endOnFailure: true },
    );
  });
});
