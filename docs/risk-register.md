# Risk register

Maintained by: `product-manager` (business risks), `qa-engineer` (technical risks),
`security-engineer` (security risks).

Format: `ID | risk | L | I | score | mitigation (test IDs)` (L, I = 1..3; score = L×I;
high ≥ 6, medium 3–4, low ≤ 2). Table columns exactly:
`ID | risk | L | I | score | mitigation (test IDs) | status`.

**Numbering rule:** IDs are global and sequential across the whole register. `product-manager`
starts at **R1** (business/product risks below); `qa-engineer` and `security-engineer` **continue
the numbering** (R17, R18, …) in their own sections — never restart at R1, never renumber.

Test ID conventions (IDs are stable; test writers create the tests under these IDs and mark them
`planned` until they exist):

- `ACC-n` — black-box acceptance scenarios/tests (`tests/acceptance/**`), 1 scenario ↔ 1 test.
- `SEC-n` — security/abuse-case tests (`tests/security/**`).
- `UNIT-n` — unit and property-based tests (`tests/unit/**`, fast-check).

Test depth follows the score: high — scenario + unit + property; medium — scenario + unit;
low — at least one scenario or unit test.

## Business / product risks (product-manager, T2)

| ID | risk | L | I | score | mitigation (test IDs) | status |
|---|---|---|---|---|---|---|
| R1 | Originals deleted although thread copies failed or are missing → irreversible message loss | 2 | 3 | 6 | create-before-delete invariant (AC14), failure injection on copy step: ACC-1, property "no source delete before full copy": UNIT-1 | covered |
| R2 | Heuristic original matching (D21) hits the wrong message → wrong originals deleted in source chat | 2 | 3 | 6 | matcher collision/ambiguity scenarios (identical date+sender+hash), property "matched ⇒ unique or none deleted": ACC-2, UNIT-2 | covered |
| R3 | Non-admin initiates a transfer or changes settings → unauthorized deletion of users' messages | 2 | 3 | 6 | authz checks at every entry point (dialog, transfer, `/settings`): ACC-3, SEC-1 | covered |
| R4 | Announce link wrong or broken (bad chat path/root id) → thread unfoundable, core value lost | 2 | 2 | 4 | link-builder table tests (username vs `c/{id}`), announce format scenario: ACC-4, UNIT-3 | covered |
| R5 | Partial failure (flood, one delete fails) leaves chats inconsistent with no clear user report | 2 | 2 | 4 | partial-failure scenario asserting AC5 report content and kept thread: ACC-5 | covered |
| R6 | Wrong source chat chosen/preselected (hidden forwards) → wrong attribution, wrong chat targeted | 2 | 2 | 4 | mixed-batch and hidden-forward dialog scenarios, preselection rule: ACC-6 | covered |
| R7 | Duplicate transfer not detected (mapping missing) → second thread, double announce, re-deletes | 2 | 2 | 4 | re-transfer refusal scenario (AC15) + mapping round-trip property: ACC-7, UNIT-4 | covered |
| R8 | Thread content/order wrong: albums split, order scrambled, placeholders or closing incorrect | 2 | 2 | 4 | album grouping/order scenarios, thread-plan builder properties: ACC-8, UNIT-5 | covered |
| R9 | Dialog confusion/annoyance: foreign replies accepted, timeout/cancel unclear → users abandon | 2 | 2 | 4 | forward-author-only, `/cancel`, 15-min timeout scenarios: ACC-9 | covered |
| R10 | Telegram limits/flood (429, `retry_after`) → long waits, split deletes, partial state confusing | 2 | 2 | 4 | 429/retry_after injection, `deleteMessages` ≤ 100 batching: ACC-10, UNIT-6 | covered |
| R11 | Bot loses admin rights or privacy mode left on → matching/deletes fail with unclear behaviour | 2 | 2 | 4 | lost-rights and unindexed-messages scenarios with clear localized error: ACC-11, SEC-2 | covered |
| R12 | Mixed-language output (announce/errors in wrong locale) confuses users of a message-deleting bot | 2 | 2 | 4 | locale-selection scenarios (ru/en) + no-hardcoded-strings check: ACC-12, UNIT-7 | covered |
| R13 | Announce posted in wrong forum topic (`message_thread_id` lost) → topic's audience misses it | 2 | 2 | 4 | forum-source scenario asserting announce keeps the topic: ACC-13 | covered |
| R14 | >50 truncation or mixed-batch warning missed by user → some messages silently left behind | 2 | 1 | 2 | truncation/mixed-batch warning content scenarios: ACC-14 | covered |
| R15 | Copies carry no author attribution → readers misread who said what, disputes in source chat | 1 | 2 | 2 | scenario asserting bot-message copies + closing context message: ACC-15 | covered |
| R16 | Title edge cases (empty, >255, whitespace, unicode) accepted wrongly or rejected confusingly | 2 | 1 | 2 | title-validation property over generated edge strings: UNIT-8 | covered |

