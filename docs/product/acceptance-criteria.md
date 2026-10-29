# Acceptance criteria — iteration 1

AC1–AC10 restate `docs/plan.md` §4 (1..10) verbatim in content; the numbering is aligned so
`AC{n}` refers to plan §4 item `{n}`. AC11+ are product-level criteria added by `product-manager`
in T2. `docs/plan.md` is not modified; concerns are listed under
[Open questions to the orchestrator](#open-questions-to-the-orchestrator).

## From docs/plan.md §4

- **AC1.** `/settings` in DM lists chats where the bot is an admin; a global admin (env `ADMIN_IDS`)
  can mark source chats and exactly one threads chat; non-admins are refused.
- **AC2.** Forwarding 1..50 messages from a connected source chat into the threads chat opens a
  dialog in the threads chat: inline buttons to pick the source chat (preselected from
  `forward_origin` when known) and a request for the thread title; only the forward author can
  answer; `/cancel` or a 15-minute timeout aborts the draft with a message.
- **AC3.** When the chat is picked and a valid title (1..255 chars) is given, the bot creates a
  thread: message 1 = title (= thread root, `root_id`), then copies of the forwarded messages as
  bot messages without author attribution (albums copied as a group, order preserved), non-transferable
  content (polls, service messages) replaced with a placeholder like `[poll] {question}`, last message =
  `{title} — moved from {source chat link}`; the forwarded copies in the threads chat are deleted.
- **AC4.** In the source chat the originals are deleted and an announce is posted in the same topic
  (same `message_thread_id` when the source is a forum):
  `Thread created "{title}": https://t.me/{chat_path}/{root_id}?thread={root_id}`.
- **AC5.** If some originals cannot be deleted, the thread is kept and the bot reports how many/which
  failed.
- **AC6.** A mixed batch (messages from several chats) asks the author to pick one chat and takes only
  that chat's messages; a batch over 50 is truncated with a warning.
- **AC7.** Re-transferring already-mapped messages is refused (duplicate protection via message
  mapping).
- **AC8.** All user-facing strings go through i18n (ru/en).
- **AC9.** Logs are pino JSON in stdout; `/health` and `/ready` respond; `MODE=polling|webhook` switch
  exists.
- **AC10.** Clean test run is green (exact command is defined in `AGENTS.md` by bootstrap:
  `npm test`; also `npm ci && npm test` from a fresh checkout).

## Added product-level criteria (T2)

- **AC11. — No silent failures.** Every failure path ends with a user-visible, localized message:
  dialog errors as replies in the threads chat, source-side deletion problems as the AC5
  partial-failure report, connection problems as `/settings` replies. No raw stack traces or English
  error dumps shown to users.
- **AC12. — Acknowledgement and latency.** The bot acknowledges the forwarded batch within ~2 s
  (dialog opens) and acknowledges the start of a transfer before long work; a transfer of up to 50
  messages completes within ~60 s under normal API conditions, or ends with a clear report. Waits on
  `retry_after` are transparent (progress or a final report), never a silent hang.
  *Measured as call sequences in tests (the clock is injected, see AGENTS.md), not wall time.*
- **AC13. — i18n completeness and locale choice.** Beyond AC8: announcements, closing message,
  timeout/cancel notices, duplicate refusals and error reports are all localized (ru/en), the locale
  is deterministic (D19: `language_code`, manual switch in `/settings`), and no handler contains
  hardcoded user-facing text. Which locale a *public* announce uses — see open question OQ-1.
- **AC14. — Data-safety invariant.** Originals in the source chat are deleted only after the root,
  all copies and the closing message are posted in the threads chat; an aborted or failed run
  (invalid title, `/cancel`, timeout, copy failure) deletes nothing in the source chat.
- **AC15. — Duplicate UX.** A refused duplicate transfer names the existing thread (or explains the
  refusal) and creates nothing: no second thread, no second announce, no deletions.
- **AC16. — Configuration safety.** `/settings` confirms each change (what was connected/disconnected);
  invalid configurations are refused with a clear message: a source chat equal to the threads chat,
  transferring from a non-connected chat, and non-global-admins changing connections.
- **AC17. — Title validation feedback.** An invalid title (empty/whitespace-only or > 255 chars after
  trim) is rejected with a localized message stating the 1..255 rule; the draft stays open for a
  retry (or is aborted explicitly) — behavior fixed via OQ-5.

## Open questions to the orchestrator

None of these changes `docs/plan.md`; each needs a decision or an interpretation confirmation.

- **OQ-1 (contradiction AC4 vs AC8).** AC4 pins a literal English announce string while AC8 demands
  i18n of every user-facing string. Proposed reading: the announce is a *localized template* whose
  exact URL part `https://t.me/{chat_path}/{root_id}?thread={root_id}` is fixed, and the text around
  it is translated. Also undefined: which locale a public announce in the source chat uses
  (initiator's locale? chat locale?). Proposed: initiator's locale.
- **OQ-2 (gap AC3).** The placeholder format is "like `[poll] {question}`" — not exact. Exact output
  must be pinned for tests (which content types get placeholders — polls, service messages, dice,
  invoices, contacts, venues? — and the exact template).
- **OQ-3 (gap AC5).** Where does the partial-failure report go — reply in the threads chat, message in
  the source chat, or DM to the author? Proposed: reply in the threads chat to the thread's root.
- **OQ-4 (gap AC2).** `forward_origin` for hidden-user forwards carries no chat, so preselection is
  impossible; and when the origin chat is *not* connected — preselect it anyway (and fail later) or
  only preselect connected chats? Proposed: preselect only when the origin chat is connected.
- **OQ-5 (gap AC2/AC17).** On invalid title: keep the draft open for a retry or abort? And do the
  author's raw title/answer messages in the threads chat get deleted after parsing (dialog clutter)?
  Not specified anywhere in the plan.
- **OQ-6 (gap AC6).** Which 50 messages are kept on truncation (proposed: first 50 chronologically),
  and does the transfer start immediately after the title or does the user confirm the truncated set?
  Also: does an over-50 batch open the dialog for the truncated set at once?
- **OQ-7 (assumption, tension D3 vs AC5).** D3 says originals are "always deleted" while AC5/D12 keep
  the thread on failure. Confirm: when *all* originals fail to delete (or none can be matched — e.g.
  privacy mode left on, messages older than the bot's index), the thread is still kept and only a
  report is sent; nothing else is retried automatically.
- **OQ-8 (assumption AC1).** Confirm that a connected source chat must differ from the threads chat
  and that re-pointing connections in `/settings` never affects already-created threads.
