# QA verdict — T10 (qa-engineer)

**VERDICT: PASS** — date: 2026-10-29. Gate run against a clean state; residual accepted risks listed in §8.

## 1. Clean-state run (real output)

```
npm ci        → ok (esbuild/fsevents postinstall warnings only; npm_config_cache workaround
                 from AGENTS.md used due to EACCES in ~/.npm/_cacache)
npm run typecheck → tsc --noEmit, clean (no output, exit 0)
npm test      → Test Files 26 passed (26), Tests 207 passed (207), Duration 1.50s
```

Per-area counts (from the JSON reporter of the same suite): **83 acceptance** (S1–S83),
**16 security** (SEC-1..SEC-15 + boot sanitization), **101 unit/property** (incl. fast-check,
fixed seeds), **7 smoke** (`tests/helpers/*.smoke.test.ts`). Re-run after the T10 cosmetic edits
(step 7) — again **207/207 green, typecheck clean**.

## 2. Risk coverage (score ≥ 3; `docs/risk-register.md`)

All rows with score ≥ 3 have mitigation tests and status `covered`/`mitigated`/`accepted`
(T10 updated the stale R1–R47 statuses `open` → `covered` and dropped the "(planned)" markers
after verifying the tests; note added to the register).

| risks | mitigation tests (all passing) |
|---|---|
| R1, R5, R23, R29, R37, R42 (failure/partial) | S39, S40, S41, S56, S57, S58, S59, S74, S75 (create-before-delete invariant asserted: `deletedIds(source) == []` on copy failure) |
| R2, R17, R18, R22, R24 (matcher) | S50–S55 (collision/cross-chat/edited/zero-match), SEC-14 (unique-or-none, chat-scoped) |
| R3, R48, R49 (authz) | S1–S8, SEC-1 (non-admin → zero side effects), SEC-3 |
| R4, R33, R34 (links/root) | S34, S35, S36, S60, S68 (`?thread={root_id}`, `c/{id}` stripping) |
| R6, R25 (forward_origin/preselection) | S17, S18, S19, S64 + `create-bot-behaviour` unit (D46) |
| R7, R38, R42 (duplicate/mapping) | S41, S68, S69, S70, SEC-7; oracle property `store-contract` (InMemory ≡ PgStore over random ops) |
| R8, R20, R21, R26, R41, R43 (copy/albums/placeholders) | S42–S48, S66, S67; exact placeholder table (S46) |
| R9, R30, R31, R32, R44, R45 (dialog FSM) | S15, S16, S20–S33, S83; `draft-batch` unit + properties (join invariant) |
| R10, R27, R28 (limits/flood) | S71–S73, SEC-10; unit `deletion` (chunkIds ≤100 round-trip, retryAfterMs) |
| R11, R37 (rights lost) | S52, S59, S74, SEC-2 |
| R12, R46, R47 (i18n) | S9, S76–S79; en/ru parity checked (34=34 keys) |
| R13, R35, R36 (forum topics) | S61, S62 (D55 first-message topic) |
| R14 (truncation warning) | S64–S67 |
| R19 (title 255/code points) | S23–S26 (255/256 × ascii/emoji tables) |
| R39, R40, R56 (config/webhook) | S10–S14, SEC-11, SEC-12; unit `config`, `webhook` + properties |
| R50, R51, R53, R54, R59, R60 | SEC-4, SEC-5, SEC-7, SEC-10, SEC-15 (fuzz, fixed seed 20261028), SEC-6, SEC-13 |
| R55, R61 | SEC-8, SEC-9 + unit `boot-failure`, `transfer-audit-log` (SEC-F1/F2 fixes pinned) |

No row is `open`; no score ≥ 3 risk is untested. R14–R16, R43–R47, R58 (score ≤ 2) keep at least one
mitigation test each as well.

## 3. Scenario coverage (S1–S83)

83 scenarios in `tests/features/*.feature` ↔ **83 acceptance tests, exactly one per scenario**
(each test title starts with its S-ID; 83 unique IDs, no duplicates, no unnumbered tests;
per-file counts match the feature files 1:1). Mapping blocks `S → ACC → R` in the test headers were
cross-checked against `docs/spec/decisions.md` §6.

## 4. Exact strings (spec §3 vs `tests/acceptance/**`)