## Technical risks (qa-engineer, T3 — append here, continue numbering at R17)

| ID | risk | L | I | score | mitigation (test IDs) | status |
|---|---|---|---|---|---|---|
| R17 | Forwarded message matches two originals: same sender, second and content hash → wrong original deleted | 2 | 3 | 6 | same-second identical-content collision scenario, property "ambiguous ⇒ nothing deleted": ACC-17, UNIT-10 | covered |
| R18 | Matcher not scoped per chat: identical messages in different source chats cross-match → wrong originals deleted | 2 | 3 | 6 | multi-chat identical-content scenario, chat-scoped matcher property: ACC-17, UNIT-10 | covered |
| R19 | Title validation edge cases: UTF-16 vs code-point length, whitespace/control chars, emoji/RTL at 255/256 boundary misjudged | 3 | 2 | 6 | title boundary/emoji/RTL/control-char scenarios, generated-string title property: ACC-23, UNIT-13 | covered |
| R20 | Album (`media_group_id`) updates arrive split, interleaved or out of order → wrong grouping in thread | 2 | 2 | 4 | album split/interleaved-arrival scenarios, grouping+order property: ACC-16, UNIT-9 | covered |
| R21 | Album copied message-by-message loses contiguous order in the thread | 2 | 2 | 4 | album copy-order scenario, thread-plan order property: ACC-16, UNIT-5 | covered |
| R22 | Forward-date second precision mismatch or collision → originals unmatched and never deleted | 2 | 2 | 4 | same-second/precision matching scenarios, date-normalization property: ACC-18, UNIT-18 | covered |
| R23 | Originals already deleted before transfer → delete calls fail mid-batch, state unclear | 2 | 2 | 4 | missing-originals scenario keeping thread (AC5), failure-accounting property: ACC-18, UNIT-21 | covered |
| R24 | `edited_message` updates ignored → stale content hashes → edited originals unmatched | 2 | 2 | 4 | edited-after-index scenario, matcher property over edits: ACC-18, UNIT-10 | covered |
| R25 | `forward_origin` variants (hidden_user, channel, saved) misparsed → wrong source chat preselected | 2 | 2 | 4 | origin-variant scenarios incl. D29 no-preselection, origin parsing property: ACC-19, UNIT-19 | covered |
| R26 | 50-message batch limit counts entities vs messages wrongly → albums split or overflow taken | 2 | 2 | 4 | truncation-counting scenarios (album at limit), batch-cap property: ACC-32, UNIT-9 | covered |
| R27 | Deletion id list over 100 sent unsplit → Telegram rejects, transfer stuck mid-deletion | 2 | 2 | 4 | >100-id deletion scenario, chunking property (≤100, no loss/dup): ACC-21, UNIT-11 | covered |
| R28 | `retry_after` mid-deletion ignored or busy-retried → flood waits, partial deletion | 2 | 2 | 4 | retry_after injection scenario, batching property honouring retry_after (D24): ACC-21, UNIT-11 | covered |
| R29 | Per-message deletion failures not aggregated → partial-failure report counts wrong, user misled | 2 | 2 | 4 | partial-failure report content scenario (AC5), failure-accounting property: ACC-5, UNIT-21 | covered |
| R30 | Two concurrent drafts by the same author overwrite each other's dialog state | 2 | 2 | 4 | double-draft scenario, FSM robustness property: ACC-22, UNIT-12 | covered |
| R31 | Interleaved dialogs of two authors route answers to the wrong draft | 2 | 2 | 4 | interleaved-authors scenario, FSM robustness property: ACC-22, UNIT-12 | covered |
| R32 | Timeout fires while a valid answer is processed → double reply or half-state | 2 | 2 | 4 | timeout-vs-answer race scenario, FSM property (single defined outcome): ACC-24, UNIT-12 | covered |
| R33 | Thread root id assumed when title send fails; `?thread=` link must equal root_id | 2 | 2 | 4 | root-plumbing scenario incl. title-send failure, link property `?thread=`==root_id: ACC-25, UNIT-14 | covered |
| R34 | Source chat link built from username breaks when username renamed or lost | 2 | 2 | 4 | link-format scenarios (`{username}` vs `c/{chat_id}`), link builder property: ACC-26, UNIT-14 | covered |
| R35 | Forum source: `message_thread_id` dropped on deletes or announce → announce in wrong topic | 2 | 2 | 4 | forum-topic scenario (AC4), thread-id propagation property: ACC-13, ACC-27, UNIT-20 | covered |
| R36 | Batch spans several forum topics → announce target topic undefined or wrong | 2 | 2 | 4 | multi-topic batch announce scenario, propagation property: ACC-27, UNIT-20 | covered |
| R37 | Bot demoted or blocked mid-flow → 403 errors crash handlers, no report | 2 | 2 | 4 | demotion injection at each step, create-before-delete invariant (AC14): ACC-28, UNIT-1 | covered |
| R38 | Duplicate protection false positive: identical but unmapped messages wrongly refused as duplicates | 2 | 2 | 4 | duplicate scenarios (refusal + link, no side effects), mapping property: ACC-29, UNIT-4 | covered |
| R39 | `MODE=webhook` without `WEBHOOK_*` config starts broken or unauthenticated | 2 | 2 | 4 | webhook config refusal scenario, env parsing property: ACC-31, UNIT-17 | covered |
| R40 | `ADMIN_IDS` or env parsing wrong (spaces, empties, non-numeric) → boot crash or wrong admin set | 2 | 2 | 4 | config scenarios, env parsing property (typed error, never crash): ACC-31, UNIT-17 | covered |
| R41 | Unknown content type missing from placeholder handling crashes the copy step mid-thread | 2 | 2 | 4 | placeholder exactness + unknown-type scenarios (D27), placeholder property: ACC-20, UNIT-15 | covered |
| R42 | Crash between thread creation and mapping persistence → orphan thread, duplicate transfer on retry | 1 | 3 | 3 | interrupted-flow scenario (crash between steps), mapping round-trip property: ACC-29, UNIT-4 | covered |
| R43 | Replies inside the forwarded batch copy with dangling references or crash the copier | 1 | 2 | 2 | reply-in-batch scenario, copy-plan unit: ACC-20, UNIT-5 | covered |
| R44 | Foreign or stale callback queries throw unhandled errors or stick the dialog | 2 | 1 | 2 | foreign/stale callback scenario (no state change): ACC-22 | covered |
| R45 | `/cancel` without a draft or by a non-author errors instead of harmless reply | 2 | 1 | 2 | `/cancel` edge scenarios (D17): ACC-22 | covered |
| R46 | en/ru catalog keys drift apart → raw message ids shown to users | 2 | 1 | 2 | catalog parity scenario + parity property: ACC-30, UNIT-16 | covered |
| R47 | Unknown `language_code` without fallback → crash or untranslated output | 2 | 1 | 2 | locale fallback scenario (default `en`, D19): ACC-30 | covered |
| R62 | Thread-body messages not attached to the root reply (`message_thread_id` ignored in plain groups) → thread and `?thread=` link broken | 3 | 3 | 9 | every thread-body message (each copy, each placeholder, the closing message, the failure report) asserted as a reply to the thread root (`reply_parameters.message_id`/`reply_to_message_id` == root_id, D87; never `message_thread_id`): ACC-8, ACC-20, ACC-25 (S34–S41), ACC-15, ACC-16, ACC-8 (S42–S48), ACC-8, ACC-18 (S49/S50, S52/S53, S56–S59, S63); albums copied per item, contiguous, in source order, each a reply to the root (D88): ACC-16 (S44/S45); thread membership by reply chain (S33); property "every thread-body call names root_id, albums per item": UNIT-22, UNIT-23 | covered (I2-3/I2-4: UNIT-22/23 green, acceptance realigned) |
| R63 | Closing-message source link is unresolvable (bare `t.me/c/{id}`) → user cannot navigate back to the source chat | 3 | 2 | 6 | D89: the closing link is the ANNOUNCE message link `https://t.me/c/{internal_chat_id}/{announce_message_id}` (uniform public/private; announce sent BEFORE the closing; fallback to the plain chat title without a link when the announce cannot be sent). Exact-link + order assertions: ACC-33 (S34/S36/S37 exact closing texts with the stubbed announce id 42 and the `-100…`/`-` stripped chat id — S36 rows incl. the basic-group QA row; S26 trimmed-title closing; S50 "closing after the announce" + "closing links to the announce message"); fallback scenario: ACC-34 (S84); link-builder unit + property (link embeds exactly the announce id and the stripped chat id, never a bare `t.me/c/{id}`/`t.me/{username}`; fallback never contains a URL): UNIT-24, UNIT-25 | covered (I3-3/I3-4: UNIT-24/25 green in tests/unit/closing-link.test.ts, ACC-33/ACC-34 green; clean run 219/219) |

