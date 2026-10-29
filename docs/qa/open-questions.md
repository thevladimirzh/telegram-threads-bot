# QA open questions (T6 — red acceptance tests)

Owner: `qa-engineer`. Date: 2026-10-28. Raised while writing `tests/acceptance/**`
from the 82 Gherkin scenarios (S1–S82). Authority order per the task: plan /
decisions win; nothing was silently picked where sources conflict — each item
records the provisional reading the tests use, so "yes, agreed" closes it.

## Resolutions (orchestrator, 2026-10-28) — alignment pass 2 (qa-engineer)

The orchestrator resolved the open questions as D78–D82 (docs/plan.md §6).
Per D82, tests that contradicted the plan were aligned explicitly — a spec fix,
not a weakening. Change log of this pass (only `tests/acceptance/**` touched):

| # | resolution | test change (file — what, why) |
|---|---|---|
| OQ-QA-1 | **D80**: entries trimmed, empty entries ignored (`"1,,2"` → `[1,2]`, so S11/D57 stands); any non-numeric entry fails config load (fail-closed). `tests/security` SEC-12 is aligned by `security-engineer` (not touched here). | `configuration.test.ts` — NOTE comment updated to cite D80; **no assertion changes** (S11/S12 already matched D80). |
| OQ-QA-2 / OQ-QA-4 | **D81**: harness fixture shapes are the de-facto contract and normative; S63 needs no extra "Given" (root id 42 convention covers it). | none — S63 and the harness fixtures stand as written. |
| OQ-QA-5 | **D78**: `retry_after` waits = promise-based delay around `setTimeout`; vitest fake timers are correct and normative. | none — S72/S73 kept exactly as written. |
| OQ-QA-6 | Normative: `healthCheck(deps)` / `readyCheck(deps)` with `deps: { store: Store; version?: string }` returning `Promise<{ status: number; body: string }>`; `readyCheck` pings the store. | `observability.test.ts` — `healthDeps` now returns exactly `{ store }` (ping attached as an own property of the `InMemoryStore` instance; superset `{ store, logger, ping, dbPing }` removed); S80/S81 additionally assert `body` is a string (contract return shape). |
| OQ-QA-7 | **D79**: `/settings` chat discovery = chats the bot observes (`my_chat_member` AND message updates stored as chats), filtered to those where the bot is admin. | `harness.ts` — convention 4 comment reworded (it claimed discovery keys on `my_chat_member` only); fixture superset unchanged. `cleanup-and-announce.test.ts` S54 and `thread-creation.test.ts` S36 — added the missing `botIsAdminOf([...])` discovery seed before connecting "Private Source Chat" (the tests connected a chat with zero observed updates, i.e. assumed a discovery mechanism beyond D79; matching the seed pattern already used in `dialog`/`failures-and-limits` backgrounds). |
| OQ-QA-8 | **D74** is normative: the partial-deletion report groups results by classes `deleted`, `not_found`, `forbidden`, `failed`, each with a COUNT. | `cleanup-and-announce.test.ts` — S56/S57/S58 now assert exactly this grouping (all four classes, each with its count) instead of the "1 of 3" wording. Class mapping used (forced by the injected errors, recorded here as the aligned interpretation): success → `deleted`; "message to delete not found" (400) → `not_found`; 403/Forbidden → `forbidden`; any other error ("Bad Request: oops") → `failed`. |
| OQ-QA-10 | **decided, keep** — S16 asserts "the first *user-visible* call is the dialog reply; only read-only `get*` calls may precede it"; "no other message is sent and nothing is deleted" is asserted literally. | none |
| OQ-QA-11 | **decided, keep** — S76: report part is conditional (a clean transfer produces no report, D54); if a report appears it must contain Cyrillic; dialog prompt, closing and announce asserted strictly. | none |
| OQ-QA-12 | **decided, keep** — state assertions are observed through finishing probes (after the scenario-ordered assertions are checked first). | none |

Notes for other roles (not touched here): OQ-QA-3 wording pinning stays with
`product-manager` (per OQ-M; D72 keeps non-listed strings free-form); SEC-12
(D80) and SEC-13 (note: D79 stores chats from message updates, so "zero store
writes on unconnected traffic" needs the D79 reading — listing is filtered by
admin membership) are `security-engineer`'s to align.

