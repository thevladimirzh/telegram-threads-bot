# Plan — Telegram threads bot, iteration 1

Single source of truth for all role agents. Requirements were agreed with the user in the
chat on 2026-10-28. Subagents: read this file first; it contains everything you need.

## 1. Goal

A Telegram bot that moves a discussion out of a main chat into a "threads chat" as a named
reply thread: it copies the forwarded messages into the thread as its own messages, deletes
the forwarded copies and the originals, and leaves an announcement with a link to the thread
in the source chat.

## 2. Scope (this iteration)

1. Project bootstrap: TypeScript + grammY + Drizzle/PostgreSQL + Lingui + Vitest + fast-check + Zod + pino.
2. Config: Zod-validated env (`BOT_TOKEN`, `DATABASE_URL`, `ADMIN_IDS`, `MODE=polling|webhook`, `WEBHOOK_*`).
3. Domain logic (pure, unit-testable):
   batch grouping of forwarded messages (album = one entity), mixed-chat detection, batch limit (50),
   title validation (1..255 chars after trim), thread plan builder (title message = root, copies,
   placeholders for non-transferable content, closing message), link builders
   (`t.me/{username}` / `t.me/c/{chat_id}`, thread link `https://t.me/{chat_path}/{root_id}?thread={root_id}`),
   announce text, matcher of forwarded messages to indexed source messages, duplicate detection.
4. Store: Drizzle schema (`chats`, `users`, `drafts`, `threads`, `thread_messages`, `source_messages`)
   + repository interfaces + in-memory implementation used by tests.
5. Bot flow (grammY handlers, exercised through a fake Bot API):
   `/settings` in DM (auto-list of chats where the bot is admin, connect source chats and one threads chat,
   locale switch), forward → dialog (inline chat buttons + title by text, forward-author only, `/cancel`,
   15 min draft timeout) → create thread → delete forwarded copies → delete originals (batches <= 100,
   `retry_after` respected) → announce in the same topic (`message_thread_id` preserved for forum sources)
   → partial-failure report.
6. i18n: Lingui, `ru` + `en`, default `en`, auto by `language_code`, manual switch in `/settings`.
7. Observability: pino JSON to stdout, `/health` (liveness) and `/ready` (DB ping) HTTP endpoints.
8. Tests: unit (domain), property-based (fast-check over pure functions), acceptance (black-box via
   updates driven into the bot against an in-process fake Bot API), security tests (authz + input validation).
9. Deploy artifacts: Dockerfile + Helm chart skeleton (Deployment, migrate Job hook, `existingSecret`,
   `mode` switch).

## 3. Out of scope (this iteration)

- Real Telegram network calls of any kind (tests use the in-process fake Bot API only).
- mtcute / Test DC integration (stage 2), metrics/tracing, reply sync between thread and chats,
  multi-source-chat threads, editing/deleting after transfer.
- Real-PostgreSQL integration tests (repositories are tested via the in-memory store; the Drizzle
  schema is generated but only compile-checked).

## 4. Acceptance criteria

1. `/settings` in DM lists chats where the bot is an admin; a global admin (env `ADMIN_IDS`) can mark
   source chats and exactly one threads chat; non-admins are refused.
2. Forwarding 1..50 messages from a connected source chat into the threads chat opens a dialog in the
   threads chat: inline buttons to pick the source chat (preselected from `forward_origin` when known)
   and a request for the thread title; only the forward author can answer; `/cancel` or a 15-minute
   timeout aborts the draft with a message.
3. When the chat is picked and a valid title (1..255 chars) is given, the bot creates a thread:
   message 1 = title (= thread root, `root_id`), then copies of the forwarded messages as bot messages
   without author attribution (albums copied as a group, order preserved), non-transferable content
   (polls, service messages) replaced with a placeholder like `[poll] {question}`, last message =
   `{title} — moved from {source chat link}`; the forwarded copies in the threads chat are deleted.
4. In the source chat the originals are deleted and an announce is posted in the same topic
   (same `message_thread_id` when the source is a forum): `Thread created "{title}": https://t.me/{chat_path}/{root_id}?thread={root_id}`.
5. If some originals cannot be deleted, the thread is kept and the bot reports how many/which failed.
6. A mixed batch (messages from several chats) asks the author to pick one chat and takes only that
   chat's messages; a batch over 50 is truncated with a warning.
