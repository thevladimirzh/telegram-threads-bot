/**
 * Deletion helpers (D24/D74/D78, R27/R28/R29): `deleteMessages` chunking
 * (<= 100 ids per call, Telegram's API limit), per-message failure classes for
 * the AC5 report and `retry_after` detection.
 */
export const DELETE_CHUNK_SIZE = 100;

export type DeleteClass = "deleted" | "not_found" | "forbidden" | "failed";

export function chunkIds(ids: number[], size: number = DELETE_CHUNK_SIZE): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

interface TelegramErrorLike {
  error_code?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

/**
 * Maps a Telegram deletion error to the D74 report class (D83): the exact
 * Telegram error "message to delete not found" -> `not_found`, 403 ->
 * `forbidden`, any other error -> `failed`. The class is keyed on the error
 * identity — a generic "not found" (e.g. "chat not found") is `failed`.
 */
export function classifyDeleteError(error: unknown): DeleteClass {
  const err = error as TelegramErrorLike;
  const code = typeof err?.error_code === "number" ? err.error_code : undefined;
  const description = typeof err?.description === "string" ? err.description.toLowerCase() : "";
  if (code === 403) return "forbidden";
  if (description.includes("message to delete not found")) return "not_found";
  return "failed";
}

/** D24/D78: the `retry_after` delay in milliseconds, when the error carries one. */
export function retryAfterMs(error: unknown): number | undefined {
  const err = error as TelegramErrorLike;
  const retryAfter = err?.parameters?.retry_after;
  if (typeof retryAfter === "number" && retryAfter > 0) return retryAfter * 1000;
  return undefined;
}
