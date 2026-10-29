/**
 * Batch entities and truncation (D16/D31/D41/D64, R20/R26): an album
 * (`media_group_id`) is one entity; entities are taken in forward order while
 * the message budget holds; a straddling album is never split.
 */
import type { DraftMessageRecord } from "../store/types.js";

export type Entity = DraftMessageRecord[];

/**
 * D68 (final)/D84: does `incoming` come from a different source chat than
 * the open draft batch? True when the incoming message names a chat, the batch
 * already names at least one chat, and none of the batch messages is from the
 * incoming chat. A hidden-sender forward (no chat named) never counts as
 * different.
 */
export function isDifferentSourceChat(
  batch: ReadonlyArray<Pick<DraftMessageRecord, "originChatId">>,
  incomingChatId: number | null,
): boolean {
  if (incomingChatId === null) return false;
  let batchNamesChat = false;
  for (const msg of batch) {
    if (msg.originChatId === null) continue;
    if (msg.originChatId === incomingChatId) return false;
    batchNamesChat = true;
  }
  return batchNamesChat;
}

/** Groups the batch into transfer entities (album = one entity, singles alone). */
export function groupEntities(batch: DraftMessageRecord[]): Entity[] {
  const entities: Entity[] = [];
  const albumIndex = new Map<string, Entity>();
  for (const msg of batch) {
    if (msg.mediaGroupId !== undefined && msg.mediaGroupId !== "") {
      const existing = albumIndex.get(msg.mediaGroupId);
      if (existing) {
        existing.push(msg);
        continue;
      }
      const entity: Entity = [msg];
      albumIndex.set(msg.mediaGroupId, entity);
      entities.push(entity);
      continue;
    }
    entities.push([msg]);
  }
  for (const entity of entities) {
    if (entity.length > 1 && entity[0].mediaGroupId !== undefined) {
      entity.sort((a, b) => a.originDate - b.originDate || a.forwardId - b.forwardId);
    }
  }
  return entities;
}

export interface TruncationResult {
  kept: Entity[];
  dropped: Entity[];
  keptMessages: number;
  droppedMessages: number;
}

/**
 * D64: the kept set is the longest prefix of whole entities in forward order
 * whose message count is <= limit; a straddling entity is dropped with the rest.
 */
export function truncateEntities(entities: Entity[], limit: number): TruncationResult {
  const kept: Entity[] = [];
  const dropped: Entity[] = [];
  let keptMessages = 0;
  let overflow = false;
  for (const entity of entities) {
    if (!overflow && keptMessages + entity.length <= limit) {
      kept.push(entity);
      keptMessages += entity.length;
    } else {
      overflow = true;
      dropped.push(entity);
    }
  }
  return {
    kept,
    dropped,
    keptMessages,
    droppedMessages: dropped.reduce((n, entity) => n + entity.length, 0),
  };
}