### New planned test IDs introduced by T3 (continue global numbering; do not renumber)

> **T10 QA gate update (2026-10-29).** All mitigation IDs in the business (R1–R16) and technical
> (R17–R47) tables above are realized and green.
> `ACC-n` landed as the acceptance scenarios **S1–S83** (1:1 scenario↔test mapping verified at the
> gate; mapping blocks in `tests/acceptance/**`). `UNIT-n` landed as unit/property tests where
> present (`tests/unit/*`: config=UNIT-17, deletion=UNIT-6/11/21, draft-batch=UNIT-12,
> store-contract=UNIT-4 oracle property, pg-store row round-trips, boot-failure, webhook,
> transfer-audit-log). Planned UNIT property tests **not** separately realized (UNIT-1/2/3/5/8/9/
> 10/13/14/15/16/18/19/20) are recorded as accepted residual depth gap **QA-R1** in
> `docs/qa/verdict.md`; the risks they were planned for are covered by the scenario layer
> (plus SEC-14/SEC-15 for matcher/fuzz cases). Statuses set to `covered` accordingly.

- `ACC-16` album split/interleaved across updates → grouped, source order preserved · `ACC-17` matcher
  collisions (same second/content, cross-chat) → nothing wrongly deleted · `ACC-18` missing/edited
  originals and zero matches (D32) → thread kept, accurate report · `ACC-19` `forward_origin` variants →
  source choice + preselection (D29) · `ACC-20` replies, placeholders (D27) and unknown content → exact
  strings, no crash · `ACC-21` >100-id deletion batching + `retry_after` mid-loop · `ACC-22` dialog FSM
  abuse (double drafts, two authors, foreign callbacks, `/cancel`) · `ACC-23` title edge strings
  (255/256, whitespace, emoji, RTL, control) per AC17 · `ACC-24` timeout-vs-answer race at 15 min ·
  `ACC-25` root_id plumbing (`?thread={root_id}`, title-send failure aborts) · `ACC-26` link formats
  `{username}` vs `c/{chat_id}`, username renamed/lost · `ACC-27` forum multi-topic batch announce ·
  `ACC-28` bot demoted/blocked mid-flow → AC14 holds, localized failure · `ACC-29` D34 duplicate
  false-positives + mapping persistence crash · `ACC-30` en/ru key parity + locale fallback · `ACC-31`
  config: invalid env/`ADMIN_IDS`, `MODE=webhook` without `WEBHOOK_*` · `ACC-32` 50-limit counts
  messages, never splits albums.
