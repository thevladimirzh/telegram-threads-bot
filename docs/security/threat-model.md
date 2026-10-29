# Threat model — telegram-threads-bot

Maintained by: `security-engineer`. Date: 2026-10-28 (iteration 1, task T4).
Scope: the change described in `docs/plan.md` §2 — a Telegram bot that moves a discussion from a
source chat into a threads chat as a named reply thread, **deleting messages in other people's
chats** (forwarded copies and matched originals). Depth is scaled to the project: this is a
single-tenant bot service, so the model focuses on input validation, authorization of destructive
actions, resource limits, secret handling and configuration — not on a web-authn audit.

Threat IDs below reference the risk register (`docs/risk-register.md`, security section, R48+) and
the security tests (`tests/security/**`, SEC-1..SEC-15). Frameworks used: STRIDE over the entry
points, OWASP Top 10 (2021) categories, CWE ids in the register.

## 1. System summary

grammY bot (TypeScript, Node ≥22) + PostgreSQL via Drizzle + pino logging. Config comes from env
(`BOT_TOKEN`, `DATABASE_URL`, `ADMIN_IDS`, `MODE=polling|webhook`, `WEBHOOK_*`), validated by Zod
(`loadConfig`). The bot indexes every message it observes in *connected* source chats
(`source_messages`), opens a dialog when a batch is forwarded into the threads chat, creates a
reply thread (title root + copies + closing), then **deletes** the forwarded copies and the matched
originals and posts an announce link. `/settings` in DM (global admins only) connects source chats
and exactly one threads chat. Test entry points are fixed in `docs/plan.md` §7.

## 2. Assets

| # | asset | impact if compromised |
|---|---|---|
| A1 | Message content (source originals, forwarded copies, thread messages) | confidentiality of private discussions |
| A2 | **Chat integrity / message existence** — the bot deletes messages irreversibly in third-party chats | worst-case: an attacker wipes discussions or destroys evidence; unrecoverable |
| A3 | `BOT_TOKEN` | full control of the bot incl. deletion in every chat it is in (A2 at scale) |
| A4 | DB rows: `chats`, `users`, `drafts`, `threads`, `thread_messages`, `source_messages` + `DATABASE_URL` credentials | forged connections/mappings ⇒ deletions in wrong chats; credential leak |
| A5 | Admin identity: `ADMIN_IDS` (global) and source-chat admin status | elevation ⇒ A2 |
| A6 | Service availability (updates loop, API flood budget) | DoS; Telegram flood bans (`retry_after`) |

## 3. Actors

| actor | trust | capabilities |
|---|---|---|
| Global admin (`ADMIN_IDS`) | trusted for configuration | `/settings`, connects chats; mistakes possible, malice assumed low |
| Source-chat admin | semi-trusted | may initiate transfers (deletes originals in own chat) |
| Ordinary chat member | untrusted | forwards batches, answers dialogs, presses buttons |
| External attacker with a Telegram account | untrusted | DMs the bot, presses forged buttons, crafts forwards/titles/callbacks, creates own chats and adds the bot there |
| Telegram platform / Bot API | trusted transport + identity provider | update authenticity is assumed *only* for updates that really come from Telegram (see trust boundaries) |
| Bot operator / infrastructure | trusted | env vars, DB, log collection |

## 4. Trust boundaries

1. **Telegram updates → bot** — all update JSON is untrusted input (messages, callback queries,
   forwards, titles). `from.id` is the only identity signal; every handler must re-check it.
2. **Bot → Telegram Bot API** — outbound; the request URL contains `BOT_TOKEN`; Telegram error
   objects (grammY) may embed that URL and must be sanitized before logging.
3. **Bot → PostgreSQL** — `DATABASE_URL` (credentials); all SQL must go through Drizzle
   parameterization (no string-built queries).
4. **Env → config** — `loadConfig` is the only gate; invalid values must fail closed (Zod throws).
5. **Webhook endpoint → bot** (`MODE=webhook`) — an unauthenticated HTTP endpoint is *outside*
   Telegram's boundary; `X-Telegram-Bot-Api-Secret-Token` validation is what keeps forged JSON out.
6. **Logs → operators** — pino JSON on stdout; crossing it with secrets (A3, A4) is a breach.

## 5. Entry points

| entry | trust boundary | notes |
|---|---|---|
| `message` updates in any chat the bot is in | 1 | indexing (plan §7.4), forwarded batches, title text, `/start` `/settings` `/cancel` |
| `callback_query` updates | 1 | settings buttons, source-chat pick buttons, dialog controls (client-side data!) |
| webhook HTTP endpoint | 5 | `MODE=webhook` only |
| env vars | 4 | `BOT_TOKEN`, `DATABASE_URL`, `ADMIN_IDS`, `MODE`, `WEBHOOK_URL`, `WEBHOOK_SECRET` |
| store API (`Store` interface) | 3 | called only from bot code; `source_messages` index drives deletions |
| third-party libraries | supply chain | grammY, drizzle-orm/pg, zod, pino, lingui (runtime); vitest/fast-check/tsx/drizzle-kit (dev) |

