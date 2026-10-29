# Spec decisions — telegram-threads-bot (T5, business-analyst)

Owner: `business-analyst`. Date: 2026-10-28 (updated 2026-10-29 for iteration 2 and,
the same day, for iteration 3 — closing-link fix).
Status: current; iteration-2 decisions **D87/D88** and iteration-3 decision **D89**
(plan §6, referenced as-is, D1–D86 not renumbered) are recorded at the end of §5.

Sources: `docs/plan.md` (§4 acceptance criteria, §6 decisions D1–D34, §7 test-facing contract),
`docs/product/acceptance-criteria.md` (AC1–AC17, OQ-1..OQ-8), `docs/risk-register.md` (R1–R47).

This file (1) mirrors D1–D34 concisely, (2) records every additional interpretation the
Gherkin scenarios in `tests/features/*.feature` forced, continuing the numbering at **D35**,
(3) lists the exact output strings the tests must assert verbatim, and (4) ends with
**Open questions to the orchestrator** for anything that changes observable behaviour and is
not covered by D1–D34.

## 0. Test entry point

Acceptance tests drive `createBot` per `docs/plan.md` §7 (fake Bot API attached via the grammY
transformer, updates fed with `handleUpdate`, assertions on recorded API calls); tests must not
import anything else from `src/`. This is the only place where an internal name is referenced —
scenarios themselves stay black-box (Telegram updates, API calls, stored rows).

## 1. Fixture conventions (used by all scenarios and future tests)

| name | id | username | kind / role |
|---|---|---|---|
| `admin` (user) | 777 | — | global admin (`ADMIN_IDS`) |
| `author` (user) | 111 | — | admin of `Source Chat`; forward author; `language_code: "en"` unless stated |
| `other_author` (user) | 113 | — | admin of `Source Chat`, second dialog participant |
| `stranger` (user) | 222 | — | no rights anywhere |
| `Source Chat` | -1002000000000001 | `main_chat` | plain group, connected source chat |
| `Private Source Chat` | -1002000000000004 | — | plain group, connected source chat |
| `Forum Chat` | -1002000000000002 | `forum_chat` | forum (topics), connected source chat |
| `Threads Chat` | -1002000000000003 | `threads_chat` | plain group, connected threads chat |
| `Private Threads Chat` | -1002000000000005 | — | plain group, threads chat (link-format cases) |
| `Threads Chat 2` | -1002000000000007 | `threads_chat_2` | plain group, used to re-point the connection |
| `Other Chat` | -1002000000000006 | `other_chat` | not connected by default (S83 connects it as a second source chat, D84) |

Derived links: thread URL `https://t.me/threads_chat/42?thread=42`,
`https://t.me/c/200000000000005/42?thread=42` (root id 42); closing link (D89, announce
id stubbed at 42): `https://t.me/c/200000000000001/42` (Source Chat),
`https://t.me/c/200000000000004/42` (Private Source Chat) — uniform
`https://t.me/c/{internal_chat_id}/{announce_message_id}`. The legacy short chat links
`t.me/main_chat`, `t.me/c/200000000000004` (D36/D62 closing form) are dropped by D89
and appear in no scenario any more.

## 2. Step vocabulary (documentation shorthand)

- `the message N from user U sent at T in C was observed by the bot` — an ordinary message update
  in a connected source chat; this is how the `source_messages` index is filled (plan §7.4).
- `user U forwards the message N of C into T` — a forward update into the threads chat.
- `user U picks C and sends the text "Title"` — completing the dialog (chat-choice callback + title
  text). `... and completes the dialog` in `When` steps means the same.
- `a thread titled X is created` / `the transfer completes` — shorthand for the same dialog
  completion with a valid title.
- `the next message created by the bot gets the id N` — stubbing the fake API's returned
  `message_id` (root id plumbing).
- `no dialog is opened` / `no second dialog is opened` — no draft is created (and no dialog message
  posted) for the forwarded batch.
- `no refusal message is sent to T` — nothing at all — in particular no refusal — is sent to the
  given chat (the bot stays silent there).
- `the draft of user U contains the messages N and M` — the batch of U's open draft is exactly
  those observed messages, in forward order. The draft accumulates forwards (D68 final, per D16):
  earlier messages are never dropped, so the former `contains only the message N` variant is no
  longer asserted.