- `UNIT-9` media-group grouping + batch-cap property · `UNIT-10` matcher: one forward ⇒ ≤1 original,
  ambiguous/zero ⇒ none deleted · `UNIT-11` delete chunking ≤100, no loss/duplication · `UNIT-12` FSM
  robustness over arbitrary event sequences · `UNIT-13` title validation over generated unicode edges ·
  `UNIT-14` link builder, `thread` param == `root_id` · `UNIT-15` placeholders exact (D27), unknown
  types never crash · `UNIT-16` i18n catalog parity, all ids resolve · `UNIT-17` env parsing: valid or
  typed error, never crash · `UNIT-18` forward-date second-precision normalization · `UNIT-19`
  `forward_origin` parsing: correct source or none · `UNIT-20` `message_thread_id` propagation on all
  source-chat sends · `UNIT-21` failure accounting matches actual API call outcomes.

### New planned test IDs introduced by I2-1 (continue global numbering; do not renumber)

> Iteration 2 (thread formation fix, D87/D88). R62 above continues the global numbering after the
> security section (R48–R61). All IDs below are **planned** until I2-3 lands them.

- `UNIT-22` unit: every thread-body send path (copy, placeholder, closing, failure report) sends a
  reply to the root (`reply_parameters.message_id`/`reply_to_message_id` == root_id) and never uses
  `message_thread_id` for thread assembly; the source-chat announce of a forum source keeps
  `message_thread_id` (D18/D69, unchanged); album copies are per item (D88).