## Alignment pass 3 (qa-engineer, 2026-10-29) — D68 REVISED (draft batch join/recreate)

D68 was **revised** (plan §6): while a draft is open, a new forward from the
same author whose source chat matches the draft's chat **JOINS** the draft batch
(no new dialog message, no refusal); a forward from a different source chat
**RECREATES** the draft (batch = the new forward, title/chat cleared, a new
dialog message is posted). Change log of this pass (only `tests/acceptance/**`
touched):

| # | item | test change (file — what, why) |
|---|---|---|
| 1 | **S32 realigned** to the revised join semantics (scenario name: "A second forward from the same author joins the open draft"; `business-analyst` rewrites S32 in `tests/features/dialog.feature` in parallel). | `dialog.test.ts` — the old test required a refusal ("a dialog is already in progress") and a draft holding only the first batch. Now asserts, per the revised scenario: **no second dialog message** (all dialog messages share a single message id — an in-place edit of the dialog is not "a second dialog message"), **no refusal message** (detected semantically with `/already\|in progress\|refus\|reject\|ignor/i`, same style as `leaksRawError`; wording is free-form per D72), no thread/deletion side effects, and **the draft holds both messages** (completion probe: thread copies of 10 and 11 in source order). *Aligned interpretation recorded:* a short acknowledgement of the join (e.g. "Added to the batch: …") is permitted — D68's wording forbids a *new dialog message* and a *refusal*, not every reply. |
| 2 | **S83 added** — new scenario "A forward from another chat while a draft is open recreates the draft" (the D68 recreate branch); mapping block updated (`S83 -> ACC-22 -> R30`). | `dialog.test.ts` — "Other Chat" gets its D79 discovery signal via `botIsAdminOf` before `connectSource` (same seeding pattern as S54/S36) and the author is made its admin (D4). Observables per the brief: a **new** dialog message (a second, distinct dialog message id) asking for source chat (buttons incl. "Other Chat") and title, and the draft holding **only** msg 20 — completion afterwards transfers only 20 (`deletedIds("Other Chat") == [20]`, `deletedIds("Source Chat") == []`, thread copies contain 20 and not 10). **Status: RED** at "a NEW dialog message is posted" — the implementation currently joins unconditionally (no recreate branch); expected red for not-yet-implemented behaviour. **Owner: `software-engineer`** (per D82 the plan decision wins; the recreate branch is T7 work). |
| 3 | **S60 fixed** (OQ-QA-7/D79 class, same as S54/S36). | `cleanup-and-announce.test.ts` — the row connecting "Private Threads Chat" (any row whose chat has zero discovery signal) now seeds it first with `botIsAdminOf([threadsChat])` before `connectThreads`; `/settings` lists only observed chats where the bot is admin, so the row previously found no button at all. Also: the row's dialog runs in the row's threads chat, but `pickChat`/`completeDialog` were hardcoded to `CHATS.threads` — `harness.ts` gained an **additive optional `into` parameter** (default `CHATS.threads`; every existing caller is unchanged) and S60 passes `into: threadsChat`. **Exact-string assertions are unchanged** — both exact link rows (`https://t.me/threads_chat/42?thread=42`, `https://t.me/c/200000000000005/42?thread=42`) stay exact. |

Verification (2026-10-29, real output): `npm run typecheck` → exit 0 (clean);
`npm test` → `Tests 1 failed | 119 passed (120)`. The single failure is the new
S83 (expected RED — recreate not implemented). The 10 security-test failures
seen at the start of this pass were fixed in parallel by `security-engineer`
(`tests/security/**` not touched here).

## Alignment pass 4 (qa-engineer, 2026-10-29) — D87/D88: thread-body messages reply to the root