| normative string | asserted at | verdict |
|---|---|---|
| `Thread created "{title}": {url}` | `cleanup-and-announce` (exact `ANNOUNCE_42`, `hasExactText`), `failures-and-limits`, `i18n` | match |
| `{title} — moved from {link}` (em dash U+2014 — byte-checked in tests and catalogs) | `dialog` S23-probe, `thread-creation` S34/S36 exact texts | match |
| `N messages replaced by placeholders` | `thread-creation` S38 (exact incl. literal `1 messages…` per D39) | match |
| `[poll] {q}` / `[service] {t}` / `[unsupported] {ct}` | `message-transfer` S46 table (`[poll] Lunch?`, `[service] message_chat_join_by_link`, `[unsupported] invoice`) | match |
| `t.me/{username}` / `t.me/c/{chat_id}` (`-100` stripped) | `thread-creation` S36 (`t.me/c/200000000000004`), `cleanup-and-announce` S60 (`https://t.me/c/200000000000005/42?thread=42`) | match |
| `?thread={root_id}` | announce/closing/duplicate-refusal assertions (`…/42?thread=42`) | match (root id 42 only — see QA-R3) |

Catalog templates (`src/i18n/locales/en.ts`) are byte-identical to the normative strings.

## 5. Constraints (grep-based)

- `parse_mode`: **not used** in any API call in `src/`; the only literal occurrence is a doc
  comment in `src/bot/createBot.ts:10` stating it is never used (nit, not a violation of D75).
  Telegram `entities:` param — none; `groupEntities/truncateEntities` are local batch-domain names.
- `deleteMessages` batching: `DELETE_CHUNK_SIZE = 100`, `chunkIds()` used on every delete path.
- `retry_after`: `retryAfterMs` honoured in `withRetry429` and all delete loops (D24/D78).
- i18n: all user-facing strings via catalogs; en/ru key parity **34 = 34**, no drift.
- Tests: no real network (fake Bot API transformer), no real DB (StubPgPool / InMemoryStore),
  no real timers (injected clock / vitest fake timers); fast-check seeds fixed (e.g. 20261028).
- `deleteMessages` ≤ 100 and 50-batch cap pinned by SEC-10.

## 6. Security gate condition

`docs/security/report.md` §5: **"VERDICT: NO — there are no open Critical/High findings"**
(0 Critical, 0 High; Medium SEC-F1 and Low SEC-F2 **mitigated** and pinned by unit tests;
SEC-F3..F6 **accepted**). Condition satisfied.

## 7. T10 fix + test-integrity check

- Fixed (test comments only): 4 stale `D68 (revised/REVISED)` references in
  `tests/acceptance/dialog.test.ts` → `D68 (final)`; one stale clause realigned to the final
  wording (batch kept, selection cleared). No assertion touched.
- Test-weakening check: the repo is untracked (single initial commit), so no test diffs exist to
  review; substitute evidence: 1:1 scenario↔test mapping intact (§3), all normative assertions
  present verbatim (§4), suite size matches the expected 207 and feature counts.

## 8. Accepted residual risks / gaps (non-blocking)

| ID | residual | owner |
|---|---|---|
| QA-R1 | Register depth convention ("high = scenario + unit + property") not fully realized: planned UNIT-1/2/3/5/8/9/10/13/14/15/16/18/19/20 property/unit tests do not exist as separate tests. High risks are covered by scenario + SEC-14/SEC-15 + unit oracle properties elsewhere; accepted for iteration 1. | `software-engineer` (tests/unit), `qa-engineer` (acceptance-level PBT) |
| QA-R2 | Docker build never run (daemon unavailable) — image unverified end-to-end (SEC-F4). | `devops-sre` |
| QA-R3 | `?thread={root_id}` == `root_id` pinned at root id 42 only (harness supports other roots, unused); D62 basic-group `-` prefix stripping untested (only `-100` ids exercised). | `qa-engineer` |
| QA-R4 | PgStore SQL not covered against a real PostgreSQL (D25/D85): stubbed driver + InMemory oracle only. | `devops-sre`/`software-engineer` (stage 2) |
| SEC-F3 | Dev-only esbuild chain (GHSA-67mh-4wv8-2f99) ships in image via drizzle-kit; vulnerable path never runs; `npm audit` CI gate stays. | `security-engineer` (monitor upstream) |
| SEC-F5 | `draft.batch` unbounded within the 15-min window (no rate limiting this iteration). | `software-engineer` (if needed) |
| SEC-F6 | Webhook secret comparison reveals length only (constant-time for equal lengths). | accepted as-is |

