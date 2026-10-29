/**
 * Content handling: signatures for the matcher (D21), transferability and the
 * exact placeholder format (D27/D59). Placeholder type tokens are fixed ASCII
 * and never localized; the summary part is the raw Telegram value.
 */
import type { ContentRecord } from "../store/types.js";

const COPYABLE_FIELDS = [
  "text",
  "photo",
  "video",
  "document",
  "audio",
  "animation",
  "sticker",
  "voice",
  "video_note",
  "contact",
  "location",
  "venue",
] as const;

/** Derives the content descriptor from a raw Telegram message. */
export function messageContent(msg: Record<string, unknown>): ContentRecord {
  if (typeof msg.text === "string") return { kind: "text", text: msg.text };
  if (typeof msg.caption === "string" && !hasCopyablePayload(msg)) {
    // A caption without any payload behaves like plain text.
    return { kind: "text", text: msg.caption };
  }
  const poll = msg.poll as { question?: unknown } | undefined;
  if (poll && typeof poll.question === "string") return { kind: "poll", question: poll.question };
  if (typeof msg.service_event_type === "string") {
    return { kind: "service", serviceEventType: msg.service_event_type };
  }
  if (msg.invoice !== undefined) return { kind: "invoice" };
  if (hasCopyablePayload(msg)) {
    const field = COPYABLE_FIELDS.find((name) => msg[name] !== undefined) ?? "document";
    const fileId = extractFileId(msg[field]);
    const caption = typeof msg.caption === "string" ? msg.caption : undefined;
    return { kind: "photo", fileId: `${field}:${fileId}`, ...(caption !== undefined ? { caption } : {}) };
  }
  return { kind: "other", contentType: detectContentType(msg) };
}

function hasCopyablePayload(msg: Record<string, unknown>): boolean {
  return COPYABLE_FIELDS.some((name) => msg[name] !== undefined);
}

function extractFileId(value: unknown): string {
  if (Array.isArray(value)) {
    const first = value[0] as Record<string, unknown> | undefined;
    return String(first?.file_id ?? "");
  }
  if (value && typeof value === "object") {
    return String((value as Record<string, unknown>).file_id ?? "");
  }
  return String(value ?? "");
}

function detectContentType(msg: Record<string, unknown>): string {
  const known = [
    "game",
    "dice",
    "poll",
    "invoice",
    "story",
    "paid_media",
    "write_access_allowed",
    "boost_added",
    "chat_shared",
    "users_shared",
  ];
  for (const name of known) {
    if (msg[name] !== undefined) return name;
  }
  if (msg.service_event_type !== undefined) return "service";
  return "unknown";
}

/** Stable signature used by the matcher (D21: date + sender + content hash). */
export function contentSignature(content: ContentRecord): string {
  switch (content.kind) {
    case "text":
      return `text:${content.text}`;
    case "photo":
      return `photo:${content.fileId}:${content.caption ?? ""}`;
    case "poll":
      return `poll:${content.question}`;
    case "service":
      return `service:${content.serviceEventType}`;
    case "invoice":
      return "invoice";
    case "other":
      return `other:${content.contentType}`;
  }
}

/** D59: polls, service messages and other non-copyable types get placeholders. */
export function isTransferable(content: ContentRecord): boolean {
  return content.kind === "text" || content.kind === "photo";
}

/** D27 (exact): `[poll] {question}`, `[service] {service_event_type}`, `[unsupported] {content_type}`. */
export function placeholderText(content: ContentRecord): string {
  switch (content.kind) {
    case "poll":
      return `[poll] ${content.question}`;
    case "service":
      return `[service] ${content.serviceEventType}`;
    case "invoice":
      return "[unsupported] invoice";
    case "other":
      return `[unsupported] ${content.contentType}`;
    default:
      return `[unsupported] ${content.kind}`;
  }
}