- `UNIT-23` property (fast-check, fixed seed): over generated batches (mixed content incl. albums,
  split/out-of-order arrival), every thread-body call names root_id and carries no
  `message_thread_id`; album items are posted per item, contiguous and in source order (D88);
  the `?thread=` link equals root_id.

> **I2-4 QA gate update (2026-10-29).** I2-3 landed: `UNIT-22`/`UNIT-23` realized in
> `tests/unit/thread-assembly.test.ts` and green (fixed seed 20261029); acceptance realignments
> ("Alignment pass 4") green. **R62 status → `covered`** (mitigation tests all passing; clean run
> 212/212). Feature scenarios still lack `@R62` tags — traceability is via the mitigation column
> and the `S → ACC → R` mapping blocks (non-blocking nit QA-R5).

### New planned test IDs introduced by I3-1 (continue global numbering; do not renumber)

> Iteration 3 (closing-link fix, D89; risk R63 above). The acceptance updates
> (`ACC-33`, `ACC-34`) are red until I3-3 lands the announce-before-closing order and the
> announce-link closing template; `UNIT-24`/`UNIT-25` are **planned** for `software-engineer`.

- `ACC-33` D89 closing-link correctness: the announce is sent BEFORE the closing message and the
  closing link equals `https://t.me/c/{internal_chat_id}/{announce_message_id}` exactly (S34/S36/
  S37/S26 exact closing texts with the stubbed announce id 42, S36 stripped-chat-id rows for
  `-100…` and `-` id shapes; S50 order + link-embeds-the-announce-id steps).