## 6. Threats (STRIDE)

### Spoofing / broken authentication & authorization (OWASP A01, A07)

| threat | risk | mitigation | tests |
|---|---|---|---|
| T-S1 A member who is not an admin of the source chat initiates a transfer → unauthorized deletion of other people's messages | R48 (CWE-862) | source-chat-admin check (`getChatMember`) before any transfer step; refuse + no side effects; positive control keeps the check honest | SEC-1 |
| T-S2 Non-global-admin calls `/settings` or replays captured settings buttons (client-side button forgery) → chats silently reconnected to attacker-controlled endpoints | R49 (CWE-862, CWE-284) | `ADMIN_IDS` check on every settings entry point (command *and* callback); non-admins get no admin UI | SEC-3 |
| T-S3 A forged callback query (another user presses the dialog buttons) advances/misroutes the forward author's draft | R50 (CWE-290) | draft author check (`callback_query.from.id`), inert handling of foreign/stale callbacks | SEC-4, SEC-5 |
| T-S4 Forged or replayed updates re-run a transfer → double deletions, double announce | R51 (CWE-294) | duplicate protection via message mapping (D23/D34: refuse mapped messages, zero side effects); fuzz-hardened handler entry | SEC-7, SEC-15 |
| T-S5 Chat impersonation: a chat the bot is a member of but that is *not* connected gets indexed/processed → poisoned index, deletions keyed by attacker data | R60 (CWE-863) | connection check before indexing and before transfer; unconnected chats must be fully inert | SEC-13 |
| T-S6 `ADMIN_IDS` parsing failure (spaces, empties, non-numeric, overflow) yields a wrong admin set | R57 (CWE-20) | fail-closed Zod validation; safe-integer ids; typed errors | SEC-12, SEC-9 |
| T-S7 Webhook forgery: without secret validation anyone can POST crafted updates (⇒ T-S1/T-S4) | R56 (CWE-345) | `MODE=webhook` refuses to boot without `WEBHOOK_URL` **and** non-empty `WEBHOOK_SECRET`; secret must be checked against `X-Telegram-Bot-Api-Secret-Token` | SEC-11 (config gate; transport check reviewed in T9) |

### Tampering / injection (OWASP A03, A08)

| threat | risk | mitigation | tests |
|---|---|---|---|
| T-T1 Malicious title/message text: HTML/Markdown injection if `parse_mode` is used, spoofed links, mention spam, RTL/zero-width tricks → link points to an attacker site while displaying a trusted URL | R52 (CWE-79, CWE-116) | user content is delivered as **plain data**: no `parse_mode`, no `entities` on messages carrying attacker text; bot-built URLs only | SEC-6 |
| T-T2 Stored XSS-like payloads kept in DB (titles, texts) and re-rendered later as markup | R59 (CWE-79) | same data-not-markup rule on every render path (announce, closing, reports) | SEC-6 |
| T-T3 Matcher abuse: cross-chat matching or same-second identical-content collisions delete innocent originals in another chat | R54 (CWE-704/CWE-59) | matcher scoped to the chosen source chat; ambiguous matches ⇒ delete nothing | SEC-14 |
| T-T4 SQL injection through chat titles/texts into Drizzle queries | low (CWE-89) | all queries via Drizzle ORM parameterization; no raw string-built SQL | manual review (T9), `npm run typecheck` schema check |

### Repudiation

| threat | risk | mitigation | tests |
|---|---|---|---|
| T-R1 A destructive transfer cannot be attributed later (who ordered which deletions) → abuse is deniable | R61 (CWE-778) | structured pino logs must record initiator id, chats, thread id and deleted message ids (while never logging secrets — T-I1) | SEC-8 (secret side); audit completeness reviewed in T9 |

### Information disclosure (OWASP A01, A05, A09)

