/**
 * Repository contract (plan §2.4/§7.2). Tests never talk to a real database:
 * `InMemoryStore` implements this interface and the Drizzle schema in
 * `src/store/schema.ts` is compile-checked only (D25).
 *
 * Mutation methods use write verbs in their names (`save*`, `remove*`,
 * `index*`, `link*`) so test harnesses can observe state changes; reads use
 * `get*`/`list*`/`find*`.
 */

export interface ChatRecord {
  chatId: number;
  type: string;
  title: string;
  username?: string;
  isForum: boolean;
  /** Connected as a source chat (D11). */
  source: boolean;
  /** Connected as THE threads chat (D33: at most one). */
  threads: boolean;
}

export interface UserRecord {
  userId: number;
  /** Manual locale override from /settings (D19); undefined = auto by language_code. */
  locale?: string;
}

export interface DraftKey {
  threadsChatId: number;
  authorId: number;
}

export interface DraftMessageRecord {
  /** message_id of the forwarded copy in the threads chat. */
  forwardId: number;
  /** forward_origin.chat/sender_chat id when the origin names a chat. */
  originChatId: number | null;
  /** forward_origin.date (the original's send date). */
  originDate: number;
  /** forward_origin.sender_user/sender_chat id. */
  senderId: number | null;
  /** Content signature used by the matcher and the placeholder logic. */
  content: ContentRecord;
  /** Album id when the message is part of a media group. */
  mediaGroupId?: string;
}

export type ContentRecord =
  | { kind: "text"; text: string }
  | { kind: "photo"; fileId: string; caption?: string }
  | { kind: "poll"; question: string }
  | { kind: "service"; serviceEventType: string }
  | { kind: "invoice" }
  | { kind: "other"; contentType: string };

export interface DraftRecord extends DraftKey {
  /** ms timestamp (injected clock) when the first forwarded message arrived. */
  openedAt: number;
  /** The forwarded batch in forward order. */
  batch: DraftMessageRecord[];
  /** Explicit chat choice from the dialog buttons (D8). */
  pickedChatId: number | null;
  /** Preselected chat from forward_origin (D29/D66). */
  preselectedChatId: number | null;
  /** The picked chat was already authorized (source-chat admin) at pick time. */
  pickedAuthorized?: boolean;
  /** message_id of the dialog prompt in the threads chat. */
  dialogMessageId?: number;
}

export interface ThreadRecord {
  threadId: number;
  title: string;
  sourceChatId: number;
  threadsChatId: number;
  rootMessageId: number;
  /** Forum topic of the announce target (D18/D55). */
  messageThreadId?: number;
  createdBy: number;
  createdAt: number;
}

export interface SourceMessageRecord {
  chatId: number;
  messageId: number;
  date: number;
  senderId: number | null;
  content: ContentRecord;
  /** message_thread_id of the original (forum sources, D18). */
  messageThreadId?: number;
  /** Thread this original was mapped to (D10), when transferred. */
  threadId?: number;
}

export interface Store {
  // chats (connections, D11/D33)
  getChat(chatId: number): ChatRecord | undefined;
  listChats(): ChatRecord[];
  saveChat(chat: ChatRecord): void;

  // users (locale overrides, D19)
  getUser(userId: number): UserRecord | undefined;
  saveUser(user: UserRecord): void;

  // drafts (the transfer dialog state, D17/D43)
  getDraft(key: DraftKey): DraftRecord | undefined;
  listDrafts(): DraftRecord[];
  saveDraft(draft: DraftRecord): void;
  removeDraft(key: DraftKey): void;

  // threads + mapping (D10)
  getThread(threadId: number): ThreadRecord | undefined;
  listThreads(): ThreadRecord[];
  saveThread(thread: ThreadRecord): void;
  saveThreadMessage(threadId: number, messageId: number, kind: string, sourceMessageId?: number): void;
  listThreadMessages(threadId: number): Array<{ threadId: number; messageId: number; kind: string; sourceMessageId?: number }>;

  // source message index (D21/D45)
  indexSourceMessage(record: SourceMessageRecord): void;
  getSourceMessage(chatId: number, messageId: number): SourceMessageRecord | undefined;
  listSourceMessages(chatId: number): SourceMessageRecord[];

  /** readiness probe (D61/AC9) */
  ping(): Promise<void>;
}