- `ACC-34` D89 fallback: when the announce cannot be sent, the closing message is still sent, is a
  reply to the root and carries the plain chat title with no link (S84).
- `UNIT-24` unit: closing-link builder per D89 — `https://t.me/c/{internal_chat_id}/
  {announce_message_id}` for public and private chats and both id shapes (`-100…`/`-` prefix
  stripped per D62); on announce-send failure the closing template is filled with the plain chat
  title and no URL.
- `UNIT-25` property (fast-check, fixed seed): over generated chat ids and announce ids, the
  closing link embeds exactly the stripped chat id and the announce message id — never a bare
  `t.me/c/{id}` and never `t.me/{username}` — and the fallback variant never contains a URL.

> **I3-4 QA gate update (2026-10-29).** I3-3 landed the D89 implementation: `UNIT-24`/`UNIT-25`
> realized in `tests/unit/closing-link.test.ts` and green (fixed seed 20261029, 200 runs);
> `ACC-33`/`ACC-34` green after one QA-side seeding fix in S36's Basic Group row (author admin
> membership per D4/SEC-1 — see `docs/qa/open-questions.md`, alignment pass I3-4; no assertion
> touched). **R63 status → `covered`** (mitigation tests all passing; clean run 219/219).

## Security risks (security-engineer, T4 — append here, continue numbering after technical)

Threat model: `docs/security/threat-model.md` (STRIDE + OWASP; threat IDs T-* map to these rows).
`SEC-n` tests live in `tests/security/**`; SEC-1 (planned under R3) and SEC-2 (planned under R11)
keep their original meanings — the numbering continues at SEC-3.

| ID | risk | L | I | score | mitigation (test IDs) | status |
|---|---|---|---|---|---|---|
| R48 | Non-admin initiates transfer → unauthorized deletion of others' messages in source chat | 2 | 3 | 6 | source-chat-admin check before any transfer step, refusal with no side effects: SEC-1 | mitigated (SEC-1 green; code `isSourceAdmin` gate, createBot.ts:488) |
| R49 | Non-global-admin invokes /settings or forges settings callbacks → chats silently reconnected | 2 | 3 | 6 | ADMIN_IDS check on command and callback, no admin UI for outsiders: SEC-3 | mitigated (SEC-3 green; `isGlobalAdmin` on command + both callback kinds) |
| R53 | Oversized batches or callback floods exhaust CPU/flood budget → stuck transfers, DoS | 3 | 2 | 6 | batch cap 50, delete chunking ≤ 100 ids, bounded work on any input: SEC-10, SEC-15 | mitigated (SEC-10/15 green; residual unbounded draft batch: SEC-F5 accepted) |
| R54 | Matcher cross-chat/same-second collisions delete innocent originals in another chat | 2 | 3 | 6 | matcher scoped to chosen chat, ambiguous ⇒ nothing deleted: SEC-14 | mitigated (SEC-14 green; matcher chat-scoped, unique-or-none) |
| R55 | BOT_TOKEN/DATABASE_URL reach logs or replies (grammY errors embed token URL) | 2 | 3 | 6 | sanitized error logging, no config dumps, secret-marker scan: SEC-8, SEC-9 | covered (SEC-8/9 green + secret scan clean; boot-path gap SEC-F2 fixed in T7 follow-up — `src/boot-report.ts`, pinned by tests/unit/boot-failure.test.ts) |
| R56 | MODE=webhook without secret validation accepts forged updates → arbitrary deletions | 2 | 3 | 6 | fail closed without WEBHOOK_URL and non-empty WEBHOOK_SECRET: SEC-11 | mitigated (SEC-11 green; transport check timing-safe, reviewed T9) |
| R50 | Forged/stale callback queries manipulate another user's draft or crash handlers | 2 | 2 | 4 | author check on callbacks, hostile payloads inert, no crash: SEC-4, SEC-5 | mitigated (SEC-4/5 green; drafts keyed by author, foreign callbacks inert) |
| R51 | Replayed updates re-run a transfer → double deletions, double announce | 2 | 2 | 4 | duplicate protection refuses mapped messages with zero side effects: SEC-7, SEC-15 | mitigated (SEC-7/15 green; duplicate check before any side effect) |
| R52 | Malicious title/text renders as markup → spoofed links, mention spam, layout corruption | 2 | 2 | 4 | user content plain data: no parse_mode/entities on attacker text: SEC-6 | mitigated (SEC-6 green; grep: no parse_mode/entities in src/) |
| R57 | Malformed ADMIN_IDS parsed loosely → wrong admin set, privilege escalation | 2 | 2 | 4 | fail-closed Zod validation, safe-integer ids, typed errors: SEC-12, SEC-9 | mitigated (SEC-12 green; config.ts:47-62 fail-closed, no partial sets) |
| R59 | Stored XSS-like payloads in DB re-rendered as markup in later messages | 2 | 2 | 4 | data-not-markup rule on every render path: SEC-6 | mitigated (SEC-6 green; all render paths plain-text) |
| R60 | Chat impersonation: unconnected chat the bot sits in gets indexed or processed | 2 | 2 | 4 | connection check before indexing and transfer, unconnected = inert: SEC-13 | mitigated (SEC-13 green; index writes only for connected source chats) |
| R61 | Destructive transfers not audited → initiator can deny who ordered deletions | 2 | 2 | 4 | structured logs with actor/chat/thread/deleted ids, secret-free: SEC-8 | covered (SEC-F1 fixed in T7 follow-up — `transfer_completed` audit record with actor/chat/thread/deleted ids, pinned by tests/unit/transfer-audit-log.test.ts) |
| R58 | Dev-only dependency vulns (drizzle-kit→esbuild ≤0.24.2, GHSA-67mh-4wv8-2f99) | 2 | 1 | 2 | npm audit gate in CI, dev-only chain, no runtime exposure (T9 report) | accepted (SEC-F3: chain ships in image but vulnerable dev-server path never runs; audit gate stays) |