| threat | risk | mitigation | tests |
|---|---|---|---|
| T-I1 `BOT_TOKEN` / `DATABASE_URL` reach logs or chat output (grammY error objects embed the request URL with the token; config dumps) | R55 (CWE-532) | sanitize errors before logging; never log config/env; secret markers must not appear anywhere in log records | SEC-8, SEC-9 |
| T-I2 The admin UI (bot's chat list, connection buttons) leaks to non-global-admins | R49 (CWE-200) | no admin keyboard and no chat enumeration in refusals | SEC-3 |
| T-I3 Handler failures show raw stack traces / internal error dumps to users | R11 (CWE-209) | localized failure messages only (AC11); internals stay in logs | SEC-2 |

### Denial of service (OWASP A04, A05)

| threat | risk | mitigation | tests |
|---|---|---|---|
| T-D1 Oversized batches (e.g. 500 forwarded messages) → unbounded copies/deletions, flood limits, stuck transfers | R53 (CWE-400/CWE-770) | batch cap 50 (D31/D16), bounded work; `deleteMessages` chunked ≤ 100 ids (plan §5) | SEC-10 |
| T-D2 Callback floods and garbage updates crash the update loop (grammY rethrows without an error handler) | R51, R53 (CWE-248) | `bot.catch` (or equivalent) on every handler path; hostile callbacks are inert | SEC-5, SEC-15 |
| T-D3 Telegram 429 / `retry_after` exhaustion during deletion loops | R10/R28 (technical register) | `retry_after` honored everywhere (D24) | ACC-10/ACC-21 (qa-engineer) |

### Elevation of privilege

T-S1, T-S2, T-S5, T-S6 and T-S7 are the elevation paths of this system: every one of them ends in
the same high-impact capability — **deletion of messages in chats the attacker does not own** (A2).
The mitigations therefore all converge on "authorize the actor and the chat before any destructive
step, refuse without side effects".

### Supply chain

| threat | risk | mitigation | tests |
|---|---|---|---|
| T-SC1 Known-vulnerable dependencies | R58 (CWE-1104) | `npm audit` gate in CI; current finding: **4 moderate** in the dev-only chain `drizzle-kit → @esbuild-kit/{esm-loader,core-utils} → esbuild ≤ 0.24.2` (GHSA-67mh-4wv8-2f99, dev-server CORS issue) — not in the production dependency set, no runtime exposure in the Docker image | scan evidence in `docs/security/report.md` (T9) |

## 7. Assumptions and residual risks

- **D21 matcher assumption** (forwarded messages expose no source `message_id` for group forwards)
  drives the content/date/sender matcher and its collision risks (R17/R18/R22 in the technical
  register). Not verifiable without real Telegram calls (plan §3) — tracked as a risk.
- **Test protocol assumption**: the security/acceptance tests discover `/settings` and dialog
  buttons from the bot's own reply markup and require `callback_data` to reference the target chat
  id (see the `connectChat`/`pickSourceChat` helpers in `tests/security/*.test.ts`). If the
  implementation chooses another encoding, the helpers and the UI are updated together.
- Draft state is keyed per author (D17) with a 15-minute timeout; no rate limiting beyond Telegram's
  own flood control is planned this iteration (residual DoS exposure: T-D2 mitigations only).
- DB contents (message index) are as sensitive as the chats themselves; DB access control is out of
  this iteration's scope (infra/Helm `existingSecret`, D14).
- Real webhook transport enforcement (`X-Telegram-Bot-Api-Secret-Token` matching) is implemented in
  T7 and reviewed in T9; SEC-11 pins the fail-closed configuration gate.

### Alignment note (2026-10-29, D79/D82)

Security-test fixture alignment with plan decisions D79/D80 — spec fixes, no property weakened:

- **D79**: `/settings` chat discovery only lists chats the bot has *observed* (`my_chat_member`
  and message updates) with admin membership — correct behaviour (Telegram has no "list my chats"
  API). The `connectChat` helpers in `tests/security/{authz,deletion-safety,dialog-abuse,secrets}.test.ts`
  now seed that discovery signal (a `my_chat_member` admin update + one observed message per chat,
  mirroring the acceptance `botIsAdminOf` seeding) before driving `/settings`. All security
  assertions are unchanged; only fixture plumbing was added.
- **D80**: `ADMIN_IDS="1,,2"` is now asserted to parse to `[1, 2]` (empty entries ignored, trimmed)
  in SEC-12 instead of being rejected. Fail-closed coverage kept for non-numeric (`abc`, `1,abc`,
  `NaN`, `900001; DROP TABLE users`), empty/whitespace-only and unsafe-integer entries. Security
  consequence of the `1,,2` tolerance: none — `ADMIN_IDS` comes from the operator-controlled
  process environment (never from user input) and the parsed admin set is exactly `{1, 2}`.

## 8. Mitigation test map

| test | property | risks |
|---|---|---|
| SEC-1 | non-admin transfer refused, nothing deleted (with admin positive control) | R3, R48 |
| SEC-2 | lost delete rights fail safe; no stack traces/secrets in chat output | R11 |
| SEC-3 | non-global-admin `/settings` + forged settings callbacks are inert | R49 |
| SEC-4 | forged callback from another user cannot touch the draft | R50 |
| SEC-5 | hostile callback payloads: no crash, no state change | R50 |
| SEC-6 | attacker content delivered as data, never markup | R52, R59 |
| SEC-7 | replayed transfer refused: zero deletions, no second announce | R51 |
| SEC-8 | BOT_TOKEN/DATABASE_URL never in logs or chat output | R55, R61 |
| SEC-9 | config errors echo no secrets | R55 |
| SEC-10 | 500-batch capped at 50; `deleteMessages` ≤ 100 ids per call | R53 |
| SEC-11 | `MODE=webhook` fails closed without URL/secret | R56 |
| SEC-12 | malformed `ADMIN_IDS` fails closed | R57 |
| SEC-13 | unconnected chat ignored: no index write, no API side effects | R60 |
| SEC-14 | matcher scoped per chat: twin originals in another chat survive | R54 |
| SEC-15 | fuzz (fast-check, seed 20261028): any update → no crash, no destructive call, no secret leak | R51, R53 |
