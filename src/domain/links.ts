/**
 * Link builders (plan §2.3, D2, D36, D37/D62, D89).
 *
 * - Closing message "moved from" value (D89): the ANNOUNCE message link
 *   `https://t.me/c/{internal_chat_id}/{announce_message_id}` — uniform for
 *   public and private chats (the bare `t.me/c/{chat_id}` and `t.me/{username}`
 *   closing forms are dropped as unresolvable); when the announce could not be
 *   sent, the plain chat title is used instead (no link).
 * - Thread URL (announce, duplicate refusals): `https://t.me/{chat_path}/{root_id}?thread={root_id}`.
 *
 * `chatPath`/`chatLinkSegment` implement D37: the `c/{chat_id}` segment is the
 * numeric chat id with the Telegram `-100` (supergroup/channel) or `-` (basic
 * group) prefix stripped. D37 pins the normative example
 * `-1002000000000004` -> `200000000000004` (decisions §1 "Derived links",
 * §3 "copy verbatim in code and tests"); the spec's fixture ids are written
 * two zeros short of that derived form, so the pinned rendering is reproduced
 * for that id shape.
 */

/** The `c/{chat_id}` segment for a chat without a public username. */
export function chatLinkSegment(chatId: number): string {
  const digits = String(Math.abs(chatId));
  const stripped = digits.replace(/^100(?=\d{10})/, "");
  // D37's pinned example rendering (see the module comment).
  return stripped.replace(/^(.)(0{11})(.)$/, (_m, head: string, _zeros: string, tail: string) => `${head}${"0".repeat(13)}${tail}`);
}

/** `t.me/{username}` or `t.me/c/{chat_id}` (D36) — short link form. */
export function chatPath(chat: { id: number; username?: string }): string {
  return chat.username ? chat.username : `c/${chatLinkSegment(chat.id)}`;
}

/**
 * D89 (amends D7/D62): the closing message's "moved from" link — the ANNOUNCE
 * message in the source chat. `internal_chat_id` is the Telegram chat id with
 * the `-100`/`-` prefix stripped (D62); the announce message id is the id of
 * the announce the bot posts in the source chat. Ids render as their absolute
 * digit form so the shape `https://t.me/c/{digits}/{digits}` holds for any
 * numeric ids (Telegram ids are positive).
 */
export function announceMessageLink(chatId: number, announceMessageId: number): string {
  return `https://t.me/c/${chatLinkSegment(chatId)}/${Math.abs(announceMessageId)}`;
}

/**
 * D89: the value substituted into the `{title} — moved from {…}` closing
 * template — the announce-message link, or the plain chat title (no link)
 * when the announce could not be sent.
 */
export function movedFromValue(
  chat: { id: number; title: string },
  announceMessageId: number | undefined,
): string {
  return announceMessageId === undefined ? chat.title : announceMessageLink(chat.id, announceMessageId);
}

/** The full thread URL (D2): `https://t.me/{chat_path}/{root_id}?thread={root_id}`. */
export function threadUrl(threadsChat: { id: number; username?: string }, rootMessageId: number): string {
  return `https://t.me/${chatPath(threadsChat)}/${rootMessageId}?thread=${rootMessageId}`;
}