Blocking gaps: **none**.

---

# QA verdict — I2-4, iteration 2: D87/D88 thread-assembly fix (qa-engineer)

**VERDICT: PASS** — date: 2026-10-29. Gate run against a clean state; gaps in §8 below, none blocking.

## 1. Clean-state run (real output)

```
npm ci        → ok (129 packages; 4 deprecated transitive warnings; npm_config_cache workaround
                 used per AGENTS.md; npm audit: 4 moderate — pre-existing SEC-F3 chain)
npm run typecheck → tsc --noEmit, clean (no output, exit 0)
npm test      → Test Files 27 passed (27), Tests 212 passed (212), Duration 1.70s
```

Per-area counts (JSON reporter of the same suite): **83 acceptance** (S1–S83), **16 security**,
**106 unit/property** (+5 vs T10: `thread-assembly.test.ts` UNIT-22/UNIT-23), **7 smoke**. Total
**212/212** — matches the iteration report (212 passed / 0 failed).

## 2. R62 (L3×I3=9, high) — mitigation green, status `covered`

Register row R62 updated `open → covered` (co-owner edit). Evidence:
- UNIT-22 (unit): every thread-body send path (copy, placeholder, closing, failure report) replies
  to root 42 and never carries `message_thread_id`; forum-source announce keeps it (D18).
- UNIT-23 (property, fast-check, fixed seed 20261029): over generated batches (mixed content incl.
  albums, split/out-of-order) every body call names root_id, albums per item per D88, `?thread=`
  link == root_id. All green in the clean run.
- Acceptance layer: `expectBodyRepliesToRoot` (`thread-creation.test.ts:44`, asserts
  `replyToOf(call) === 42` for every body post) applied across S34–S41 and realigned suites
  (S42–S48, S49–S63, S33, S7, S73); S44/S45 assert "the album is copied per item" + contiguous +
  source order (D88).

## 3. Scenario ↔ test mapping (S1–S83)

