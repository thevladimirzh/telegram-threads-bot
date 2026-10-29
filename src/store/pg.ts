/**
 * Drizzle/pg-backed `Store` (D85): the production repository over PostgreSQL.
 *
 * The `Store` contract (plan §7.2) is synchronous, so reads are served from an
 * in-memory cache with exactly the copy semantics of `InMemoryStore`; the
 * cache is hydrated from the database once at boot (`load()`) and every
 * mutation is mirrored to PostgreSQL through a serialized write queue
 * (schema-typed Drizzle queries over the `pg` driver — see `schema.ts`).
 * `ping()` probes the database itself and backs the `/ready` endpoint (D61).
 *
 * Tests never touch a real database (D25): `tests/unit/pg-store.test.ts` runs
 * this module against a stubbed query interface (a fake pg pool installed as
 * the Drizzle driver) and `tests/unit/store-contract.test.ts` proves the
 * observable semantics identical to `InMemoryStore`.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  chats,
  drafts,
  sourceMessages,
  threadMessages,
  threads,
  users,
} from "./schema.js";
import type {
  ChatRecord,
  DraftKey,
  DraftRecord,
  SourceMessageRecord,
  Store,
  ThreadRecord,
  UserRecord,
} from "./types.js";

/** Fully populated database row shapes (post column mapping). */
export type ChatRow = typeof chats.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type DraftRow = typeof drafts.$inferSelect;
export type ThreadRow = typeof threads.$inferSelect;
export type ThreadMessageRow = typeof threadMessages.$inferSelect;
export type SourceMessageRow = typeof sourceMessages.$inferSelect;

/** The `listThreadMessages`/`saveThreadMessage` row shape (Store contract). */
export interface ThreadMessageRecord {
  threadId: number;
  messageId: number;
  kind: string;
  sourceMessageId?: number;
}

export interface PgStoreLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface PgStoreOptions {
  logger?: PgStoreLogger;
}

// --------------------------- row mapping --------------------------------

export function chatToRow(chat: ChatRecord): ChatRow {
  return {
    chatId: BigInt(chat.chatId),
    type: chat.type,
    title: chat.title,
    username: chat.username ?? null,
    isForum: chat.isForum ? 1 : 0,
    isSource: chat.source ? 1 : 0,
    isThreads: chat.threads ? 1 : 0,
  };
}

export function chatFromRow(row: ChatRow): ChatRecord {
  return {
    chatId: Number(row.chatId),
    type: row.type,
    title: row.title,
    ...(row.username !== null ? { username: row.username } : {}),
    isForum: row.isForum !== 0,
    source: row.isSource !== 0,
    threads: row.isThreads !== 0,
  };
}

export function userToRow(user: UserRecord): UserRow {
  return {
    userId: BigInt(user.userId),
    locale: user.locale ?? null,
  };
}

export function userFromRow(row: UserRow): UserRecord {
  return {
    userId: Number(row.userId),
    ...(row.locale !== null ? { locale: row.locale } : {}),
  };
}

export function draftToRow(draft: DraftRecord): DraftRow {
  return {
    threadsChatId: BigInt(draft.threadsChatId),
    authorId: BigInt(draft.authorId),
    openedAt: new Date(draft.openedAt),
    pickedChatId: draft.pickedChatId === null ? null : BigInt(draft.pickedChatId),
    preselectedChatId: draft.preselectedChatId === null ? null : BigInt(draft.preselectedChatId),
    pickedAuthorized: draft.pickedAuthorized === undefined ? null : draft.pickedAuthorized ? 1 : 0,
    dialogMessageId: draft.dialogMessageId === undefined ? null : BigInt(draft.dialogMessageId),
    batch: draft.batch,
  };
}

export function draftFromRow(row: DraftRow): DraftRecord {
  return {
    threadsChatId: Number(row.threadsChatId),
    authorId: Number(row.authorId),
    openedAt: row.openedAt.getTime(),
    batch: row.batch as DraftRecord["batch"],
    pickedChatId: row.pickedChatId === null ? null : Number(row.pickedChatId),
    preselectedChatId: row.preselectedChatId === null ? null : Number(row.preselectedChatId),
    ...(row.pickedAuthorized !== null ? { pickedAuthorized: row.pickedAuthorized !== 0 } : {}),
    ...(row.dialogMessageId !== null ? { dialogMessageId: Number(row.dialogMessageId) } : {}),
  };
}

export function threadToRow(thread: ThreadRecord): ThreadRow {
  return {
    threadId: BigInt(thread.threadId),
    title: thread.title,
    sourceChatId: BigInt(thread.sourceChatId),
    threadsChatId: BigInt(thread.threadsChatId),
    rootMessageId: BigInt(thread.rootMessageId),
    messageThreadId: thread.messageThreadId === undefined ? null : BigInt(thread.messageThreadId),
    createdBy: BigInt(thread.createdBy),
    createdAt: new Date(thread.createdAt),
  };
}