### New planned test IDs introduced by T4 (continue global numbering; do not renumber)

All are **red** until T7 (production modules `src/config.ts`, `src/store/in-memory.ts`,
`src/bot/createBot.ts` do not exist yet — tests fail per-test with "module missing", which is the
expected state; see `docs/security/threat-model.md` §8 for the property table).
**T10 update (2026-10-29): SEC-1..SEC-15 all green (16 tests).**

- `SEC-1` non-admin transfer refused, nothing deleted (admin positive control) · `SEC-2` demotion
  mid-transfer fails safe, no internals/secrets in replies · `SEC-3` non-global-admin `/settings`
  + forged settings callbacks inert · `SEC-4` forged callback from another user cannot touch the
  draft · `SEC-5` hostile callback payloads inert (injection, oversized, stale, missing fields) ·
  `SEC-6` markup-laden title/text delivered as data (no `parse_mode`/`entities`) · `SEC-7` replayed
  transfer refused: zero deletions, no second announce · `SEC-8` BOT_TOKEN/DATABASE_URL never in
  logs or chat output (happy + failure paths) · `SEC-9` config errors echo no secret values ·
  `SEC-10` 500-message batch capped at 50, `deleteMessages` ≤ 100 ids per call · `SEC-11`
  `MODE=webhook` fails closed without WEBHOOK_URL/WEBHOOK_SECRET · `SEC-12` malformed `ADMIN_IDS`
  fails closed (no partial admin sets) · `SEC-13` unconnected chat ignored: no index write, no API
  side effects · `SEC-14` matcher scoped per chat: identical twin originals survive · `SEC-15` fuzz
  (fast-check, fixed seed 20261028): any update → no crash, no destructive call, no secret leak.
