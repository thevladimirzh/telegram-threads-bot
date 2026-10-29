/**
 * Shared Store contract semantics (plan §7.2, D85) and the
 * InMemoryStore ↔ PgStore equivalence property.
 *
 * The same contract suite runs against BOTH store implementations — the
 * production Drizzle/pg store (on its stubbed query interface) and the
 * test-only in-memory store — pinning "semantics must match exactly" (D85).
 * The random-operation property uses InMemoryStore as the oracle and asserts
 * that PgStore is observationally identical after every operation sequence.
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { InMemoryStore } from "../../src/store/in-memory";
import { PgStore } from "../../src/store/pg";
import type {
  ChatRecord,
  DraftKey,
  DraftRecord,
  SourceMessageRecord,
  Store,
  ThreadRecord,
  UserRecord,
} from "../../src/store/types";
import { StubPgPool, stubDatabase } from "./pg-test-stub";
import {
  chatArb,
  chatIdArb,
  draftArb,
  draftKeyArb,
  sourceMessageArb,
  threadArb,
  userArb,
  userIdArb,
  messageIdArb,
} from "./store-arbitraries";

const CHAT = {
  chatId: -1001,
  type: "supergroup",
  title: "Source Chat",
  username: "src",
  isForum: false,
  source: true,
  threads: false,
};
const THREADS_CHAT = { chatId: -1002, type: "supergroup", title: "Threads", isForum: false, source: false, threads: true };
const DRAFT = {
  threadsChatId: -1002,
  authorId: 7,
  openedAt: 1_700_000_000_000,
  batch: [{ forwardId: 5, originChatId: -1001, originDate: 1_700_000_000, senderId: 7, content: { kind: "text" as const, text: "hi" } }],
  pickedChatId: null,
  preselectedChatId: -1001,
};

const factories: Array<{ name: string; create: () => Store }> = [
  { name: "InMemoryStore", create: () => new InMemoryStore() },
  { name: "PgStore", create: () => new PgStore(stubDatabase(new StubPgPool())) },
];

describe.each(factories)("store contract — $name", ({ create }) => {
  test("getChat returns a copy; saveChat replaces the whole record", () => {
    const store = create();
    store.saveChat(CHAT);
    const copy = store.getChat(CHAT.chatId)!;
    copy.title = "mutated";
    expect(store.getChat(CHAT.chatId)?.title).toBe("Source Chat");

    store.saveChat({ ...CHAT, title: "Renamed", username: undefined });
    const replaced = store.getChat(CHAT.chatId)!;
    expect(replaced.title).toBe("Renamed");
    expect("username" in replaced && replaced.username !== undefined).toBe(false);
  });

  test("listChats returns copies in first-save order", () => {
    const store = create();
    store.saveChat(CHAT);
    store.saveChat(THREADS_CHAT);
    store.saveChat({ ...CHAT, title: "resaved" });
    const listed = store.listChats();
    expect(listed.map((chat) => chat.chatId)).toEqual([-1001, -1002]);
    listed[0].title = "mutated";
    expect(store.getChat(-1001)?.title).toBe("resaved");
  });

  test("getUser returns undefined for unknown users; saveUser round-trips the locale", () => {
    const store = create();
    expect(store.getUser(42)).toBeUndefined();
    store.saveUser({ userId: 42, locale: "ru" });
    expect(store.getUser(42)).toEqual({ userId: 42, locale: "ru" });
    store.saveUser({ userId: 42 });
    expect(store.getUser(42)).toEqual({ userId: 42 });
  });

  test("getDraft returns a deep copy; saveDraft stores a deep copy", () => {
    const store = create();
    store.saveDraft(DRAFT);
    const copy = store.getDraft({ threadsChatId: -1002, authorId: 7 })!;
    copy.batch[0].content = { kind: "text", text: "mutated" };
    expect(store.getDraft({ threadsChatId: -1002, authorId: 7 })?.batch[0].content).toEqual({ kind: "text", text: "hi" });

    const later = { ...DRAFT, batch: [{ ...DRAFT.batch[0] }] };
    store.saveDraft(later);
    later.batch[0].content = { kind: "text", text: "mutated after save" };
    expect(store.getDraft({ threadsChatId: -1002, authorId: 7 })?.batch[0].content).toEqual({ kind: "text", text: "hi" });
  });

  test("saveDraft replaces the draft; removeDraft is idempotent", () => {
    const store = create();
    const key: DraftKey = { threadsChatId: -1002, authorId: 7 };
    store.saveDraft(DRAFT);
    store.saveDraft({ ...DRAFT, pickedChatId: -1001, pickedAuthorized: true, dialogMessageId: 9 });
    const draft = store.getDraft(key)!;
    expect(draft.pickedChatId).toBe(-1001);
    expect(draft.pickedAuthorized).toBe(true);
    expect(draft.dialogMessageId).toBe(9);
    expect(store.listDrafts()).toHaveLength(1);

    store.removeDraft(key);
    store.removeDraft(key);
    expect(store.getDraft(key)).toBeUndefined();
    expect(store.listDrafts()).toEqual([]);
  });

  test("getThread/listThreads return copies; saveThread replaces", () => {
    const store = create();
    store.saveThread({
      threadId: 10,
      title: "Lunch",
      sourceChatId: -1001,
      threadsChatId: -1002,
      rootMessageId: 10,
      createdBy: 7,
      createdAt: 1_700_000_000_000,
    });
    expect(store.getThread(9)).toBeUndefined();
    const copy = store.getThread(10)!;
    copy.title = "mutated";
    expect(store.getThread(10)?.title).toBe("Lunch");
    store.saveThread({ ...copy, title: "Dinner" });
    expect(store.getThread(10)?.title).toBe("Dinner");
    expect(store.listThreads().map((thread) => thread.threadId)).toEqual([10]);
  });

  test("listThreadMessages preserves save order and drops absent source ids", () => {
    const store = create();
    store.saveThreadMessage(10, 11, "copy", 5);
    store.saveThreadMessage(10, 12, "placeholder");
    store.saveThreadMessage(9, 13, "copy", 6);
    expect(store.listThreadMessages(10)).toEqual([
      { threadId: 10, messageId: 11, kind: "copy", sourceMessageId: 5 },
      { threadId: 10, messageId: 12, kind: "placeholder" },
    ]);
    expect(store.listThreadMessages(9)).toEqual([{ threadId: 9, messageId: 13, kind: "copy", sourceMessageId: 6 }]);
  });

  test("indexSourceMessage replaces by (chatId, messageId); reads return deep copies", () => {
    const store = create();
    const record: SourceMessageRecord = {
      chatId: -1001,
      messageId: 5,
      date: 1_700_000_000,
      senderId: 7,
      content: { kind: "text", text: "hi" },
      messageThreadId: 3,
    };
    store.indexSourceMessage(record);
    store.indexSourceMessage({ ...record, content: { kind: "text", text: "edited" }, threadId: 10 });
    expect(store.getSourceMessage(-1001, 5)).toEqual({
      ...record,
      content: { kind: "text", text: "edited" },
      threadId: 10,
    });
    expect(store.getSourceMessage(-1001, 6)).toBeUndefined();

    const copy = store.getSourceMessage(-1001, 5)!;
    copy.content = { kind: "invoice" };
    expect(store.getSourceMessage(-1001, 5)?.content).toEqual({ kind: "text", text: "edited" });

    store.indexSourceMessage({ ...record, messageId: 6 });
    expect(store.listSourceMessages(-1001).map((r) => r.messageId)).toEqual([5, 6]);
    expect(store.listSourceMessages(-999)).toEqual([]);
  });

  test("ping resolves", async () => {
    await expect(create().ping()).resolves.toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// Equivalence property: random operation sequences, InMemoryStore as oracle
// --------------------------------------------------------------------------

type StoreOp =
  | { kind: "saveChat"; value: ChatRecord }
  | { kind: "saveUser"; value: UserRecord }
  | { kind: "saveDraft"; value: DraftRecord }
  | { kind: "removeDraft"; key: DraftKey }
  | { kind: "saveThread"; value: ThreadRecord }
  | { kind: "saveThreadMessage"; threadId: number; messageId: number; messageKind: string; sourceMessageId?: number }
  | { kind: "indexSourceMessage"; value: SourceMessageRecord };

function applyOp(store: Store, op: StoreOp): void {
  switch (op.kind) {
    case "saveChat":
      store.saveChat(op.value);
      return;
    case "saveUser":
      store.saveUser(op.value);
      return;
    case "saveDraft":
      store.saveDraft(op.value);
      return;
    case "removeDraft":
      store.removeDraft(op.key);
      return;
    case "saveThread":
      store.saveThread(op.value);
      return;
    case "saveThreadMessage":
      store.saveThreadMessage(op.threadId, op.messageId, op.messageKind, op.sourceMessageId);
      return;
    case "indexSourceMessage":
      store.indexSourceMessage(op.value);
      return;
  }
}

const threadMessageArb = fc.record({
  threadId: messageIdArb,
  messageId: messageIdArb,
  messageKind: fc.constantFrom("copy", "placeholder"),
  sourceMessageId: fc.option(messageIdArb, { nil: undefined }),
});

const opArb: fc.Arbitrary<StoreOp> = fc.oneof(
  { weight: 3, arbitrary: chatArb.map((value) => ({ kind: "saveChat" as const, value })) },
  { weight: 2, arbitrary: userArb.map((value) => ({ kind: "saveUser" as const, value })) },
  { weight: 3, arbitrary: draftArb.map((value) => ({ kind: "saveDraft" as const, value })) },
  { weight: 1, arbitrary: draftKeyArb.map((key) => ({ kind: "removeDraft" as const, key })) },
  { weight: 2, arbitrary: threadArb.map((value) => ({ kind: "saveThread" as const, value })) },
  { weight: 2, arbitrary: threadMessageArb.map((value) => ({ kind: "saveThreadMessage" as const, ...value })) },
  { weight: 3, arbitrary: sourceMessageArb.map((value) => ({ kind: "indexSourceMessage" as const, value })) },
);

interface Probes {
  chatIds: number[];
  userIds: number[];
  draftKeys: DraftKey[];
  threadIds: number[];
  sourceKeys: Array<[number, number]>;
  sourceChatIds: number[];
}

function probesOf(ops: StoreOp[]): Probes {
  const chatIds = new Set<number>();
  const userIds = new Set<number>();
  const draftKeys = new Map<string, DraftKey>();
  const threadIds = new Set<number>();
  const sourceKeys = new Map<string, [number, number]>();
  const sourceChatIds = new Set<number>();
  for (const op of ops) {
    switch (op.kind) {
      case "saveChat":
        chatIds.add(op.value.chatId);
        break;
      case "saveUser":
        userIds.add(op.value.userId);
        break;
      case "saveDraft":
        chatIds.add(op.value.threadsChatId);
        draftKeys.set(`${op.value.threadsChatId}:${op.value.authorId}`, op.value);
        break;
      case "removeDraft":
        draftKeys.set(`${op.key.threadsChatId}:${op.key.authorId}`, op.key);
        break;
      case "saveThread":
        threadIds.add(op.value.threadId);
        break;
      case "saveThreadMessage":
        threadIds.add(op.threadId);
        break;
      case "indexSourceMessage":
        sourceChatIds.add(op.value.chatId);
        sourceKeys.set(`${op.value.chatId}:${op.value.messageId}`, [op.value.chatId, op.value.messageId]);
        break;
    }
  }
  return {
    chatIds: [...chatIds],
    userIds: [...userIds],
    draftKeys: [...draftKeys.values()],
    threadIds: [...threadIds],
    sourceKeys: [...sourceKeys.values()],
    sourceChatIds: [...sourceChatIds],
  };
}

function snapshot(store: Store, probes: Probes): unknown {
  return {
    chats: probes.chatIds.map((id) => store.getChat(id)),
    listChats: store.listChats(),
    users: probes.userIds.map((id) => store.getUser(id)),
    drafts: probes.draftKeys.map((key) => store.getDraft(key)),
    listDrafts: store.listDrafts(),
    threads: probes.threadIds.map((id) => store.getThread(id)),
    listThreads: store.listThreads(),
    threadMessages: probes.threadIds.map((id) => store.listThreadMessages(id)),
    sourceMessages: probes.sourceKeys.map(([chatId, messageId]) => store.getSourceMessage(chatId, messageId)),
    sourceLists: probes.sourceChatIds.map((chatId) => store.listSourceMessages(chatId)),
  };
}

describe("store equivalence — PgStore behaves exactly like InMemoryStore (D85)", () => {
  test("random operation sequences yield identical observable state (seed fixed)", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 30 }), (ops) => {
        const oracle = new InMemoryStore();
        const subject = new PgStore(stubDatabase(new StubPgPool()));
        for (const op of ops) {
          applyOp(oracle, op);
          applyOp(subject, op);
        }
        // Reads are cache-synchronous in both stores: equal or not, right here.
        expect(snapshot(subject, probesOf(ops))).toEqual(snapshot(oracle, probesOf(ops)));
        return true;
      }),
      { seed: 20261029, numRuns: 100 },
    );
  });
});