export function threadFromRow(row: ThreadRow): ThreadRecord {
  return {
    threadId: Number(row.threadId),
    title: row.title,
    sourceChatId: Number(row.sourceChatId),
    threadsChatId: Number(row.threadsChatId),
    rootMessageId: Number(row.rootMessageId),
    ...(row.messageThreadId !== null ? { messageThreadId: Number(row.messageThreadId) } : {}),
    createdBy: Number(row.createdBy),
    createdAt: row.createdAt.getTime(),
  };
}

export function threadMessageToRow(record: ThreadMessageRecord): ThreadMessageRow {
  return {
    threadId: BigInt(record.threadId),
    messageId: BigInt(record.messageId),
    kind: record.kind,
    sourceMessageId: record.sourceMessageId === undefined ? null : BigInt(record.sourceMessageId),
  };
}

export function threadMessageFromRow(row: ThreadMessageRow): ThreadMessageRecord {
  return {
    threadId: Number(row.threadId),
    messageId: Number(row.messageId),
    kind: row.kind,
    ...(row.sourceMessageId !== null ? { sourceMessageId: Number(row.sourceMessageId) } : {}),
  };
}

export function sourceMessageToRow(record: SourceMessageRecord): SourceMessageRow {
  return {
    chatId: BigInt(record.chatId),
    messageId: BigInt(record.messageId),
    date: BigInt(record.date),
    senderId: record.senderId === null ? null : BigInt(record.senderId),
    content: record.content,
    messageThreadId: record.messageThreadId === undefined ? null : BigInt(record.messageThreadId),
    threadId: record.threadId === undefined ? null : BigInt(record.threadId),
  };
}

export function sourceMessageFromRow(row: SourceMessageRow): SourceMessageRecord {
  return {
    chatId: Number(row.chatId),
    messageId: Number(row.messageId),
    date: Number(row.date),
    senderId: row.senderId === null ? null : Number(row.senderId),
    content: row.content as SourceMessageRecord["content"],
    ...(row.messageThreadId !== null ? { messageThreadId: Number(row.messageThreadId) } : {}),
    ...(row.threadId !== null ? { threadId: Number(row.threadId) } : {}),
  };
}

// ----------------------------- the store --------------------------------

export class PgStore implements Store {
  private readonly db: NodePgDatabase;
  private readonly logger: PgStoreLogger | undefined;

  // The synchronous cache — same map shapes and copy semantics as
  // InMemoryStore (proved by tests/unit/store-contract.test.ts).
  private readonly chats = new Map<number, ChatRecord>();
  private readonly users = new Map<number, UserRecord>();
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly threads = new Map<number, ThreadRecord>();
  private readonly threadMessages: ThreadMessageRecord[] = [];
  private readonly sourceMessages = new Map<string, SourceMessageRecord>();
  /** Serialized write queue: mutations reach PostgreSQL in save order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(db: NodePgDatabase, options: PgStoreOptions = {}) {
    this.db = db;
    this.logger = options.logger;
  }

  /**
   * Hydrates the cache from all six tables (call once at boot, before the bot
   * serves updates). Deterministic order: primary-key ascending.
   */
  async load(): Promise<void> {
    this.chats.clear();
    this.users.clear();
    this.drafts.clear();
    this.threads.clear();
    this.threadMessages.length = 0;
    this.sourceMessages.clear();

    for (const row of await this.db.select().from(chats).orderBy(asc(chats.chatId)).execute()) {
      const chat = chatFromRow(row);
      this.chats.set(chat.chatId, chat);
    }
    for (const row of await this.db.select().from(users).orderBy(asc(users.userId)).execute()) {
      const user = userFromRow(row);
      this.users.set(user.userId, user);
    }
    for (const row of await this.db.select().from(drafts).orderBy(asc(drafts.threadsChatId), asc(drafts.authorId)).execute()) {
      const draft = draftFromRow(row);
      this.drafts.set(PgStore.draftKey(draft), draft);
    }
    for (const row of await this.db.select().from(threads).orderBy(asc(threads.threadId)).execute()) {
      const thread = threadFromRow(row);
      this.threads.set(thread.threadId, thread);
    }
    for (const row of await this.db
      .select()
      .from(threadMessages)
      .orderBy(asc(threadMessages.threadId), asc(threadMessages.messageId))
      .execute()) {
      this.threadMessages.push(threadMessageFromRow(row));
    }
    for (const row of await this.db
      .select()
      .from(sourceMessages)
      .orderBy(asc(sourceMessages.chatId), asc(sourceMessages.messageId))
      .execute()) {
      const record = sourceMessageFromRow(row);
      this.sourceMessages.set(PgStore.sourceKey(record.chatId, record.messageId), record);
    }
  }

  /** Awaits all queued persistence writes (graceful shutdown / tests). */
  async flush(): Promise<void> {
    await this.queue;
  }

  // ------------------------------ chats ---------------------------------

  getChat(chatId: number): ChatRecord | undefined {
    const found = this.chats.get(chatId);
    return found ? { ...found } : undefined;
  }

