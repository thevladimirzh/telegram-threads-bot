/**
 * In-memory Store implementation (plan §7.2). Zero constructor arguments.
 * Used by all tests; there is no real database access anywhere (D25).
 */
import type {
  ChatRecord,
  DraftKey,
  DraftRecord,
  SourceMessageRecord,
  Store,
  ThreadRecord,
  UserRecord,
} from "./types.js";

interface ThreadMessageRow {
  threadId: number;
  messageId: number;
  kind: string;
  sourceMessageId?: number;
}

export class InMemoryStore implements Store {
  private readonly chats = new Map<number, ChatRecord>();
  private readonly users = new Map<number, UserRecord>();
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly threads = new Map<number, ThreadRecord>();
  private readonly threadMessages: ThreadMessageRow[] = [];
  private readonly sourceMessages = new Map<string, SourceMessageRecord>();

  private static draftKey(key: DraftKey): string {
    return `${key.threadsChatId}:${key.authorId}`;
  }

  private static sourceKey(chatId: number, messageId: number): string {
    return `${chatId}:${messageId}`;
  }

  getChat(chatId: number): ChatRecord | undefined {
    const found = this.chats.get(chatId);
    return found ? { ...found } : undefined;
  }

  listChats(): ChatRecord[] {
    return [...this.chats.values()].map((chat) => ({ ...chat }));
  }

  saveChat(chat: ChatRecord): void {
    this.chats.set(chat.chatId, { ...chat });
  }

  getUser(userId: number): UserRecord | undefined {
    const found = this.users.get(userId);
    return found ? { ...found } : undefined;
  }

  saveUser(user: UserRecord): void {
    this.users.set(user.userId, { ...user });
  }

  getDraft(key: DraftKey): DraftRecord | undefined {
    const found = this.drafts.get(InMemoryStore.draftKey(key));
    return found ? structuredClone(found) : undefined;
  }

  listDrafts(): DraftRecord[] {
    return [...this.drafts.values()].map((draft) => structuredClone(draft));
  }

  saveDraft(draft: DraftRecord): void {
    this.drafts.set(InMemoryStore.draftKey(draft), structuredClone(draft));
  }

  removeDraft(key: DraftKey): void {
    this.drafts.delete(InMemoryStore.draftKey(key));
  }

  getThread(threadId: number): ThreadRecord | undefined {
    const found = this.threads.get(threadId);
    return found ? { ...found } : undefined;
  }

  listThreads(): ThreadRecord[] {
    return [...this.threads.values()].map((thread) => ({ ...thread }));
  }

  saveThread(thread: ThreadRecord): void {
    this.threads.set(thread.threadId, { ...thread });
  }

  saveThreadMessage(threadId: number, messageId: number, kind: string, sourceMessageId?: number): void {
    this.threadMessages.push({ threadId, messageId, kind, ...(sourceMessageId !== undefined ? { sourceMessageId } : {}) });
  }

  listThreadMessages(threadId: number): ThreadMessageRow[] {
    return this.threadMessages.filter((row) => row.threadId === threadId).map((row) => ({ ...row }));
  }

  indexSourceMessage(record: SourceMessageRecord): void {
    this.sourceMessages.set(InMemoryStore.sourceKey(record.chatId, record.messageId), structuredClone(record));
  }

  getSourceMessage(chatId: number, messageId: number): SourceMessageRecord | undefined {
    const found = this.sourceMessages.get(InMemoryStore.sourceKey(chatId, messageId));
    return found ? structuredClone(found) : undefined;
  }

  listSourceMessages(chatId: number): SourceMessageRecord[] {
    return [...this.sourceMessages.values()]
      .filter((record) => record.chatId === chatId)
      .map((record) => structuredClone(record));
  }

  async ping(): Promise<void> {
    // In-memory store is always reachable.
  }
}
