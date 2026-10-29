# Product brief — Telegram threads bot (iteration 1)

Source of truth for scope and decisions: `docs/plan.md` (D1–D25). This brief is a product-level
summary; where it disagrees with `docs/plan.md`, the plan wins.

## Goal

Move a discussion out of a busy main chat into a dedicated "threads chat" as a named reply thread —
in a few clicks, without copy-paste and without losing content. The source chat keeps a single
announcement with a link to the new thread; the thread holds the whole discussion.

## Target users

- Admins and moderators of busy Telegram group chats (ru/en) who want to keep the main chat on topic.
- The "author" of a digression: any chat member who forwards the offending messages into the threads
  chat to spawn a thread (must be an admin of the chosen source chat, D4).
- Global bot admins (`ADMIN_IDS`) who connect chats via `/settings` in DM.

## User journey

1. A global admin DMs the bot, runs `/settings`, sees the chats where the bot is admin, connects one
   or more source chats and exactly one threads chat.
2. In the main chat a discussion goes off-topic; the author forwards 1..50 of its messages (albums
   included) into the threads chat.
3. The bot replies in the threads chat with a short dialog: inline buttons to pick the source chat
   (preselected from `forward_origin` when known) and a request for the thread title.
4. Only the forward author can answer: pick the chat, send a title (1..255 chars after trim), or
   `/cancel`; the draft aborts on `/cancel` or after 15 minutes with a message.
5. The bot creates a reply thread: title message (= thread root), then copies of the messages as bot
   messages without author attribution (albums copied as a group, order preserved; polls and service
   messages replaced with placeholders), and a closing message linking back to the source chat.
6. The bot deletes the forwarded copies in the threads chat and the originals in the source chat
   (batched, `retry_after` honored), and posts an announce with the thread link in the same topic
   of the source chat.
7. If some originals cannot be deleted, the thread is kept and the author gets a report of what
   failed.
8. Forwarding the same messages again is refused: the mapping remembers what was already moved.

## Value

- Main chat stays on topic with a single, linkable announce instead of a deleted discussion.
- Nothing is lost: the whole digression lives in a named thread, reachable both ways
  (closing message → source chat, announce → thread).
- Minutes of manual moderation work replaced by two actions (forward + title).
- Full message mapping is stored, so duplicates are detectable and history is auditable.

## Non-goals (out of scope this iteration — plan §3, D2, D6, D16, D20)

- No synchronization of later replies between the thread and the chats (the thread lives on its own).
- No multi-source-chat threads: one thread = one source chat; mixed batches are reduced to one chat.
- No editing or deleting of already-moved messages via the bot.
- Threads are reply threads in plain groups, not forum topics (forum sources are supported only as
  the *source* of a transfer).
- No real Telegram network calls in tests (in-process fake Bot API only); no mtcute/Test DC.
- No real-PostgreSQL integration tests (repositories are tested via the in-memory store).
- No metrics/tracing (pino logs + `/health` + `/ready` only).