  listChats(): ChatRecord[] {
    return [...this.chats.values()].map((chat) => ({ ...chat }));
  }

  saveChat(chat: ChatRecord): void {
    this.chats.set(chat.chatId, { ...chat });
    const row = chatToRow(chat);
    this.enqueue(() => this.db.insert(chats).values(row).onConflictDoUpdate({ target: chats.chatId, set: row }).execute());
  }

  // ------------------------------ users ---------------------------------

  getUser(userId: number): UserRecord | undefined {
    const found = this.users.get(userId);
    return found ? { ...found } : undefined;
  }

  saveUser(user: UserRecord): void {
    this.users.set(user.userId, { ...user });
    const row = userToRow(user);
    this.enqueue(() => this.db.insert(users).values(row).onConflictDoUpdate({ target: users.userId, set: row }).execute());
  }

  // ----------------------------- drafts ---------------------------------

  getDraft(key: DraftKey): DraftRecord | undefined {
    const found = this.drafts.get(PgStore.draftKey(key));
    return found ? structuredClone(found) : undefined;
  }

  listDrafts(): DraftRecord[] {
    return [...this.drafts.values()].map((draft) => structuredClone(draft));
  }

  saveDraft(draft: DraftRecord): void {
    const stored = structuredClone(draft);
    this.drafts.set(PgStore.draftKey(draft), stored);
    const row = draftToRow(stored);
    this.enqueue(() =>
      this.db
        .insert(drafts)
        .values(row)
        .onConflictDoUpdate({ target: [drafts.threadsChatId, drafts.authorId], set: row })
        .execute(),
    );
  }

  removeDraft(key: DraftKey): void {
    this.drafts.delete(PgStore.draftKey(key));
    this.enqueue(() =>
      this.db
        .delete(drafts)
        .where(and(eq(drafts.threadsChatId, BigInt(key.threadsChatId)), eq(drafts.authorId, BigInt(key.authorId))))
        .execute(),
    );
  }

  // ----------------------------- threads --------------------------------

  getThread(threadId: number): ThreadRecord | undefined {
    const found = this.threads.get(threadId);
    return found ? { ...found } : undefined;
  }

  listThreads(): ThreadRecord[] {
    return [...this.threads.values()].map((thread) => ({ ...thread }));
  }

  saveThread(thread: ThreadRecord): void {
    this.threads.set(thread.threadId, { ...thread });
    const row = threadToRow(thread);
    this.enqueue(() =>
      this.db.insert(threads).values(row).onConflictDoUpdate({ target: threads.threadId, set: row }).execute(),
    );
  }

  saveThreadMessage(threadId: number, messageId: number, kind: string, sourceMessageId?: number): void {
    this.threadMessages.push({
      threadId,
      messageId,
      kind,
      ...(sourceMessageId !== undefined ? { sourceMessageId } : {}),
    });
    const row = threadMessageToRow({ threadId, messageId, kind, ...(sourceMessageId !== undefined ? { sourceMessageId } : {}) });
    this.enqueue(() => this.db.insert(threadMessages).values(row).execute());
  }

  listThreadMessages(threadId: number): ThreadMessageRecord[] {
    return this.threadMessages.filter((row) => row.threadId === threadId).map((row) => ({ ...row }));
  }

  // -------------------------- source messages ---------------------------

  indexSourceMessage(record: SourceMessageRecord): void {
    const stored = structuredClone(record);
    this.sourceMessages.set(PgStore.sourceKey(record.chatId, record.messageId), stored);
    const row = sourceMessageToRow(stored);
    this.enqueue(() =>
      this.db
        .insert(sourceMessages)
        .values(row)
        .onConflictDoUpdate({ target: [sourceMessages.chatId, sourceMessages.messageId], set: row })
        .execute(),
    );
  }

  getSourceMessage(chatId: number, messageId: number): SourceMessageRecord | undefined {
    const found = this.sourceMessages.get(PgStore.sourceKey(chatId, messageId));
    return found ? structuredClone(found) : undefined;
  }

  listSourceMessages(chatId: number): SourceMessageRecord[] {
    return [...this.sourceMessages.values()]
      .filter((record) => record.chatId === chatId)
      .map((record) => structuredClone(record));
  }

  /** Readiness probe (D61/AC9): the database must answer. */
  async ping(): Promise<void> {
    await this.db.execute(sql`select 1`);
  }

  // ------------------------------ internals -----------------------------

  private static draftKey(key: DraftKey): string {
    return `${key.threadsChatId}:${key.authorId}`;
  }

  private static sourceKey(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  /**
   * Queues a persistence write on the serialized chain. Failures are logged
   * (never thrown): the cache stays authoritative for reads and `ping()` is
   * the authoritative health signal (D61).
   */
  private enqueue(work: () => Promise<unknown>): void {
    this.queue = this.queue.then(async () => {
      try {
        await work();
      } catch (error) {
        this.logger?.warn({
          event: "store_persist_failed",
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    });
  }
}
