/**
 * Drizzle schema (plan §2.4): `chats`, `users`, `drafts`, `threads`,
 * `thread_messages`, `source_messages`. Compile-checked only — tests never
 * talk to a real database (D25).
 */
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const chats = pgTable(
  "chats",
  {
    chatId: bigint("chat_id", { mode: "bigint" }).primaryKey(),
    type: text("type").notNull(),
    title: text("title").notNull(),
    username: text("username"),
    isForum: integer("is_forum").notNull().default(0),
    isSource: integer("is_source").notNull().default(0),
    isThreads: integer("is_threads").notNull().default(0),
  },
  (table) => [index("chats_source_idx").on(table.isSource)],
);

export const users = pgTable("users", {
  userId: bigint("user_id", { mode: "bigint" }).primaryKey(),
  locale: text("locale"),
});

export const drafts = pgTable(
  "drafts",
  {
    threadsChatId: bigint("threads_chat_id", { mode: "bigint" }).notNull(),
    authorId: bigint("author_id", { mode: "bigint" }).notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    pickedChatId: bigint("picked_chat_id", { mode: "bigint" }),
    preselectedChatId: bigint("preselected_chat_id", { mode: "bigint" }),
    /**
     * DraftRecord.pickedAuthorized (D85): a nullable tri-state — `1`/`0` when
     * the flag was set, `NULL` when the key is absent. Required so that
     * `saveDraft`/`getDraft` round-trip the full record.
     */
    pickedAuthorized: integer("picked_authorized"),
    dialogMessageId: bigint("dialog_message_id", { mode: "bigint" }),
    batch: jsonb("batch").notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadsChatId, table.authorId] })],
);

export const threads = pgTable("threads", {
  threadId: bigint("thread_id", { mode: "bigint" }).primaryKey(),
  title: text("title").notNull(),
  sourceChatId: bigint("source_chat_id", { mode: "bigint" }).notNull(),
  threadsChatId: bigint("threads_chat_id", { mode: "bigint" }).notNull(),
  rootMessageId: bigint("root_message_id", { mode: "bigint" }).notNull(),
  messageThreadId: bigint("message_thread_id", { mode: "bigint" }),
  createdBy: bigint("created_by", { mode: "bigint" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const threadMessages = pgTable(
  "thread_messages",
  {
    threadId: bigint("thread_id", { mode: "bigint" }).notNull(),
    messageId: bigint("message_id", { mode: "bigint" }).notNull(),
    kind: text("kind").notNull(),
    sourceMessageId: bigint("source_message_id", { mode: "bigint" }),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.messageId] })],
);

export const sourceMessages = pgTable(
  "source_messages",
  {
    chatId: bigint("chat_id", { mode: "bigint" }).notNull(),
    messageId: bigint("message_id", { mode: "bigint" }).notNull(),
    date: bigint("date", { mode: "bigint" }).notNull(),
    senderId: bigint("sender_id", { mode: "bigint" }),
    content: jsonb("content").notNull(),
    messageThreadId: bigint("message_thread_id", { mode: "bigint" }),
    threadId: bigint("thread_id", { mode: "bigint" }),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.messageId] }),
    index("source_messages_match_idx").on(table.chatId, table.date, table.senderId),
  ],
);