- `the bot posts a new dialog message asking for the source chat and the title` — a fresh dialog
  message (S15 shape: source-chat buttons + title request) is posted, (re)opening the dialog for the
  batch (chat selection cleared on the D68-final re-render).
- `when user U completes the dialog for "C", only the message N is transferred and only its
  original is deleted` — U finishes the dialog by picking C and sending a valid title (the
  `user U picks C and sends the text "Title"` shorthand; the selection was cleared, D68 final);
  per D16 only C's messages are copied into the created thread (cf. `the thread contains only the
  copy of the message N`) and only their originals are deleted — the batch's messages from other
  chats are rejected with a warning (D73) and nothing of theirs is deleted (S83).
- `"C" is connected as a second source chat` (singular form of the Background step
  `"X" and "Y" are connected as source chats`) — C becomes a connected source chat **in addition**
  to the already-connected ones, i.e. a second, different connected source chat (D84); test seeding
  follows the S54/S36 pattern (D79 discovery signal + D4 admin) before connecting. S83 uses this to
  pin that its `Other Chat` forward is a *different connected* source chat, not an unconnected one.
- `each copy is a reply to the title message` — every copied message is sent as a reply to the
  title message, i.e. `reply_parameters.message_id = root_id`; "the title message" is always the
  thread root — the first bot message carrying the title. Thread assembly never uses
  `message_thread_id` (D87).
- `the closing message is a reply to the title message` — the closing message (D9) is sent the
  same way (D87).
- `the report as a reply to the title message …` — the D28 failure report is sent as a reply to
  the title message (D87); the former wording "a reply in the thread" is retired.
- `the album is copied per item` — each album message becomes its own copy message (one
  `copyMessage` per item with reply to the title message, D88); the copies are contiguous and in
  source order and media-group grouping is intentionally not preserved.
- `no message of the thread carries message_thread_id` — the thread is a plain reply chain around
  the title message (D87); `message_thread_id` appears only on the source-chat announce when the
  source is a forum (S61/S62, D18/D69).
- `the announce message gets the id N` — stubbing the fake API's returned `message_id` for the
  announce message specifically (the `sendMessage` posted into the source chat, D26), no matter
  where in the call order it falls; needed so exact closing-link strings are deterministic (D89).
- `the closing message of the thread is posted after the announce in "C"` — API-call ordering:
  the announce `sendMessage` into C precedes the closing `sendMessage` (D89 — the announce id must
  be known before the closing is composed; the thread display order is unchanged).
- `the closing message links to the announce message in "C"` — the closing's "moved from" link is
  exactly `https://t.me/c/{internal_chat_id}/{announce_message_id}` (D89), where
  `announce_message_id` is the id the fake API returned for the announce in C and
  `internal_chat_id` is C's Telegram chat id with the `-100`/`-` prefix stripped (D62/D37); the
  form is uniform for public and private chats.
- `sending the announce in "C" fails with a Telegram error` — fixture: the announce `sendMessage`
  into C returns a Telegram error (cf. the existing `deleting … fails with a Telegram error`
  steps); the transfer continues and the closing message falls back to the plain chat title
  (D89, S84).

## 3. Exact output strings (en) — copy verbatim in code and tests

| where | exact string |
|---|---|
| announce (AC4, D26) | `Thread created "{title}": https://t.me/{chat_path}/{root_id}?thread={root_id}` |
| closing message (AC3, D89) | `{title} — moved from https://t.me/c/{internal_chat_id}/{announce_message_id}` (em dash `—`, U+2014) |
| closing message fallback (D89, announce failed) | `{title} — moved from {chat title}` (same template, no link) |
| closing extra line (D27) | `N messages replaced by placeholders` (only when N ≥ 1) |
| poll placeholder (D27) | `[poll] {question}` |
| service placeholder (D27) | `[service] {service_event_type}` |
| unsupported placeholder (D27) | `[unsupported] {content_type}` |
| closing link (D89; replaces the plan §2.3 source chat link `t.me/{username}` / `t.me/c/{chat_id}` — dropped, invalid without a message id) | `https://t.me/c/{internal_chat_id}/{announce_message_id}`; `internal_chat_id` = chat id with the `-100`/`-` prefix stripped (D62/D37); uniform for public and private chats |
| thread URL (D2) | `https://t.me/{chat_path}/{root_id}?thread={root_id}` |

