/**
 * fast-check arbitraries for `src/store` records (shared by the pg-store
 * round-trip properties and the InMemoryStore↔PgStore equivalence property).
 * Edges covered: empty/unicode strings, negative Telegram ids, explicit
 * `null` vs absent optional fields, zero and boundary timestamps.
 */
import fc from "fast-check";
import type {
  ChatRecord,
  ContentRecord,
  DraftKey,
  DraftMessageRecord,
  DraftRecord,
  SourceMessageRecord,
  ThreadRecord,
  UserRecord,
} from "../../src/store/types";

/** Telegram chat ids: negative groups/supergroups and positive users/chats. */
export const chatIdArb = fc.integer({ min: -1005, max: 1005 });
export const userIdArb = fc.integer({ min: -1005, max: 1005 });
export const messageIdArb = fc.integer({ min: 1, max: 8 });
/** Millisecond timestamps inside the safe `Date` range (no real clock). */
export const timestampArb = fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 });
/** Second-based Telegram dates. */
export const dateSecondsArb = fc.integer({ min: 0, max: 2_000_000_000 });

const shortString = fc.string({ maxLength: 20 });

export const contentArb: fc.Arbitrary<ContentRecord> = fc.oneof(
  fc.record({ kind: fc.constant("text" as const), text: shortString }),
  fc.record({
    kind: fc.constant("photo" as const),
    fileId: shortString,
    caption: fc.option(shortString, { nil: undefined }),
  }),
  fc.record({ kind: fc.constant("poll" as const), question: shortString }),
  fc.record({ kind: fc.constant("service" as const), serviceEventType: shortString }),
  fc.record({ kind: fc.constant("invoice" as const) }),
  fc.record({ kind: fc.constant("other" as const), contentType: shortString }),
);

export const chatArb: fc.Arbitrary<ChatRecord> = fc.record({
  chatId: chatIdArb,
  type: fc.constantFrom("supergroup", "group", "private", "channel"),
  title: shortString,
  username: fc.option(shortString, { nil: undefined }),
  isForum: fc.boolean(),
  source: fc.boolean(),
  threads: fc.boolean(),
});

export const userArb: fc.Arbitrary<UserRecord> = fc.record({
  userId: userIdArb,
  locale: fc.option(fc.constantFrom("en", "ru"), { nil: undefined }),
});

export const draftMessageArb: fc.Arbitrary<DraftMessageRecord> = fc.record({
  forwardId: messageIdArb,
  originChatId: fc.option(chatIdArb, { nil: null }),
  originDate: dateSecondsArb,
  senderId: fc.option(userIdArb, { nil: null }),
  content: contentArb,
  mediaGroupId: fc.option(shortString, { nil: undefined }),
});

export const draftArb: fc.Arbitrary<DraftRecord> = fc.record({
  threadsChatId: chatIdArb,
  authorId: userIdArb,
  openedAt: timestampArb,
  batch: fc.array(draftMessageArb, { maxLength: 5 }),
  pickedChatId: fc.option(chatIdArb, { nil: null }),
  preselectedChatId: fc.option(chatIdArb, { nil: null }),
  pickedAuthorized: fc.option(fc.boolean(), { nil: undefined }),
  dialogMessageId: fc.option(messageIdArb, { nil: undefined }),
});

export const draftKeyArb: fc.Arbitrary<DraftKey> = fc.record({
  threadsChatId: chatIdArb,
  authorId: userIdArb,
});

export const threadArb: fc.Arbitrary<ThreadRecord> = fc.record({
  threadId: messageIdArb,
  title: shortString,
  sourceChatId: chatIdArb,
  threadsChatId: chatIdArb,
  rootMessageId: messageIdArb,
  messageThreadId: fc.option(messageIdArb, { nil: undefined }),
  createdBy: userIdArb,
  createdAt: timestampArb,
});

export const sourceMessageArb: fc.Arbitrary<SourceMessageRecord> = fc.record({
  chatId: chatIdArb,
  messageId: messageIdArb,
  date: dateSecondsArb,
  senderId: fc.option(userIdArb, { nil: null }),
  content: contentArb,
  messageThreadId: fc.option(messageIdArb, { nil: undefined }),
  threadId: fc.option(messageIdArb, { nil: undefined }),
});