After the scenario wording updates: **83 feature scenarios ↔ 83 acceptance tests, exactly one per
scenario** (83 unique S-IDs on `test("S…` lines, no duplicates); test titles match scenario titles
**83/83** (automated comparison, 0 mismatches) — including the D87/D88 rewordings
("each copy is a reply to the title message", "the closing message is a reply to the title
message", "the album is copied per item").

## 4. Exact strings (spec §3 spot-check) — unchanged

| string | evidence | verdict |
|---|---|---|
| `Thread created "{title}": https://t.me/{chat_path}/{root_id}?thread={root_id}` | `ANNOUNCE_42` + `hasExactText` in `cleanup-and-announce`, `failures-and-limits`; catalog `transfer.announce` | match |
| `{title} — moved from {link}` | byte-checked: U+2014 ×15 in `thread-creation.test.ts`, ×2 in `en.ts`; **0** hyphen-minus variants; S34/S36 exact-text asserts | match |
| `N messages replaced by placeholders` (literal `1 messages…`, D39) | S38 exact two-line assert; `transfer.closingPlaceholders` catalog | match |
| `[poll] {q}` / `[service] {t}` / `[unsupported] {ct}` | `src/domain/content.ts` D27 table, S46 | match |
| link formats `t.me/{username}` / `t.me/c/{id}` (`-100` stripped) / `…/{root_id}?thread={root_id}` | S36, S60; catalogs byte-identical to normative strings | match |

## 5. Security sanity of the change (security step merged for this small iteration)

- **Reply target**: `replyToRoot = { reply_parameters: { message_id: rootId } }` where `rootId` is
  the bot's own `sendMessage` response for the title message (`createBot.ts:547-560`) — never
  user-controlled. All body sends (copies, placeholders, closing, D28 failure report) reuse it.
- **No new `parse_mode` surface**: grep — `parse_mode` appears in `src/` only in the doc comment at
  `createBot.ts:10`; no `entities` on user text (SEC-6 holds).
- **No secret/user-content leakage**: new/changed log paths log ids and error *names* only
  (`root_send_failed`, `copy_failed`, `transfer_completed` per SEC-8: actor/chat/root/deleted ids,
  no title/text); no tokens/config in replies.
- Note for `security-engineer` (beyond scope, pre-existing): `npm audit` reports **4 moderate**
  (consistent with accepted SEC-F3 esbuild chain) and `npm ci` warns 4 packages with unapproved
  install scripts — no change this iteration, just recorded.

## 6. Constraints (grep-based)

- `message_thread_id` in `src/`: only (a) read `msg.message_thread_id` for the forum-source announce
  topic (`createBot.ts:224`, D18/D55), (b) the announce send itself (`createBot.ts:652`), (c) store
  schema/typing. **Zero** thread-body sends use it (D87 comment at 558; UNIT-22 pins this).
- `copyMessages` in thread assembly: **absent** — the only occurrence is the explanatory comment
  `createBot.ts:564` ("`copyMessages` cannot reply"); albums copy per item via `copyMessage` (D88).
- Tests deterministic: no real network (fake API transformer; `webhook.test.ts` drives fake req/res,
  no sockets), no real timers (harness injected clock / `vi.setSystemTime`), fast-check seeds fixed
  (20261028/20261029).

## 7. Test-integrity check

Repo is untracked (single initial commit) — no test diffs exist to review (same limitation as T10).
Substitute evidence: all normative assertions present verbatim (§4), strict reply-to-root assertions
(`toBe(42)` with message per call), 1:1 mapping intact (§3), suite size consistent (212 = 207 + 5
UNIT-22/23 tests; acceptance count unchanged at 83).

## 8. Gaps (non-blocking)

| ID | gap | owner |
|---|---|---|
| QA-R5 | Feature scenarios not tagged `@R62` (tags stop at `@R47`); risk↔scenario traceability lives in the register mitigation column + mapping blocks instead. | `business-analyst` |
| QA-R6 | UNIT-23 runs `numRuns: 20` (deterministic but shallow vs the 200+ convention). | `software-engineer` |
| QA-R1..QA-R4, SEC-F3/F5/F6 | unchanged from T10 (accepted residual). | as there |

Blocking gaps: **none**.

---

# QA verdict — I3-4, iteration 3: D89 closing-link fix (qa-engineer)

**VERDICT: PASS** — date: 2026-10-29. Gate run against a clean state; gaps in §8 below, none blocking.

## 0. S36 seeding fix (test side, spec alignment — not a weakening)

S36's "Basic Group" QA row (`thread-creation.test.ts`) seeded only the D79 discovery
signal (`botIsAdminOf([sourceChat])`) and not the AUTHOR's admin membership, so the bot
**correctly refused** the transfer (D4/SEC-1) and the row failed at "the announce is
posted in the source chat". Fix: added `userIsAdminOf(USERS.author, [sourceChat])`
(the exact S83 precedent, `dialog.test.ts` ~452). **No assertion touched**; with the
seeding the row passes and the closing is exactly
`Lunch — moved from https://t.me/c/123456789/42`. Recorded in
`docs/qa/open-questions.md` (I3-4).

## 1. Clean-state run (real output)

```
npm ci        → ok (npm_config_cache workaround per AGENTS.md; postinstall warnings only)
npm run typecheck → tsc --noEmit, clean (no output, exit 0, 0 errors)
npm test      → Test Files 28 passed (28), Tests 219 passed (219), Duration 1.68s
```

Per-area counts (JSON reporter of the same suite): **84 acceptance** (S1–S84, 1:1),
**16 security**, **112 unit/property** (+6 vs I2-4: `closing-link.test.ts`
UNIT-24/UNIT-25), **7 smoke**. Total **219/219** — matches the iteration report.

## 2. R63 (L3×I2=6, high) — mitigation green, status `covered`

Register row R63 updated `open → covered` (co-owner edit) + I3-4 gate note in the
planned-IDs block. Evidence:
- **ACC-33** (exact link + order): S34/S37 exact closing
  `Lunch — moved from https://t.me/c/200000000000001/42`; S36 rows —
  `…/200000000000001/42`, `…/200000000000004/42`, `…/123456789/42` (basic-group
  `-`-stripping QA row) with the announce-before-closing API-order assertion;
  S26 trimmed-title closing; S50 order + "closing links to the announce message".
- **ACC-34** (fallback): S84 — announce send fails ⇒ closing exactly
  `Lunch — moved from Source Chat`, reply to root, thread kept.
- **UNIT-24** (unit, `tests/unit/closing-link.test.ts`): builder renders exactly
  `https://t.me/c/{digits}/{digits}` for `-100…`/`-`/public id shapes; announce
  before closing; fallback = plain title, never a URL.
- **UNIT-25** (property, fast-check, fixed seed 20261029, 200 runs): for ANY chat
  id + announce id the link matches `^https://t\.me/c/\d+/\d+$` — never a bare
  `t.me/c/{id}`; fallback never contains a URL. All green in the clean run.

## 3. Scenario ↔ test mapping (S1–S84)

**84 feature scenarios ↔ 84 acceptance tests, exactly one per scenario** (84 unique
S-IDs on `test("S…` lines; automated set comparison of feature tags vs test titles:
0 in features-only, 0 in tests-only). S84 (new this iteration, `@S84 @AC3 @R63`) is
present as its own test in `cleanup-and-announce.test.ts`. Mapping blocks
`S → ACC → R` updated in the test headers.

## 4. Exact strings (spec §3 spot-check)

| string (decisions §3) | evidence | verdict |
|---|---|---|
| closing `{title} — moved from https://t.me/c/{internal_chat_id}/{announce_message_id}` (em dash U+2014) | catalog `transfer.closing` = `{title} — moved from {link}` byte-checked (U+2014, 0 hyphen-minus variants); S34/S36/S37/S26 exact texts; value = the announce link | match |
| closing fallback `{title} — moved from {chat title}` (no link) | `movedFromValue` returns `chat.title`; S84 exact `Lunch — moved from Source Chat` | match |
| announce `Thread created "{title}": https://t.me/{chat_path}/{root_id}?thread={root_id}` | catalog `transfer.announce` unchanged; `threadUrl` unchanged; S60/S63/S68/S77 announce-own-link assertions untouched | match |

## 5. Constraints (grep-based)

- Closing link built **from chat id + announce id**: `src/domain/links.ts:41`
  `announceMessageLink` → `https://t.me/c/${chatLinkSegment(chatId)}/
  ${Math.abs(announceMessageId)}`; consumed at `createBot.ts:606` with the real
  `announce?.message_id`. No code in `src/` emits a bare `t.me/c/{id}` — occurrences
  are doc comments only, and `chatPath`'s `c/{id}` segment always appears inside the
  full `…/{root_id}?thread={root_id}` thread URL (D2, unchanged).
- **Announce-before-closing order**: `createBot.ts` step 3 (announce) precedes step 4
  (closing); pinned by S36/S50 order assertions.
- **Tests deterministic**: no real network (fake API transformer), no real timers
  (injected clock / vitest fake timers), fast-check seeds fixed (20261029 ×200/100);
  no `Date.now`/`setTimeout` in test bodies outside the fake-timer harness.

## 6. Security sanity of the change (light, merged)

- **Link values are digits only**: `chatLinkSegment` renders `Math.abs(chatId)`
  through digit-preserving regexes; the id segment is `Math.abs(announceMessageId)`.
  No user-controlled text (title, username, message text) ever enters a URL — the
  title appears only in message text; the fallback puts `chat.title` into the message
  body, not a link. UNIT-25 property pins the digit-only shape for any input.
- **No new leakage**: the D89 paths log no title/text (existing `copy_failed` etc.
  log error *names* only, SEC-8 convention); no `parse_mode`/`entities` added; reply
  target still the bot's own root id. No open Critical/High in
  `docs/security/report.md` (unchanged since I2-4).

## 7. Test-integrity check

Repo is untracked (single initial commit) — no test diffs exist to review (same
limitation as T10/I2-4). Substitute evidence: the only test edit of this iteration is
the S36 **additive seeding line** (documented in §0 and `docs/qa/open-questions.md`;
assertions byte-identical), all normative strings present verbatim (§4), 1:1 mapping
intact (§3), suite size consistent (219 = 213 + 6 UNIT-24/25).

## 8. Gaps (non-blocking)

| ID | gap | owner |
|---|---|---|
| QA-R5 | Feature scenarios not tagged `@R62` (partially improved: `@R63` tags ARE present on S34/S36/S37/S26/S50/S84) | `business-analyst` |
| QA-R3 | D62 basic-group `-` prefix stripping now HAS the S36 QA row (`-123456789` → `123456789`) — partially retired; `?thread=` at non-42 roots still unexercised | `qa-engineer` |
| QA-R1, QA-R2, QA-R4, QA-R6, SEC-F3/F5/F6 | unchanged from T10/I2-4 (accepted residual) | as there |

Blocking gaps: **none**.