Iteration 2 (I2-1, user bug: the reply thread never forms). D87 supersedes the
old `message_thread_id`-based thread assembly (ignored outside forum topics —
that was the bug): every thread-body message (each copy, each placeholder, the
closing message, the failure report) is a REPLY to the thread root (the title
message, id 42; `reply_parameters.message_id` or `reply_to_message_id` — either
form accepted). D88: albums copied PER ITEM, contiguous, in source order, each
a reply to the root; media-group grouping intentionally lost (`copyMessages`
cannot reply). Risk **R62** added to `docs/risk-register.md` (3×3=9, high;
planned `UNIT-22`/`UNIT-23`; status `open` → `covered` after I2-3). Only
`tests/acceptance/**`, `docs/risk-register.md`, `docs/qa/**` touched. Exact-string
assertions untouched. Change log:

| # | item | test change (file — what, why) |
|---|---|---|
| 1 | **S34/S36/S37/S38/S39/S40/S41** — D87 reply-to-root made executable | `thread-creation.test.ts` — every thread-body post (copies, placeholders, closing, failure message) asserted as a reply to root 42 (new `expectBodyRepliesToRoot` over `bodyPostsSince`); S39's copy finder realigned (D87 body sends are replies; the legacy `message_thread_id` signature is still matched so the check never goes blind). Mapping blocks updated (`R62` added). |
| 2 | **S35 realigned** — old assembly assertion replaced (it encoded the bug) | `thread-creation.test.ts` — the old "every following message is posted with `message_thread_id` 42" loop (the D5/D9 reading D87 supersedes) is replaced by: root gets id 42, every body message replies to root, and **no message of the thread carries `message_thread_id`** (feature step, scoped to the threads chat — the forum announce keeps it, see #5). |
| 3 | **S42–S48** — "each copy is a reply to the title message" (D87) | `message-transfer.test.ts` — reply-to-root asserted for every body post incl. placeholders (S46) and the closing; S47's "no reply reference into the source chat" loop kept as-is (still valid). |
| 4 | **S44/S45 realigned to D88** | `message-transfer.test.ts` — observables now: per-item copies (one thread post per album item), contiguous, in source order, each a reply to the root. `copyMessages` usage is NOT asserted (per the brief) — its absence follows from per-item + reply, since `copyMessages` cannot reply; current production posts one `copyMessages` for the album → RED at "one post per item: expected 1 to be 2". |
| 5 | **S49–S63** — closing + failure report are replies (D87) | `cleanup-and-announce.test.ts` — `inThread` (which accepted `message_thread_id === 42` — the bug) replaced by `expectReportInThread` requiring the reply target == root 42 (D28/D87); the reply-to-root body loop added to every flow; S58/S63 additionally assert "the report as a reply to the title message" (feature steps). **S61/S62 forum announce `message_thread_id` assertions unchanged** (D18/D69 — those are correct). |
| 6 | **S33 + negative detectors stay strong post-I2-3** | `dialog.test.ts`/`failures-and-limits.test.ts` — `threadCreationCalls` now matches D87 reply-to-root body sends OR the legacy `message_thread_id` signature (widened = stronger, never blind); S73 `isCopyPost` likewise. `dialog.test.ts` S33 thread membership (`threadMarkers`) realigned to the reply chain (D44 superseded by D87) → RED at "expected [] to include 10". |
| 7 | **settings S7 untouched-thread probe** | `settings.test.ts` — the "created thread must stay untouched" filter now also detects reply-to-root thread-body messages (D87); widened = stronger. |
| 8 | **harness observability** | `harness.ts` — convention 11 documents D87/D88; `threadMarkers` realigned to the reply chain; new `bodyPostsSince`, `postMarkers`, `isThreadBodyCall`; `failRootPost` now targets the root precisely (a plain send with no reply target). |

Interpretations recorded (aligned, not silent):
- **S40's failure message** (copy-post failure after the root exists) is treated
  as a thread-body message of the created thread → reply to root. The feature
  step says only "the bot replies with a localized failure message"; D87's
  "every thread-body message" rule is applied. Renegotiate here if I2-3 treats
  it as a dialog reply instead.
- `bodyPostsSince` excludes the root by its fixture id 42 (convention 7).

Verification (2026-10-29, real output): `npm run typecheck` → exit 0 (clean);
`npm test` → `Tests 31 failed | 176 passed (207)`. All 31 failures are the new
D87/D88 assertions, i.e. RED for the right reason (wrong/absent reply target,
album not per item, thread not reply-assembled): 22 × `expected undefined to be
42` (copy/placeholder/closing reply target), 6 × report reply target, 2 ×
S44/S45 `one post per item: expected 1 to be 2`, 1 × S33 `expected [] to include
10`. Expected RED until I2-3 lands (owner `software-engineer`); the negative
detectors and S73/settings-S7 stayed green by design. Note: the repo has no
commits yet (`git diff` empty — everything untracked), so this table is the
audit trail for "tests were not weakened"; exact-string assertions are
byte-identical, all other edits are additions or strict realignments.

## Contradictions between sources

### OQ-QA-1 — `ADMIN_IDS` empty entries: D57/S11 vs SEC-12 (RESOLVED — D80)
- `docs/plan.md` D57 + `tests/features/configuration.feature` S11: entries are
  trimmed and **empty entries are ignored** (`" 777 ,, 888 "` → `[777, 888]`).
- `tests/security/config-env.test.ts` SEC-12 expects **`"1,,2"` to throw**
  (fail closed) — this contradicts D57.
- Tests follow the plan/decisions authority (S11 asserts tolerance). **Owner:
  `security-engineer`** to relax the `"1,,2"` row in SEC-12 (empty/whitespace
  values can stay fail-closed if that is intended — D57 only speaks about
  entries inside a non-empty list).

### OQ-QA-2 — S63 pins root id 42 without the stubbing step (RESOLVED — D81)
- S60 has the Given "the next message created by the bot gets the id 42" before
  asserting the exact announce URL with `42`; S63 asserts the same exact URL but
  has no such Given (its Given only injects delete failures).
- Provisional: the acceptance harness applies the fixture convention uniformly —
  the root (title) message gets `message_id` 42 in every transfer
  (decisions §1 "root id 42", `sendTitle` stubs the fake API's returned id).
  **Owner: `business-analyst`** — add the step to S63 or confirm the convention.

## Contract gaps (behaviour pinned by decisions but not the observable shape)

### OQ-QA-3 — failure-report wording (extends OQ-M)
- D54 quotes report fragments ("were not deleted", "could not be identified",
  "no originals were found to delete") while D72 says only exact strings are
  normative and OQ-M states report wording "is not pinned anywhere".
- Tests assert **semantics only** (S52/S53/S56/S57/S58/S63): a report exists as
  a reply into the created thread (D28), carries the counts ("1" and "3" for
  "1 of 3"), names the failing originals (the id text), and is absent when
  nothing failed. **Owner: `product-manager`** (per OQ-M) to pin catalog strings.

### OQ-QA-4 — raw update shapes / button markers are fixtures, not spec (RESOLVED — D81)
The feature files do not pin Telegram update shapes. The harness (see the header
of `tests/acceptance/harness.ts`) fixes these de-facto fixtures; `software-engineer`
must consume them to turn the tests green:
- plain "forwards the message N of C into T" ⇒ `forward_origin` =
  `{ type: "user", sender_user, date, chat: C, sender_chat: C }` (superset:
  matcher reads sender+date per D21, preselection reads the chat per D29/D66);
  the hidden-sender variant is `{ type: "hidden_user", sender_user_name, date }`;
- service messages carry `service_event_type` (the D27 placeholder slot name);
  polls carry `poll: { question }`; invoices carry `invoice: {...}`;
- "the inline button … is marked as selected" ⇒ a `✓`-style marker in the button
  text **or** a `sel|selected|on|chosen|active` token in `callback_data`;
- settings buttons are located by chat-id substring (D77) and disambiguated by
  `source|src|connect|from|add` / `thread|dst|dest|target|to` /
  `disc|off|remove|leave|del|un` tokens; language buttons by the locale code;
  confirmation buttons by `confirm|apply|done|yes|ok` (same as the security
  helpers). **Owner: `software-engineer` + `business-analyst`** confirm or the
  harness is adjusted together with the implementation.

### OQ-QA-5 — `retry_after` cannot be honoured without a wait hook (S72/S73) (RESOLVED — D78)
- D24 requires `retry_after` handling; S72/S73 require the retry to happen
  *after* the interval; the fixed `deps` (`store, now, logger, config`) contain
  no sleep/defer hook and tests may not use real time.
- Tests use **vitest fake timers** and expect the bot to wait via timers
  (`setTimeout`); the gap between the failing call and its retry is sampled on
  the mocked clock and must be ≥ `retry_after` seconds. **Owner:
  `software-engineer`** to implement waiting via `setTimeout` (or `devops-sre`
  may extend `deps` with an injectable sleep if the team prefers).

### OQ-QA-6 — `healthCheck`/`readyCheck` `deps` shape (D71) (RESOLVED — see change log)
- D71 fixes the signatures but not what `deps` contains, yet S81 needs to make
  "the database ping" succeed/fail.
- Tests pass a superset `{ store, logger, ping, dbPing }` (the ping is attached
  as an own property of an `InMemoryStore` instance) so any of `deps.ping()`,
  `deps.dbPing()` or `deps.store.ping()` works. **Owner: `software-engineer`**
  to pick the shape; the harness adapts trivially.

### OQ-QA-7 — how `/settings` discovers candidate chats (S1 vs SEC-13) (RESOLVED — D79)
- S1 Background only *declares* "the bot is an admin of X"; the reply must list
  exactly those chats. There is no Bot API call enumerating chats.
- SEC-13 requires unconnected-chat **message traffic** to produce zero store
  writes, so discovery cannot key on ordinary message traffic alone.
- The harness signals "the bot is an admin of X" with a `my_chat_member` update
  (bot promoted) **plus** an ordinary message **plus** membership fakes;
  `software-engineer` should key chat discovery on `my_chat_member` (or another
  non-message signal) to satisfy S1 and SEC-13 simultaneously.

### OQ-QA-8 — deletion failure granularity (S56–S58 vs D74) (RESOLVED — D74)
- D74 requires per-class, per-message reporting (`deleted`, `not_found`,
  `forbidden`, `failed`), and S56–S58 inject failures per message id.
- The fake API fails a `deleteMessages` call **as a whole** when any of its ids
  is failing (Telegram-style); realising "1 of 3 not deleted" therefore requires
  individual `deleteMessage` calls or batch-then-retry-individually.
  **Owner: `software-engineer`** — confirm the deletion strategy.

## Assertion-strength notes (deliberate choices — DECIDED, keep as written)

### OQ-QA-10 — S16 "the first recorded API call is the dialog reply" (DECIDED)
Asserted as "the first *user-visible* call is the dialog reply; only read-only
`get*` calls may precede it", because plausible implementations call
`getChat`/`getChatMember` lookups first. `no other message is sent and nothing
is deleted` is asserted literally.

### OQ-QA-11 — S76 "the reports are in Russian" (DECIDED)
A clean transfer produces no failure report (D54: report only when something was
left behind), so that part of the Then is conditional in the test. If a report
appears it must contain Cyrillic; the dialog prompt, closing and announce are
asserted strictly (Cyrillic present, English form absent, URL verbatim).

### OQ-QA-12 — probes added to make "state" assertions observable (DECIDED)
Several Then-steps describe state with no direct observable ("the draft is
still open", "the draft is unchanged", "the dialog covers the first 49
messages", "the album is not split"). The tests finish the flow afterwards and
assert the observable consequence (a valid title completes the transfer with the
right batch; the completed thread holds exactly 49 copies and none of the album).
The scenario-ordered assertions are checked **before** each probe.

## I3-1 — D89 closing-link acceptance realignment (qa-engineer, 2026-10-29)

Everything below is a **spec fix per D89** (closing link = the ANNOUNCE message link
`https://t.me/c/{internal_chat_id}/{announce_message_id}`, announce sent BEFORE the closing,
fallback to the plain chat title without a link), not a weakening — the old assertions pinned the
D62/D36 form (`t.me/{username}` / bare `t.me/c/{id}`) that D89 drops as unresolvable
(user bug report: `t.me/c/4327410333` does not open). Announce-OWN link assertions
(`https://t.me/{chat_path}/{root_id}?thread={root_id}`, S60/S63/S68/S77) are untouched — that
link is correct.

### Tests changed (tests/acceptance/**)

- `thread-creation.test.ts` **S34** — exact closing text realigned to
  `'Lunch — moved from https://t.me/c/200000000000001/42'` (decisions §1 "Derived links",
  announce id stubbed at 42 via the new step "the announce message gets the id 42").
- `thread-creation.test.ts` **S36** ("link formats") — rows realigned to the announce link
  `https://t.me/c/{stripped}/42` for `Source Chat` (`200000000000001`) and `Private Source Chat`
  (`200000000000004`); added: announce-before-closing ORDER assertion, "the announce message gets
  the id 42" stub check, and the closing link embedding that announce id. **Extra QA-depth row**
  (R63, not in the scenario's Examples — the fixture table has no basic-group chat): a locally
  defined `Basic Group` (`id: -123456789`, type `group`) checks the D62 `-`-prefix stripping
  (`https://t.me/c/123456789/42`). If `business-analyst` adds a basic-group fixture to decisions
  §1, realign the row to that id.
- `thread-creation.test.ts` **S37** — exact closing text realigned to the `/42` announce link.
- `thread-creation.test.ts` **S38** — first line of the closing realigned to the D89 announce
  link (announce id taken from the announce call — no stub in this scenario); the second-line
  exactness from the scenario is asserted explicitly. Not weaker than before (full text is still
  compared verbatim).
- `dialog.test.ts` **S26** — exact closing text realigned to
  `'Lunch menu — moved from https://t.me/c/200000000000001/42'` (+ the announce-id stub step).
- `i18n.test.ts` **S76** — the Russian closing is now located by the D89 announce link
  (`https://t.me/c/200000000000001/{announce_message_id}`, id taken from the announce call) and
  must embed that announce link; the "is Russian / not the English form" assertions are unchanged.
- `cleanup-and-announce.test.ts` **S50** — added the two new Then steps of the feature: "the
  closing message of the thread is posted after the announce in 'Source Chat'" (API-call ORDER)
  and "the closing message links to the announce message in 'Source Chat'" (the closing text is
  exactly `'Lunch — moved from https://t.me/c/200000000000001/{announce_message_id}'` with the id
  of the announce message actually sent).
- `cleanup-and-announce.test.ts` **S84** (NEW, one test = one scenario) — announce send fails
  ("sending the announce in 'Source Chat' fails with a Telegram error") ⇒ the closing message is
  still sent, is a reply to the root, and is exactly `'Lunch — moved from Source Chat'` — the
  plain chat title, no link; the thread is kept with all its messages.
- `harness.ts` (owned by qa-engineer) — new D89 support, convention 12 documented in the header:
  `setNextSendIdIn(chatId, id)` = step "the announce message gets the id N" (one-shot id stub),
  `failNextSendIn(chatId, init)` = step "sending the announce in X fails with a Telegram error"
  (one-shot failure; the failed call is still recorded, like all fake-API calls),
  helpers `announceCallIn`/`closingCallIn`; bot-created message ids are now tracked per chat
  (`chatId:messageId`) so the root id 42 (threads chat) and the stubbed announce id 42 (source
  chat) no longer collide. No existing behaviour changed.

### docs/risk-register.md

- **R63** added (technical section, continues the global numbering after R62): L=3 (the bare
  `t.me/c/{id}` form is unresolvable for every private source chat — it occurred in production),
  I=2 (navigation back is lost; content intact), score 6 = high; mitigation = ACC-33 (exact link +
  order, S34/S36/S37/S26/S50), ACC-34 (fallback, S84) + planned UNIT-24/UNIT-25; status
  `open (→ covered after I3-3)`. New planned-IDs block "introduced by I3-1" added (ACC-33,
  ACC-34, UNIT-24, UNIT-25 — UNIT ids are for `software-engineer`, I3-3).

### Open items

- ACC-33/ACC-34 trace to the scenarios above; the S→ACC→R mapping blocks in the test headers were
  updated accordingly. If `business-analyst` renames S84 or adds scenario rows for the basic-group
  case, realign names/rows (owner: qa-engineer).
- `UNIT-24`/`UNIT-25` are planned for `software-engineer` (I3-3) — R63 cannot go `covered` before
  they exist and the acceptance reds turn green.

## I3-4 — S36 seeding fix + iteration-3 QA gate (qa-engineer, 2026-10-29)

One test-side seeding bug in the I3-1 D89 realignment, fixed here; **no assertion
touched**. S36's locally defined "Basic Group" row (`id: -123456789`, type `group`)
seeded only `botIsAdminOf([sourceChat])` (D79 discovery signal) but not the AUTHOR's
admin membership, so the bot **correctly refused** the transfer (D4/SEC-1: only a
source-chat admin may move messages) and no announce was posted. Fix: added
`await ctx.userIsAdminOf(USERS.author, [sourceChat]);` next to the `botIsAdminOf`
seed — the exact S83 precedent (`dialog.test.ts` ~452) and the pattern every other
suite uses in its background. This is a **spec alignment (D4/D82), not a weakening**:
the row's assertions are unchanged, and with the seeding the row passes with the
closing exactly `Lunch — moved from https://t.me/c/123456789/42` (D89: announce
link, `-`-stripped basic-group id, stubbed announce id 42).

Gate evidence (2026-10-29, real output): `npm ci && npm run typecheck && npm test`
(exit 0; npm_config_cache workaround per AGENTS.md) → **219 passed / 0 failed (219)**
— 84 acceptance (S1–S84), 16 security, 112 unit/property, 7 smoke. R63 → `covered`
in `docs/risk-register.md` (ACC-33/ACC-34/UNIT-24/UNIT-25 green); verdict:
`docs/qa/verdict.md` I3-4.

## Test-count ledger
- 84 tests = S1–S84, one per scenario (Scenario Outlines S23/S24/S25/S31/S36/
  S38/S46/S58/S60/S75/S77/S81 are one test each with a table-driven loop over
  their Examples rows; each row boots a fresh bot). S83 (alignment pass 3) is
  new; S32 was realigned to D68 REVISED (join, not refuse). S84 (I3-1) is new —
  the D89 announce-failure fallback scenario.
- Current state (2026-10-29, alignment pass 3): `npm run typecheck` → exit 0;
  `npm test` → `Tests 1 failed | 119 passed (120)` — the only failure is the
  new S83, RED at "a NEW dialog message is posted" because the recreate branch
  of D68 (revised) is not implemented yet (expected red; owner
  `software-engineer`). S32 and S60 are green after this pass.
- Current state (2026-10-29, iteration 2 / I2-1, alignment pass 4): after the
  T10 gate (207/207 green) and the D87/D88 realignment above, `npm run
  typecheck` → exit 0 and `npm test` → `Tests 31 failed | 176 passed (207)` —
  the 31 are the D87/D88 reply-to-root/per-item assertions (S33–S63, S42–S48,
  S34–S41), expected RED until I2-3 (`software-engineer`) implements
  reply-to-root assembly and per-item album copies.
- Alignment pass 2 verification (2026-10-28): `npm run typecheck` → exit 0;
  `npm test` → `Tests 98 failed | 7 passed (105)` — unchanged: 82 acceptance
  tests = 82 scenarios (S1–S82 all present), every one still RED with
  "Cannot find module '/src/config'" (`ERR_MODULE_NOT_FOUND`) at harness boot;
  16 security tests likewise red (missing modules), 7 smoke tests green.
- Current state (2026-10-29, iteration 3 / I3-1, D89 realignment): `npm run
  typecheck` → exit 0; `npm test` → `Tests 8 failed | 205 passed (213)` — 213 =
  212 + the new S84. The 8 reds are exactly the D89 behaviours, expected RED
  until I3-3 (`software-engineer`): S50 (announce AFTER the closing — order),
  S84 (fallback missing: closing is 'Lunch — moved from t.me/main_chat' instead
  of 'Lunch — moved from Source Chat'), S26/S34/S37/S38 (closing carries the
  dropped `t.me/…` form instead of the announce link), S36 (order first, wrong
  link next), S76 (the closing does not carry the D89 announce link). All other
  205 tests green; no test weakened.
- Current state (2026-10-29, iteration 3 / I3-4, QA gate): `npm run typecheck`
  → exit 0; `npm test` → **Tests 219 passed (219)** after the I3-3 D89
  implementation and the I3-4 S36 seeding fix (219 = 213 + the 6 UNIT-24/UNIT-25
  tests of `tests/unit/closing-link.test.ts`); per area: 84 acceptance (S1–S84,
  1:1), 16 security, 112 unit/property, 7 smoke.
