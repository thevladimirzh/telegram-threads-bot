/**
 * Original matcher (D21, R2/R17/R18/R22/R24): a forwarded message is matched to
 * an indexed source message by (forward date == message date, sender, content
 * signature). The match is scoped to one chat and is unique-or-none: on
 * ambiguity nothing is ever deleted (R17).
 */
import type { DraftMessageRecord, SourceMessageRecord } from "../store/types.js";
import { contentSignature } from "./content.js";

export type MatchOutcome =
  | { kind: "unique"; original: SourceMessageRecord }
  | { kind: "ambiguous"; candidates: number[] }
  | { kind: "none" };

/** Second-precision normalization (R22): both sides carry Unix seconds. */
export function normalizeDate(value: number): number {
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}

export function matchOriginal(msg: DraftMessageRecord, index: SourceMessageRecord[]): MatchOutcome {
  const wanted = contentSignature(msg.content);
  const date = normalizeDate(msg.originDate);
  const candidates = index.filter(
    (record) =>
      normalizeDate(record.date) === date &&
      record.senderId === msg.senderId &&
      contentSignature(record.content) === wanted,
  );
  if (candidates.length === 1) return { kind: "unique", original: candidates[0] };
  if (candidates.length > 1) {
    return { kind: "ambiguous", candidates: candidates.map((record) => record.messageId) };
  }
  return { kind: "none" };
}