Everything else (dialog prompt, refusals, warnings, reports, abort notices) is localized text
without a pinned wording yet — scenarios assert "localized …" semantics; see OQ-M.
Placeholder type tokens are fixed ASCII and never localized (D27); the summary part is the raw
Telegram value.

## 4. Decisions D1–D34 (concise mirror of docs/plan.md §6)

| # | decision (condensed) |
|---|---|
| D1 | The user forwards messages straight into the threads chat. |
| D2 | A thread is a reply thread in a plain group; link `https://t.me/{chat_path}/{message_id}?thread={message_id}`, `message_id` = thread root. |
| D3 | Originals are always deleted and an announce is posted. |
| D4 | Only admins of the chosen source chat create threads; global admins manage `/settings`; the bot is admin in both chats with delete rights. |
| D5 | Content is copied as bot messages with no author attribution; albums as a group. *(amended by D87/D88: every copy is a reply to the root; albums per item)* |
| D6 | No reply synchronization in v1. |
| D7 | Closing message links to the source chat; announce links to the thread. *(amended by D89: the closing link points to the announce message in the source chat, `https://t.me/c/{internal_chat_id}/{announce_message_id}`; the bare chat link is dropped)* |
| D8 | The dialog runs in the threads chat (reply to the forwarded batch). |
| D9 | Layout: `[title = root] + [copies (+placeholders)] + [closing]`. *(amended by D87: every message after the root is a reply to the root)* |
| D10 | Full message mapping stored (`threads`, `thread_messages`, `source_messages`). |
| D11 | Chats connected via `/settings` in DM, auto-list of chats where the bot is admin. |
| D12 | Partial deletion failure: keep the thread, report what was not deleted. |
| D13 | Tests use an in-process fake Bot API behind a grammY transformer. |
| D14 | Docker + Helm; migrations in a pre-upgrade hook Job; `existingSecret`. |
| D15 | Polling and webhook behind a config switch; polling default. |
| D16 | One thread = one source chat; mixed batch ⇒ pick one chat, others rejected; >50 ⇒ truncated with warning. |
| D17 | Only the forward author answers; `/cancel` aborts; draft timeout 15 min. |
| D18 | Source chats may be forums: announce keeps the `message_thread_id`. |
| D19 | i18n ru+en, default `en`, auto by `language_code`, manual switch in `/settings`. |
| D20 | pino logs + `/health` + `/ready`; no metrics. |
| D21 | Originals found via index of observed messages, matched by (forward date, sender, content hash); privacy mode must be off; real-network verification deferred. |
| D22 | Title: 1..255 characters after trim. |
| D23 | Duplicate transfer of already-mapped messages is refused. |
| D24 | `retry_after` honored everywhere. |
| D25 | Tests never talk to a real database; Drizzle schema compile-checked only. |
| D26 | All bot messages use the initiator's locale; the thread URL is appended verbatim. |
| D27 | Placeholder formats exact (see §3); type tokens fixed ASCII; closing gets "N messages replaced by placeholders" when used. |
| D28 | The partial-deletion report is a reply into the created thread. |
| D29 | Hidden-sender `forward_origin` ⇒ buttons shown without preselection. |
| D30 | Invalid title ⇒ ask again with hint, draft/timeout stay; author's dialog messages are not deleted, only the forwarded batch. |
| D31 | Batch limit 50: first 50 messages in forward order taken, rest dropped, warning with dropped count. |
| D32 | Zero matched originals ⇒ thread stays, report says no originals were found to delete. |
| D33 | Threads chat must differ from source chats; reconnecting chats never affects created threads. |
| D34 | Duplicate ⇒ refusal with a link to the existing thread (message + link, no side effects). |

## 5. New decisions forced by the scenarios (D35+)

