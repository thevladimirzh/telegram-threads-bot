import type { Messages } from "@lingui/core";

/**
 * English message catalog (default locale).
 *
 * Plain TypeScript catalog — no Babel macros, no build step. Keys are explicit
 * message ids (see AGENTS.md, "i18n"). Every key added here must also exist in
 * `ru.ts`. Exact strings pinned by docs/spec/decisions.md §3:
 * `transfer.closing`, `transfer.closingPlaceholders`, `transfer.announce`.
 */
export const messages: Messages = {
  "app.name": "Threads bot",
  "start.text":
    "Forward messages from a connected source chat into the threads chat to move the discussion into a named thread.",
  "settings.title": "Settings",
  "settings.chatList": "Chats where I am an admin:",
  "settings.refusal": "Only global admins can manage settings.",
  "settings.notPrivate": "Settings can only be managed in a direct message.",
  "settings.actionSource": "Source",
  "settings.actionThreads": "Threads",
  "settings.actionDisconnect": "Disconnect",
  "settings.sourceConnected": "Connected as a source chat: {title}",
  "settings.sourceConnectRefused": "{title} is the threads chat and cannot be a source chat.",
  "settings.threadsConnected": "Threads chat set to {title}.",
  "settings.threadsRepointed": "Threads chat re-pointed from {previous} to {title}.",
  "settings.sourceDisconnected": "Disconnected {title}.",
  "settings.languageChanged": "Language changed.",
  "dialog.prompt":
    "Create a thread: 1. pick the source chat 2. send the title 3. the transfer starts automatically. The title must be 1..255 characters; up to 50 messages per batch; the dialog times out after 15 minutes (send /cancel to abort).",
  "dialog.summary": "Batch: {count} messages from {chats} chats; {dropped} will be dropped.",
  "dialog.batchJoined": "Added to the batch: {count} messages. Send /cancel to abort.",
  "dialog.notConnected": "{title} is not a connected source chat.",
  "dialog.timeout": "The dialog timed out and was cancelled.",
  "dialog.invalidTitle": "The title must be 1..255 characters after trimming.",
  "dialog.pickFirst": "Pick the source chat with the buttons first, then send the title.",
  "dialog.noDraft": "There is no active dialog.",
  "dialog.cancelled": "The dialog was cancelled.",
  "dialog.cancelForeign": "Only the author of the forwarded batch can cancel it.",
  "transfer.refusedNotAdmin": "Only admins of {title} can move its messages.",
  "transfer.duplicate": 'These messages were already moved to "{title}": {url}',
  "transfer.failure": "The transfer failed and nothing was moved. Try again later.",
  "transfer.closing": "{title} — moved from {link}",
  "transfer.closingPlaceholders": "{count} messages replaced by placeholders",
  "transfer.announce": 'Thread created "{title}": {url}',
  "transfer.reportNoOriginals": "no originals were found to delete",
  "transfer.reportUnidentified": "{count} messages could not be identified",
  "transfer.reportNotDeleted": "not deleted: {ids}",
};