7. Re-transferring already-mapped messages is refused (duplicate protection via message mapping).
8. All user-facing strings go through i18n (ru/en).
9. Logs are pino JSON in stdout; `/health` and `/ready` respond; `MODE=polling|webhook` switch exists.
10. Clean test run is green (exact command is defined in `AGENTS.md` by bootstrap).

## 5. Constraints

- Stack is fixed: TypeScript, grammY, Lingui, Drizzle + PostgreSQL, Docker image + Helm chart,
  Vitest + grammY API transformers (in-process fake Bot API), Zod + pino. No other frameworks.
- Tests are deterministic: no real network, no real clock (inject time), fixed seeds for fast-check.
- The bot must be admin in both chats with `can_delete_messages`; privacy mode must be disabled
  (`/setprivacy -> Disable`) because the source-message index depends on seeing all messages.
- Telegram API limits are respected: `deleteMessages` <= 100 ids per call, `retry_after` honored.
- Do not weaken or edit tests to make them green; fix the code.

## 6. Decisions made in the chat (authoritative)

| # | Decision |
|---|---|
| D1 | Entry point: the user forwards messages straight into the threads chat. |
| D2 | A thread is a reply thread in a plain group (NOT forum topics); link format is `https://t.me/{chat_path}/{message_id}?thread={message_id}` where `message_id` = thread root. |
| D3 | Originals in the source chat are always deleted + an announce message is posted. |
| D4 | Only admins of the chosen source chat can create threads; global admins (`ADMIN_IDS`) manage `/settings` and chat connections; the bot is admin in both chats with delete rights. |
| D5 | Content is copied as bot messages with no author attribution; albums copied as a group. |
| D6 | No synchronization of later replies in v1 (thread lives on its own). |
| D7 | The closing message of the thread links to the source chat; the announce links to the thread. |
| D8 | The dialog runs in the threads chat (bot replies to the forwarded batch). |
| D9 | Thread layout: `[title message = root] + [copies (+placeholders)] + [closing: title + source chat link]`. |
| D10 | Full message mapping is stored (`threads`, `thread_messages`, `source_messages`). |
| D11 | Chats are connected via `/settings` in DM: auto-list of chats where the bot is admin. |
| D12 | Partial deletion failure: keep the thread, report what was not deleted. |
| D13 | Tests use an in-process fake Bot API behind a grammY transformer. |
| D14 | Deploy: Docker image + Helm chart; migrations run in a pre-upgrade Helm hook Job; secrets via `existingSecret`. |
| D15 | Both polling and webhook modes behind a config switch, polling is default. |
| D16 | One thread = one source chat: a mixed batch makes the author pick one chat, other messages are rejected; > 50 messages are truncated with a warning. |
| D17 | Only the forward author answers the dialog; `/cancel` aborts; draft timeout is 15 minutes. |
| D18 | Source chats may be forums: the announce goes to the same topic (`message_thread_id`). |
| D19 | i18n: ru + en, default `en`, auto by `language_code`, manual switch in `/settings`. |
| D20 | pino logs + `/health` + `/ready`; no metrics in v1. |
| D21 | Originals are found by indexing all messages of connected source chats (`source_messages`) and matching a forwarded message by (forward date == message date, sender, content hash), because the Bot API does not expose the source `message_id` for group forwards. Requires privacy mode off. Real-network verification of this assumption is deferred (no real Telegram calls here) and tracked as a risk. |
| D22 | Title: 1..255 characters after trim. |
| D23 | Duplicate transfer of already-mapped messages is refused. |
| D24 | `retry_after` handling is mandatory everywhere. |
| D25 | Tests never talk to a real database: repositories are covered through the in-memory store; Drizzle schema is compile-checked only. |
| D26 | All bot messages (dialog, announce, reports) use the initiator's locale (`language_code` or the `/settings` switch). The thread URL is appended verbatim and is not localized. |
| D27 | Placeholder format is exact: `[poll] {question}`, `[service] {service_event_type}`, `[unsupported] {content_type}` — type tokens are fixed ASCII, never localized; the summary is the raw Telegram value. When placeholders were used, the closing message gets an extra line "N messages replaced by placeholders". |
| D28 | The partial-deletion report (D12) is sent as a reply into the created thread. |
| D29 | When `forward_origin` has no chat (hidden sender), the source-chat buttons are shown without preselection. |
| D30 | Invalid title → the bot asks again with a hint, the draft and its timeout stay. Dialog messages of the author are NOT deleted; only the forwarded batch is deleted. |
| D31 | Batch limit 50: the first 50 messages in forward order are taken, the rest are dropped and the bot warns in the threads chat with the dropped count. |
| D32 | If zero originals are matched (e.g. privacy mode is on), the thread stays and the report says that no originals were found to delete. |
| D33 | The threads chat must differ from a source chat; reconnecting chats in `/settings` never affects already created threads. |
| D34 | Duplicate protection: if a matched original is already mapped to a thread, the bot refuses and replies with a link to the existing thread (message + link, no side effects). |
| D62 | `c/{chat_id}` uses the Telegram chat id with the `-100` (supergroup/channel) or `-` (basic group) prefix stripped. [resolves OQ-A] |
| D63 | Title length is measured in Unicode code points after trim. [OQ-B, R19] |
| D64 | Batch truncation works on entity granularity: an album is one entity; entities are taken in order while the 50-message budget holds; the entity that would cross the boundary is dropped with the rest. [OQ-C, D31/D41] |
| D65 | The duplicate check runs at transfer start over the whole batch: if any message is already mapped, the whole batch is refused with a link to the first existing thread. [OQ-D] |
| D66 | Source-chat preselection happens only when the `forward_origin` chat is connected and is not the threads chat; otherwise the buttons are shown without preselection. [OQ-E] |
| D67 | The transfer starts immediately once the chat is picked and a valid title is given; there is no confirmation step. [OQ-F] |
| D68 | FINAL wording (supersedes both earlier versions; the user's D16 answer is authoritative). While a draft is open, new forwards from the same author join the draft batch (any chat; timeout stays anchored to draft creation, D43). If the batch spans several source chats, the dialog is re-rendered (new dialog message, chat selection cleared) and D16 applies at completion: exactly one chat is picked, only its messages transfer, the rest are rejected with a warning (D73). A forward from an unconnected chat is refused and leaves the draft untouched (D84). |
| D69 | When a batch spans several forum topics of the source chat, the announce goes to the topic of the first message of the batch. [OQ-H] |
| D70 | The threads chat can be reconnected in `/settings`; existing threads are unaffected (D33). [OQ-K] |
| D71 | Contract §7 is extended: `src/health.ts` exports `healthCheck(deps)` and `readyCheck(deps): Promise<{ status: number; body: string }>` plus `createHealthServer(deps)` for production wiring; tests call the check functions directly. [OQ-L] |
| D72 | Only the exact strings recorded in docs/spec/decisions.md are normative; other user-facing strings are free-form but must use i18n keys present in both catalogs. Exact-string assertions use the `en` locale. [OQ-M] |
| D73 | The mixed-batch dialog message states how many messages from other chats will be ignored (wording free-form per D72). [OQ-I] |
| D74 | The partial-deletion report groups results by class: `deleted`, `not_found`, `forbidden`, `failed`, each with a count. [OQ-J] |
| D75 | User content is always sent as plain text: `parse_mode` is never used, links are plain URLs (no HTML/Markdown injection surface). [SEC-6] |
| D76 | `createBot` installs `bot.catch(...)` so `handleUpdate` never throws on malformed updates. [SEC-15] |
| D77 | `callback_data` is a short ASCII string that embeds the numeric chat id (e.g. `set:connect:{chat_id}`, `dlg:chat:{chat_id}`); tests locate buttons by the chat id substring. |
| D78 | `retry_after` waiting uses a promise-based delay around `setTimeout`; tests control it with vitest fake timers (never real timers). [OQ-QA-5] |
| D79 | `/settings` chat discovery: the bot stores chats it observes (`my_chat_member` and message updates) and lists those where its membership is admin. [OQ-QA-7] |
| D80 | `ADMIN_IDS` parsing: entries are trimmed, empty entries ignored; any non-numeric entry fails config load (fail-closed). The `1,,2` case in SEC-12 is aligned to this by security-engineer. [OQ-QA-1] |
| D81 | Update fixture shapes used by tests/acceptance/harness.ts (forward-origin superset with chat, `service_event_type`, callback tokens) are the de-facto contract; production must accept exactly these update shapes. Scenario S63's missing "Given" is covered by them. [OQ-QA-2, OQ-QA-4] |
| D82 | Where a written test contradicts D62–D81, the plan decision wins and the owning role aligns its test explicitly (that is a spec fix, not a weakening). |
| D83 | Error→class mapping for the partial-deletion report (D74): Telegram "message to delete not found" → `not_found`, 403 → `forbidden`, any other error → `failed`. |
| D84 | The D68-recreate rule applies to a forward from a DIFFERENT CONNECTED source chat; a forward from an unconnected chat is refused per AC16/S19 regardless of draft state and leaves the draft untouched. S83's "Other Chat" is therefore a second connected source chat. |
| D85 | Runtime wiring: `src/index.ts` builds the store from `DATABASE_URL` (pg pool + Drizzle-backed Store); `InMemoryStore` stays test-only. The Drizzle store is compile-checked only per D25 (no DB in tests) — a known, accepted gap. |
| D86 | Webhook mode (D15) serves updates via grammY `webhookCallback` and validates `X-Telegram-Bot-Api-Secret-Token` against `webhookSecret` (R56); invalid/missing secret → 401/403, no update handling. |
| D87 | Iteration 2 (user bug report: the thread never formed). Thread-body messages (copies, placeholders, closing message, failure report) are sent as REPLIES to the thread root message (`reply_parameters.message_id = root_id` — the first bot message with the title). `message_thread_id` is not used for thread assembly (ignored outside forum topics) and remains only for the source-chat announce when the source is a forum (D18/D69). AMENDS D5/D9. |
| D88 | Albums are copied per item via `copyMessage` with reply to the root: contiguous and in source order (S44/S45), but media-group grouping is intentionally lost — `copyMessages` cannot reply (Bot API limitation, confirmed in grammY types). Grouping to be restored later via MTProto (mtcute). Chosen by the user over "album intact but outside the thread". |
| D89 | Iteration 3 (user bug report: `t.me/c/4327410333` in the closing message does not open). A bare `t.me/c/{chat_id}` is not a valid Telegram link (message id is mandatory) — D62's closing-link format is dropped. The closing message's "moved from" link points to the ANNOUNCE message in the source chat: `https://t.me/c/{internal_chat_id}/{announce_message_id}` (uniform for public and private chats; `internal_chat_id` = Telegram chat id with the `-100`/`-` prefix stripped per D62). To know the announce id, the announce is sent BEFORE the closing message (thread display order is unchanged: root, copies…, closing is still the last thread message). If the announce cannot be sent, the closing template `{title} — moved from {…}` is filled with the plain chat title (no link). AMENDS D7/D62. |

## 7. Test-facing contract (entry points the acceptance/security tests drive)

Tests are black-box: they build Telegram updates, feed them into the bot and assert on the API
calls recorded by the fake Bot API (`tests/helpers/fake-bot-api.ts`, see `AGENTS.md`). The
following entry points are fixed; `software-engineer` implements exactly these and may add
internal modules freely. Tests must not import anything else from `src/`.

1. `src/config.ts` — `loadConfig(env: Record<string, string | undefined>): AppConfig`
   (Zod-validated, throws on invalid env). Fields: `botToken`, `databaseUrl`, `adminIds: number[]`,
   `mode: "polling" | "webhook"`, `webhookUrl?`, `webhookSecret?`, `draftTimeoutMs` (default 900000),
   `batchLimit` (default 50).
2. `src/store/types.ts` — `Store` interface (chats, users, drafts, threads, thread_messages,
   source_messages per plan §2.4); `src/store/in-memory.ts` — `new InMemoryStore() implements Store`,
   no constructor arguments. Tests seed nothing through SQL; source messages get into the index
   only through updates the bot observes.
3. `src/bot/createBot.ts` — `createBot(deps: { store: Store; now: () => Date; logger: Logger; config: AppConfig }): Bot`
   returning a grammY `Bot` with all handlers registered (`/start`, `/settings`, `/cancel`, message
   and callback_query handlers). Tests attach the fake API with `bot.api.config.use(api.transformer)`,
   then `await bot.init()` and `await bot.handleUpdate(update)`.
4. The bot indexes every message it observes in connected source chats (that is how the
   `source_messages` index is filled), so acceptance tests "prepare" a transfer by first driving
   ordinary source-chat messages into the bot and then the forwarded batch.



## 8. Tasks

| task | owner | status | risk IDs | notes |
|---|---|---|---|---|
| T1 Bootstrap skeleton, deps, AGENTS.md profile | devops-sre | done | — | `npm test` 7 passed, `npm run typecheck` clean; fake Bot API harness in `tests/helpers/`; profile in `AGENTS.md`; smoke tests stay in `tests/helpers/` (permissions) |
| T2 Goals, business risks, acceptance criteria (RBT) | product-manager | done | — | 16 business risks R1–R16, brief + AC1–AC17, OQ-1..OQ-8 resolved as D26–D34 |
| T3 Technical risks, complete risk register (RBT) | qa-engineer | done | — | 31 technical risks R17–R47; top: R17/R18 matcher ambiguity, R19 title validation, R33 root_id plumbing |
| T4 Threat model, security risks, red security tests | security-engineer | done | R48–R61 | 19 threats, 16 red SEC tests (failing on missing modules — expected); ran parallel with T5 |
| T5 Feature scenarios (Gherkin) + spec decisions | business-analyst | done | R1–R47 | 82 scenarios S1–S82 in 9 feature files; decisions D35–D61; OQ-A..OQ-M resolved as D62–D77 |
| T6 Red acceptance tests from scenarios | qa-engineer | done | — | 82 tests = 82 scenarios, all red (ERR_MODULE_NOT_FOUND), typecheck clean; alignment pass with D62–D82 |
| T7 Implementation TDD <-> PBT | software-engineer | done | R17–R47 | 36+ unit/PBT tests; S6/S7/S32/S83 green; PgStore + webhook (D85/D86); 198/198 green, typecheck clean |
| T8 Build/deploy changes (Dockerfile, Helm) | devops-sre | done | — | Dockerfile, drizzle.config.ts, migrations, helm chart (helm lint 0 failed); docker build not run (daemon unavailable) |
| T9 Security review + scans | security-engineer | done | R48–R61 | 0 Critical/High; SEC-F1/F2 fixed+mitigated; SEC-F3..F6 accepted (dev-only esbuild, unverified docker build); statuses updated |
| T10 QA gate + verdict | qa-engineer | done | — | **PASS** (docs/qa/verdict.md): clean run 207/207, S1–S83 ↔ 83 tests 1:1, strings/constraints verified, no open High/Critical security findings; non-blocking leftovers QA-R1..QA-R4 recorded |

## Iteration 2 — thread formation fix (D87/D88, user-reported bug)

| task | owner | status | risk IDs | notes |
|---|---|---|---|---|
| I2-1 Risk R62 + red acceptance updates (reply-to-root assertions) | qa-engineer | done | R62 | 31 red tests, right reason; realignments logged |
| I2-2 Scenario updates (copies = replies to the title message) | business-analyst | done | R62 | D87/D88 recorded; D5/D9/D44 superseded; 15 scenarios tagged @R62 (QA-R5 closed) |
| I2-3 Implement reply-to-root (TDD) | software-engineer | done | R62 | reply_parameters on every body post; albums per item; UNIT-22 + UNIT-23 (PBT 200 runs, QA-R6 closed) |
| I2-4 QA gate (incl. light security sanity) | qa-engineer | done | — | **PASS**: clean run 212/212, R62 covered, S1–S83 1:1, strings/constraints verified |
| I2-5 Redeploy vps-se | devops-sre | done | — | rebuilt app, db untouched, /health /ready ok, polling confirmed via NET I/O, no token in logs |

## Iteration 3 — closing-message link fix (D89, user-reported bug)

| task | owner | status | risk IDs | notes |
|---|---|---|---|---|
| I3-1 Risk R63 + red acceptance updates (closing link = announce message) | qa-engineer | done | R63 | 8 red tests + S84 (fallback); S36 Basic-Group row fixed at gate (author-admin seeding, D4/D82) |
| I3-2 Scenario updates (closing links to the announce) | business-analyst | done | R63 | D89 recorded; D7/D62 amended; @R63 tags added |
| I3-3 Implement announce-link closing (TDD) | software-engineer | done | R63 | announceMessageLink/movedFromValue; announce before closing; S84 fallback; UNIT-24 + UNIT-25 (PBT 200 runs) |
| I3-4 QA gate | qa-engineer | done | — | **PASS**: clean run 219/219 (84 acceptance S1–S84, 16 security, 112 unit, 7 smoke), R63 covered |
| I3-5 Redeploy vps-se | devops-sre | done | — | rebuilt app, db untouched, /health /ready ok, no token in logs |

## Ops (2026-10-29): CI + push

| task | owner | status | risk IDs | notes |
|---|---|---|---|---|
| CI workflow (test + docker + helm jobs) | devops-sre | done | — | `.github/workflows/ci.yml`, Node 26, push/PR to main |
| Prepare repo (README, .env.example, .gitignore) + secret scan | devops-sre | done | — | scan clean: no real secrets in tracked files |
| Commit + push to origin/main | devops-sre | done | — | `153fae0` (98 files), push verified: `6bb7e2d..153fae0 main -> main` |