Marked ⚠ = materially changes observable behaviour, confirm in [open questions](#7-open-questions-to-the-orchestrator).

- **D35.** Test entry point is fixed by plan §7 (see §0 above); the source-message index is filled
  only with messages the bot observes in connected source chats.
- **D36.** Two link forms coexist: the closing message uses the short chat link
  `t.me/{username}` / `t.me/c/{chat_id}` (plan §2.3), while the announce and duplicate refusals use
  the full thread URL `https://t.me/{chat_path}/{root_id}?thread={root_id}` (D2). `chat_path` =
  the chat's public username without `@` when present, else `c/{chat_id}`.
  *(iteration 3, D89: the closing half of this split is **dropped** — a bare `t.me/c/{chat_id}`
  is not a valid Telegram link; the closing now links to the announce message, and only the
  thread-URL form remains for the announce/duplicate refusals.)*
- **D37.** ⚠ `{chat_id}` in `c/{chat_id}` links is Telegram's canonical private-link form: the
  `-100` prefix of the numeric id is stripped (`-1002000000000004` → `t.me/c/200000000000004`).
  Reason: real Telegram links look like this; the raw negative id would produce a dead link.
  *(this is the local mirror of plan **D62**; iteration 3, D89 amends D62's closing-link format —
  the bare `t.me/c/{id}` form is invalid and dropped — but the **id-stripping rule itself stays**
  and is used inside the new announce link `https://t.me/c/{internal_chat_id}/{announce_message_id}`.)*
- **D38.** ⚠ Title length (D22 "1..255 characters") is counted in **Unicode code points** after
  trimming leading/trailing whitespace. Reason: what a user counts as "characters"; pinned
  explicitly because R19 flags the UTF-16 ambiguity. Boundary scenarios (S24/S25) pin it.
- **D39.** `N` in "N messages replaced by placeholders" (D27) counts the placeholder messages in
  the thread (one per replaced message); the line appears only when N ≥ 1. The template is fixed:
  `N` is substituted literally (for N = 1 the line is `1 messages replaced by placeholders`;
  no pluralization rules are specified).
- **D40.** Announce template in English is exactly `Thread created "{title}": {thread_url}` (AC4
  wording); other locales translate the text around the URL only; the locale is the initiator's
  (D26, closing OQ-1).
- **D41.** ⚠ Batch truncation (D31 vs ACC-32 "never splits albums"): the kept set is the longest
  prefix of whole transfer entities (an album is one entity) in forward order whose message count
  is ≤ 50; a straddling album is never split and goes to the dropped set; the warning states the
  dropped message count. Reason: R26 names both "albums split" and "overflow taken" as failures.
- **D42.** ⚠ Duplicate check (D34) runs at the start of the transfer (chat picked + valid title),
  before any content-creating API call. If **any** matched original of the batch is already mapped,
  the **whole batch** is refused with one reply naming the earliest existing thread and containing
  its thread URL; no side effects at all.
- **D43.** Draft timeout: the draft expires exactly 15 minutes after the forwarded batch arrived
  (injected clock, no timers). Expiry is evaluated when the next update for that draft arrives; an
  answer whose arrival time is ≥ opening + 15 min counts as expired (single defined outcome for the
  timeout-vs-answer race, R32; boundary pinned by S31).
- **D44.** ~~Thread membership is signalled with `message_thread_id = root_id` on every message after
  the root~~ — **superseded by D87** (iteration 2): `message_thread_id` does not attach messages to
  a thread in a plain group (that was the bug); membership is signalled by replying to the title
  message. The second half stays: the threads chat is a plain group (D2).
- **D45.** The source index is refreshed by `edited_message` updates in connected source chats
  (otherwise edited originals could never match, R24).
- **D46.** ⚠ `forward_origin` preselection (rest of OQ-4, not covered by D29): preselect only when
  the origin chat is a connected source chat; otherwise show buttons without preselection. A batch
  whose messages all come from non-connected chats is refused with a clear message (AC16).
- **D47.** `/cancel` without an active draft and `/cancel` from a non-author both produce a harmless
  localized reply and never change state (R45).
- **D48.** Callback queries from non-authors or from stale buttons are acknowledged but never change
  state and never raise errors (R44).
- **D49.** ⚠ One active draft per author per threads chat (R30 — a silent overwrite is exactly the
  failure mode). *The "refused with a dialog in progress message" behaviour originally recorded here
  is superseded by **D68 (final)**, see the end of this section; the one-draft invariant stays.*
- **D50.** ⚠ The transfer starts immediately after a valid title; there is no confirmation step for
  the (possibly truncated) set (rest of OQ-6).
- **D51.** Both mixed-batch reduction (D16) and truncation (D31) produce a warning stating the count
  of messages left out (R14 — "silently left behind").
- **D52.** After a successful transfer the whole forwarded batch — transferred, rejected and dropped
  copies alike — is deleted in the threads chat (AC3 "the forwarded batch is deleted", D30).
- **D53.** The announce is posted whenever a thread was created, even if no originals could be
  deleted (D3 announces unconditionally; D32 only changes the report).
- **D54.** The AC5 report is sent only when at least one batch message left an original behind; it
  counts, per reason, the originals that "were not deleted" (delete failed) and those that "could
  not be identified" (zero or ambiguous match); the all-missing case uses the D32 wording
  "no originals were found to delete".
- **D55.** ⚠ A batch spanning several forum topics of a forum source announces in the topic of the
  **first message in forward order** (R36 has no spec answer; one thread ⇒ one announce, D3).
- **D56.** The root (title) message doubles as the transfer-start acknowledgement (AC12); no extra
  messages are added beyond the D9 layout.
- **D57.** `ADMIN_IDS` is comma-separated: entries are trimmed, empty entries ignored, any
  non-numeric entry is a configuration error at startup (never a crash) (R40).
- **D58.** ⚠ `/settings` allows re-pointing the threads chat: marking a new threads chat disconnects
  the previous one and the confirmation names both ("exactly one threads chat", AC1).
- **D59.** Transferable content = anything the Bot API can repost as a bot message; polls, service
  messages and any other non-copyable type get the D27 placeholders verbatim (e.g. an invoice →
  `[unsupported] invoice`).
- **D60.** Replies inside the batch are copied as plain messages: no `reply_to_message_id` pointing
  into the source chat, no crash (R43). *(iteration 2, D87: "plain" excludes the reply to the
  title message — the copy still replies to the thread root, S47 asserts only that no reply
  reference points into the source chat.)*
- **D61.** `/health` (liveness) and `/ready` (DB ping, 503 on failure) are plain HTTP endpoints;
  AC10 (green clean run) is enforced by the QA gate (`npm test`) and has no Gherkin scenario;
  observability scenarios (S80–S82) have no dedicated risk ID and carry only `@AC9`/`@S` tags.
- **D68 (final)** — plan §6 FINAL wording (supersedes both earlier versions, incl. the former
  "D68 (revised)"; the user's D16 answer is authoritative), not renumbered; supersedes the D49
  "refusal" wording. While a draft is open, new forwards from the same author **join the draft
  batch** from any chat (no new dialog message for the join itself, no refusal; timeout stays
  anchored to draft creation, D43) — the same-chat join is pinned by **S32**. The draft
  **accumulates forwards (per D16) rather than dropping earlier messages** — there is no reset to
  the newest forward (the "recreate ⇒ batch = the new forward" reading of the revised wording is
  gone). If the batch spans several source chats, the dialog is **re-rendered** (a new dialog
  message, chat selection cleared) and D16 applies at completion: exactly one chat is picked, only
  its messages transfer, the rest are rejected with a warning (D73). A forward from an unconnected
  chat is refused and leaves the draft untouched (**D84**), closing the earlier flag ("how does
  such a draft complete?") — no completion rule is needed, because such a draft never adopts
  unconnected-chat messages. *Scenario coverage:* **S32** pins the join (the draft holds both
  messages); **S83** pins the re-render and the D16 completion outcome — when the author completes
  the dialog for "Other Chat", only the message 20 is transferred and only its original is deleted
  (message 10 is rejected with a warning, D73). History: **S32 was realigned** (its old "dialog
  already in progress" refusal contradicted the brief) and **S83 was added** for the multi-chat
  branch.
- **D84** (plan §6, referenced as-is, not renumbered) — the D68-recreate rule applies to a forward
  from a DIFFERENT **CONNECTED** source chat; a forward from an unconnected chat is refused per
  AC16/S19 regardless of draft state and leaves the draft untouched (S19 class, even with a draft
  open). S83's `Other Chat` is therefore a second connected source chat — its `Given` now states
  this explicitly (step in §2), matching how the acceptance test drives it.
- **D87** (plan §6, referenced as-is, not renumbered) — iteration 2 (user bug report: the thread
  never formed). Thread-body messages (copies, placeholders, closing message, failure report) are
  sent as **replies to the thread root** — the first bot message with the title
  (`reply_parameters.message_id = root_id`). `message_thread_id` does **not** attach messages to a
  thread outside forum topics — it was the bug — and is never used for thread assembly; it remains
  **only** for the source-chat announce when the source is a forum (D18/D69, S61/S62 unchanged).
  **AMENDS D5/D9** (see §4) and **supersedes D44** (see above); D28/D60 readings are pinned in §2.
  Scenario impact (iteration 2, titles/tags unchanged): S34/S35 assert reply-to-root for copies and
  the closing message and no `message_thread_id` in the thread; S42/S43 assert each copy is a reply
  to the title message; S44/S45 additionally assert per-item album copies (D88); S49/S50 assert the
  closing message is a reply to the title message; the failure-report steps (S52/S53/S56–S59/S63)
  now say "a reply to the title message". *QA-R5 (tagging):* `@R62` was added to the tags of exactly
  these reply-to-root scenarios — S34/S35, S42–S45, S49/S50, S52/S53, S56–S59, S63 (titles and
  step wording unchanged) — for risk↔scenario traceability.
- **D88** (plan §6, referenced as-is, not renumbered) — albums are copied **per item** via
  `copyMessage` with reply to the root: contiguous and in source order (S44/S45), but media-group
  grouping is intentionally lost — `copyMessages` cannot set a reply (Bot API limitation,
  confirmed in the grammY types). Grouping is to be restored later via MTProto (mtcute). Chosen by
  the user over "album intact but outside the thread". Note: the S44 title keeps its historical
  "contiguous group" wording (titles are frozen for test stability) but means contiguous per-item
  copies; `media_group_id` in fixture steps names the source album's Telegram field and stays.
- **D89** (plan §6, referenced as-is, not renumbered) — iteration 3 (user bug report: the closing
  message's source link `t.me/c/4327410333` does not open). A bare `t.me/c/{chat_id}` is **not a
  valid Telegram link** (a message id is mandatory), so the D7/D62 closing-link format
  `t.me/{username}` / `t.me/c/{chat_id}` is **dropped**. The closing message
  `{title} — moved from {…}` links to the **announce message in the source chat**:
  `https://t.me/c/{internal_chat_id}/{announce_message_id}` — **uniform for public and private
  chats** (`internal_chat_id` = Telegram chat id with the `-100`/`-` prefix stripped; D62's
  stripping rule (mirror D37) stays and is used inside the new link). To know the announce id, the
  announce is sent **BEFORE** the closing message; the thread display order is unchanged (root,
  copies…, closing is still the last thread message). If the announce cannot be sent, the same
  template is filled with the **plain chat title** (no link): `Lunch — moved from Source Chat`.
  **AMENDS D7/D62** (see §4 D7 and the D36/D37 notes above).
  *Scenario impact (iteration 3, titles and wording unchanged):* S34/S36/S37 and dialog S26
  assert the exact closing link with the announce id stubbed at 42 (S36's Examples are now uniform
  `https://t.me/c/{internal}/{42}` rows for both chats); S50 additionally asserts the closing is
  posted **after** the announce and links to it; **S84 (new, `@R63`)** pins the fallback — announce
  failed ⇒ closing `Lunch — moved from Source Chat`, no link, thread kept. New fixture/Then steps
  are in §2. The D89 link-format scenarios S34/S36/S37/S26/S50 also carry **`@R63`** (appended to
  their existing tags on QA request, matching the QA-R5 pattern for `@R62`), so R63 mitigation is
  directly visible on the scenarios it mitigates.

## 6. Coverage summary

| feature file | scenarios | AC covered | risks covered |
|---|---|---|---|
| `settings.feature` | S1–S9 | AC1, AC8, AC13, AC16 | R3, R11, R12 |
| `configuration.feature` | S10–S14 | AC9 | R39, R40 |
| `dialog.feature` | S15–S33, S83 | AC2, AC12, AC16, AC17 | R6, R9, R16, R19, R25, R30, R31, R32, R44, R45, R63 |
| `thread-creation.feature` | S34–S41 | AC3, AC12, AC14 | R1, R4, R7, R8, R33, R34, R37, R41, R42, R62, R63 |
| `message-transfer.feature` | S42–S48 | AC3 | R8, R15, R20, R21, R41, R43, R62 |
| `cleanup-and-announce.feature` | S49–S63, S84 | AC3, AC4, AC5, AC14 | R1, R2, R4, R5, R8, R11, R13, R17, R18, R22, R23, R24, R29, R34, R35, R36, R37, R62, R63 |
| `failures-and-limits.feature` | S64–S75 | AC5, AC6, AC7, AC11, AC12, AC14, AC15 | R1, R6, R7, R9, R10, R11, R14, R26, R27, R28, R38, R42 |
| `i18n.feature` | S76–S79 | AC8, AC13 | R12, R46, R47 |
| `observability.feature` | S80–S82 | AC9 | — |

Total: **84 scenarios** (S1–S84). Every risk R1–R47 is tagged on at least one scenario; AC1–AC17
are covered except AC10 (QA gate, D61). Iteration-2 risk **R62** (D87/D88) is tagged on the 15
reply-to-root scenarios S34/S35, S42–S45, S49/S50, S52/S53, S56–S59, S63 (QA-R5).
Iteration-3 risk **R63** (D89) is tagged on the fallback scenario S84 **and** on the D89
link-format scenarios S34/S36/S37 (thread-creation), S26 (dialog) and S50 (cleanup-and-announce).

## 7. Open questions to the orchestrator

Each needs a confirmation or a decision; the provisional interpretation (already used in the
scenarios) is named so a "yes" closes the item.

- **OQ-A (D37).** `c/{chat_id}` links: strip the `-100` prefix (canonical Telegram form, chosen) or
  use the raw numeric id? Changes exact URLs asserted in S36/S60/S68.
- **OQ-B (D38).** Title length unit: Unicode code points (chosen) vs UTF-16 code units. R19
  explicitly flags this; S24/S25 boundary rows (255 emoji accepted, 128 flags rejected) pin the
  choice.
- **OQ-C (D41).** Album straddling the 50-message boundary: D31 says "the first 50 messages",
  ACC-32 says "never splits albums" — the two conflict. Chosen: whole entities only, ≤ 50 messages,
  straddling album dropped (S67). Alternative: keep D31 literal and split the album.
- **OQ-D (D42).** Duplicate handling: check at transfer start and refuse the whole batch when any
  matched original is already mapped (chosen). Alternatives: check at forward time (before the
  dialog) and/or refuse per message.
- **OQ-E (D46).** Remainder of OQ-4 (not covered by D29–D34): preselection when `forward_origin`
  names a non-connected chat. Chosen: no preselection; a batch from non-connected chats is refused
  (AC16).
- **OQ-F (D50).** Remainder of OQ-6: does the transfer start immediately after the title, or does
  the user confirm the (possibly truncated) set first? Chosen: immediately.
- **OQ-G (D49).** ~~Second forwarded batch from the same author while a draft is open: refuse with
  "dialog in progress" (chosen) vs abort the old draft and open a new one.~~ **Resolved by
  D68 (final)** — neither option: forwards join the draft batch from any chat (the draft
  accumulates forwards per D16, earlier messages are kept) and a multi-chat batch re-renders the
  dialog with D16 applied at completion (S32/S83).
- **OQ-H (D55).** Batch spanning several forum topics: announce in the topic of the first message in
  forward order (chosen) vs the last message vs a separate announce per topic.
- **OQ-I (D51/D52).** Confirm that (a) mixed-batch reduction warns with the count of left-out
  messages and (b) rejected/dropped forwarded copies are deleted together with the transferred ones.
- **OQ-J (D54).** Report wording classes for "could not identify the original" (zero vs ambiguous
  match) — confirm the two-reason split; the exact localized texts still need pinning (OQ-M).
- **OQ-K (D58).** Re-pointing the threads chat in `/settings`: replace with confirmation (chosen) vs
  refuse while one is connected.
- **OQ-L (D61).** `/health` and `/ready` HTTP endpoints are not in the plan §7 test-facing contract
  (which fixes `loadConfig`, `Store`/`InMemoryStore`, `createBot` only). Extend §7 with an HTTP entry
  point, or treat S80–S82 as documentation-only until then? Also: AC9's "pino JSON on stdout" is
  asserted through the injected logger (S82) — acceptable?
- **OQ-M (low).** Exact wording of all user-facing strings other than the §3 table (dialog prompt,
  refusals, warnings, abort notices, failure reports) is not pinned anywhere; scenarios assert
  semantics + localization only. Should `product-manager` pin catalog strings (ru/en) before T7?
