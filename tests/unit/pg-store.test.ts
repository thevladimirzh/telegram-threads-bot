/**
 * Unit tests — src/store/pg.ts (D85): the Drizzle/pg-backed store WITHOUT a
 * real database (D25). All SQL goes through a stubbed query interface (a fake
 * pg pool installed as the Drizzle driver, see pg-test-stub.ts), so these
 * tests pin, deterministically:
 *   - hydrate (`load()`) row mapping: bigint strings → numbers, ISO strings →
 *     ms timestamps, `null` → absent optionals / explicit `null`, jsonb kept;
 *   - SQL construction per mutation (which table, upsert vs delete, params);
 *   - `ping()` reaching the driver (`select 1`) and failing on driver errors;
 *   - write queue semantics (`flush()`), error tolerance of persistence;
 *   - record ⇄ row mapper round-trips (property-based, fixed seed).
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import {
  PgStore,
  chatFromRow,
  chatToRow,
  draftFromRow,
  draftToRow,
  sourceMessageFromRow,
  sourceMessageToRow,
  threadFromRow,
  threadMessageFromRow,
  threadMessageToRow,
  threadToRow,
  userFromRow,
  userToRow,
} from "../../src/store/pg";
import { StubPgPool, stubDatabase } from "./pg-test-stub";
import {
  chatArb,
  draftArb,
  sourceMessageArb,
  threadArb,
  userArb,
  draftMessageArb,
} from "./store-arbitraries";

const OPENED_AT = "2023-11-14T22:13:20.000Z";
const OPENED_MS = Date.parse(OPENED_AT);

function newStore(pool: StubPgPool = new StubPgPool()): { store: PgStore; pool: StubPgPool } {
  return { store: new PgStore(stubDatabase(pool)), pool };
}

function warnRecorder(): { logger: { warn: (obj: unknown, msg?: string) => void }; warnings: unknown[] } {
  const warnings: unknown[] = [];
  return {
    logger: { warn: (obj: unknown) => void warnings.push(obj) },
    warnings,
  };
}

describe("PgStore.load() — hydration from raw driver rows", () => {
  test("maps every table: bigints to numbers, ISO dates to ms, nulls to absent optionals", async () => {
    const pool = new StubPgPool();
    // Raw rows use the schema column order; bigint columns come back as
    // strings and timestamptz as ISO strings (pg driver, rowMode "array").
    pool.rowsFor("chats", [["-1001", "supergroup", "Source Chat", "src", 1, 1, 0]]);
    pool.rowsFor("users", [["42", "ru"], ["43", null]]);
    pool.rowsFor("drafts", [
      [
        "-1001",
        "7",
        OPENED_AT,
        null,
        "-1002",
        1,
        "9",
        [{ forwardId: 5, originChatId: -1002, originDate: 1700000000, senderId: 7, content: { kind: "text", text: "hi" } }],
      ],
    ]);
    pool.rowsFor("threads", [["10", "Lunch", "-1002", "-1001", "10", "3", "7", OPENED_AT]]);
    pool.rowsFor("thread_messages", [
      ["10", "11", "copy", "5"],
      ["10", "12", "placeholder", null],
    ]);
    pool.rowsFor("source_messages", [
      ["-1002", "5", "1700000000", "7", { kind: "text", text: "hi" }, "3", null],
      ["-1002", "6", "1700000001", null, { kind: "invoice" }, null, "10"],
    ]);
    const { store } = newStore(pool);

    await store.load();

    expect(store.getChat(-1001)).toEqual({
      chatId: -1001,
      type: "supergroup",
      title: "Source Chat",
      username: "src",
      isForum: true,
      source: true,
      threads: false,
    });
    expect(store.getUser(42)).toEqual({ userId: 42, locale: "ru" });
    expect(store.getUser(43)).toEqual({ userId: 43 });
    expect(store.getDraft({ threadsChatId: -1001, authorId: 7 })).toEqual({
      threadsChatId: -1001,
      authorId: 7,
      openedAt: OPENED_MS,
      pickedChatId: null,
      preselectedChatId: -1002,
      pickedAuthorized: true,
      dialogMessageId: 9,
      batch: [
        { forwardId: 5, originChatId: -1002, originDate: 1700000000, senderId: 7, content: { kind: "text", text: "hi" } },
      ],
    });
    expect(store.getThread(10)).toEqual({
      threadId: 10,
      title: "Lunch",
      sourceChatId: -1002,
      threadsChatId: -1001,
      rootMessageId: 10,
      messageThreadId: 3,
      createdBy: 7,
      createdAt: OPENED_MS,
    });
    expect(store.listThreadMessages(10)).toEqual([
      { threadId: 10, messageId: 11, kind: "copy", sourceMessageId: 5 },
      { threadId: 10, messageId: 12, kind: "placeholder" },
    ]);
    expect(store.getSourceMessage(-1002, 5)).toEqual({
      chatId: -1002,
      messageId: 5,
      date: 1700000000,
      senderId: 7,
      content: { kind: "text", text: "hi" },
      messageThreadId: 3,
    });
    expect(store.getSourceMessage(-1002, 6)).toEqual({
      chatId: -1002,
      messageId: 6,
      date: 1700000001,
      senderId: null,
      content: { kind: "invoice" },
      threadId: 10,
    });
    // Hydration is read-only: it issues selects and no writes.
    expect(pool.calls.every((call) => call.text.startsWith("select "))).toBe(true);
  });

  test("load() over empty tables yields an empty store", async () => {
    const { store } = newStore();
    await store.load();
    expect(store.listChats()).toEqual([]);
    expect(store.listDrafts()).toEqual([]);
    expect(store.listThreads()).toEqual([]);
    expect(store.listSourceMessages(-1)).toEqual([]);
    expect(store.getChat(1)).toBeUndefined();
  });
});

describe("PgStore — SQL construction per mutation (stubbed query interface)", () => {
  test("saveChat upserts the chats row with mapped params", async () => {
    const { store, pool } = newStore();
    store.saveChat({ chatId: -1001, type: "supergroup", title: "T", username: "u", isForum: true, source: true, threads: false });
    await store.flush();

    const [call] = pool.callsTo("chats");
    expect(call.text).toContain('insert into "chats"');
    expect(call.text).toContain("on conflict");
    for (const param of [BigInt(-1001), "supergroup", "T", "u", 1]) {
      expect(call.params, `params must contain ${String(param)}`).toContain(param);
    }
  });

  test("saveUser upserts the users row", async () => {
    const { store, pool } = newStore();
    store.saveUser({ userId: 42, locale: "ru" });
    await store.flush();

    const [call] = pool.callsTo("users");
    expect(call.text).toContain('insert into "users"');
    expect(call.text).toContain("on conflict");
    expect(call.params).toContain(BigInt(42));
    expect(call.params).toContain("ru");
  });

  test("saveDraft upserts the drafts row (timestamp as ISO string, batch as JSON)", async () => {
    const { store, pool } = newStore();
    store.saveDraft({
      threadsChatId: -1001,
      authorId: 7,
      openedAt: OPENED_MS,
      batch: [{ forwardId: 5, originChatId: -1002, originDate: 1700000000, senderId: 7, content: { kind: "text", text: "hi" } }],
      pickedChatId: null,
      preselectedChatId: -1002,
    });
    await store.flush();

    const [call] = pool.callsTo("drafts");
    expect(call.text).toContain('insert into "drafts"');
    expect(call.text).toContain("on conflict");
    expect(call.params).toContain(BigInt(-1001));
    expect(call.params).toContain(BigInt(7));
    expect(call.params).toContain(OPENED_AT);
    const batchParam = call.params.find((p) => typeof p === "string" && p.startsWith("["));
    expect(JSON.parse(String(batchParam))).toEqual([
      { forwardId: 5, originChatId: -1002, originDate: 1700000000, senderId: 7, content: { kind: "text", text: "hi" } },
    ]);
  });

  test("removeDraft deletes by both key columns", async () => {
    const { store, pool } = newStore();
    store.removeDraft({ threadsChatId: -1001, authorId: 7 });
    await store.flush();

    const [call] = pool.callsTo("drafts");
    expect(call.text).toContain('delete from "drafts"');
    expect(call.text).toContain("where");
    expect(call.params).toContain(BigInt(-1001));
    expect(call.params).toContain(BigInt(7));
  });

  test("saveThread upserts the threads row", async () => {
    const { store, pool } = newStore();
    store.saveThread({
      threadId: 10,
      title: "Lunch",
      sourceChatId: -1002,
      threadsChatId: -1001,
      rootMessageId: 10,
      messageThreadId: 3,
      createdBy: 7,
      createdAt: OPENED_MS,
    });
    await store.flush();

    const [call] = pool.callsTo("threads");
    expect(call.text).toContain('insert into "threads"');
    expect(call.params).toContain(BigInt(10));
    expect(call.params).toContain("Lunch");
    expect(call.params).toContain(OPENED_AT);
  });

  test("saveThreadMessage inserts the thread_messages row", async () => {
    const { store, pool } = newStore();
    store.saveThreadMessage(10, 11, "copy", 5);
    await store.flush();

    const [call] = pool.callsTo("thread_messages");
    expect(call.text).toContain('insert into "thread_messages"');
    expect(call.params).toEqual([BigInt(10), BigInt(11), "copy", BigInt(5)]);
  });

  test("indexSourceMessage upserts the source_messages row (content as JSON)", async () => {
    const { store, pool } = newStore();
    store.indexSourceMessage({
      chatId: -1002,
      messageId: 5,
      date: 1700000000,
      senderId: 7,
      content: { kind: "text", text: "hi" },
      messageThreadId: 3,
      threadId: 10,
    });
    await store.flush();

    const [call] = pool.callsTo("source_messages");
    expect(call.text).toContain('insert into "source_messages"');
    expect(call.text).toContain("on conflict");
    expect(call.params).toContain(BigInt(-1002));
    expect(call.params).toContain(BigInt(5));
    const contentParam = call.params.find((p) => typeof p === "string" && p.startsWith("{"));
    expect(JSON.parse(String(contentParam))).toEqual({ kind: "text", text: "hi" });
  });
});

describe("PgStore — ping and the write queue", () => {
  test("ping() probes the driver with select 1 and rejects on driver errors", async () => {
    const { store, pool } = newStore();
    await expect(store.ping()).resolves.toBeUndefined();
    expect(pool.calls.at(-1)?.text).toBe("select 1");

    pool.failNext(new Error("db down"));
    const error: (Error & { cause?: unknown }) | undefined = await store.ping().then(
      () => undefined,
      (e: unknown) => e as Error & { cause?: unknown },
    );
    expect(error, "ping must reject when the database fails").toBeDefined();
    expect(String(error?.cause), "the driver error stays reachable via cause").toContain("db down");
  });

  test("writes are queued asynchronously, ordered and awaited by flush()", async () => {
    const { store, pool } = newStore();
    store.saveUser({ userId: 1 });
    store.saveUser({ userId: 2 });
    expect(pool.calls, "writes must not block the synchronous interface").toHaveLength(0);

    await store.flush();
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0].params).toContain(BigInt(1));
    expect(pool.calls[1].params).toContain(BigInt(2));
  });

  test("a failing write is logged and never disturbs reads or flush()", async () => {
    const { logger, warnings } = warnRecorder();
    const pool = new StubPgPool();
    const store = new PgStore(stubDatabase(pool), { logger });
    pool.failNext(new Error("db down"));

    store.saveChat({ chatId: -1001, type: "supergroup", title: "T", isForum: false, source: true, threads: false });
    await store.flush();

    expect(store.getChat(-1001)?.title, "the cache stays authoritative").toBe("T");
    expect(warnings.length, "the persistence failure must be logged").toBeGreaterThan(0);
  });
});

describe("PgStore row mappers — round-trip properties (seed fixed)", () => {
  const fcOptions = { seed: 20261029, numRuns: 100 };

  test("chatFromRow(chatToRow(x)) == x", () => {
    fc.assert(
      fc.property(chatArb, (chat) => {
        expect(chatFromRow(chatToRow(chat))).toEqual(chat);
        return true;
      }),
      fcOptions,
    );
  });

  test("userFromRow(userToRow(x)) == x", () => {
    fc.assert(
      fc.property(userArb, (user) => {
        expect(userFromRow(userToRow(user))).toEqual(user);
        return true;
      }),
      fcOptions,
    );
  });

  test("draftFromRow(draftToRow(x)) == x", () => {
    fc.assert(
      fc.property(draftArb, (draft) => {
        expect(draftFromRow(draftToRow(draft))).toEqual(draft);
        return true;
      }),
      fcOptions,
    );
  });

  test("threadFromRow(threadToRow(x)) == x", () => {
    fc.assert(
      fc.property(threadArb, (thread) => {
        expect(threadFromRow(threadToRow(thread))).toEqual(thread);
        return true;
      }),
      fcOptions,
    );
  });

  test("threadMessageFromRow(threadMessageToRow(x)) == x", () => {
    fc.assert(
      fc.property(
        draftMessageArb.map(({ forwardId, senderId }) => ({
          threadId: forwardId,
          messageId: senderId ?? 1,
          kind: "copy",
          ...(senderId !== null ? { sourceMessageId: senderId } : {}),
        })),
        (row) => {
          expect(threadMessageFromRow(threadMessageToRow(row))).toEqual(row);
          return true;
        },
      ),
      fcOptions,
    );
  });

  test("sourceMessageFromRow(sourceMessageToRow(x)) == x", () => {
    fc.assert(
      fc.property(sourceMessageArb, (record) => {
        expect(sourceMessageFromRow(sourceMessageToRow(record))).toEqual(record);
        return true;
      }),
      fcOptions,
    );
  });
});
