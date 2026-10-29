# Security report — telegram-threads-bot (T9: review + scans before the QA gate)

- **Date:** 2026-10-29
- **Author:** `security-engineer`
- **Scope:** the whole change described in `docs/plan.md` (iteration 1): `src/**` (bot logic,
  domain, stores, config, webhook, health, entry), `tests/**`, `Dockerfile`, `.dockerignore`,
  `helm/telegram-threads-bot/**`, `drizzle.config.ts`, `migrations/**`, `package.json` +
  `package-lock.json`. Threat model: `docs/security/threat-model.md` (T-S1..T-SC1).
  Security tests: `tests/security/**` (SEC-1..SEC-15).
- **Out of scope:** real Telegram network calls, live PostgreSQL, cluster deployment (plan §3).

## 1. Commands run and real results

### 1.1 `npm audit`

```
# npm audit report
esbuild  <=0.24.2
Severity: moderate
esbuild enables any website to send any requests to the development server and read the response
  - https://github.com/advisories/GHSA-67mh-4wv8-2f99
fix available via `npm audit fix --force`
Will install drizzle-kit@0.18.1, which is a breaking change
node_modules/@esbuild-kit/core-utils/node_modules/esbuild
  @esbuild-kit/core-utils -> @esbuild-kit/esm-loader -> drizzle-kit 0.19.0 - 1.0.0-beta.1-fd8bfcc

4 moderate severity vulnerabilities
```

`npm ls esbuild` (dependency provenance):

```
drizzle-kit@0.31.11
├─┬ @esbuild-kit/esm-loader@2.6.5 -> @esbuild-kit/core-utils@3.3.2 -> esbuild@0.18.20   <- vulnerable
└── esbuild@0.25.12                                                                     <- clean
tsx@4.23.15 -> esbuild@0.28.2                                                           <- clean
vitest -> vite@8.3.5 -> esbuild@0.28.2 (deduped)                                        <- clean
```

**Assessment.** The vulnerable esbuild sits in the `drizzle-kit → @esbuild-kit/*` chain and is
*loaded* at runtime (the Helm migrate Job runs `drizzle-kit migrate`, which type-strips
`drizzle.config.ts` through `@esbuild-kit/esm-loader`), so it does ship inside the final Docker
image (drizzle-kit is a production dependency by design — see 1.3). However, the vulnerable
*feature* — esbuild's dev/serve HTTP server with permissive CORS — is never started anywhere in
this project: the app (`tsx src/index.ts`) never imports `drizzle-kit`, and the migrate Job only
compiles config and applies SQL. Exploitability for THIS project: **none at runtime**; the issue
is dev-server exposure only. `npm audit fix --force` would downgrade drizzle-kit to 0.18.1 (a
breaking change) — not applied. See finding **SEC-F3** (Low, accepted).

### 1.2 Secret scan (manual grep — gitleaks/semgrep are not installed in this project or machine,
installing them needs approval and was not done)

```
grep -rniE "([0-9]{8,10}:AA[A-Za-z0-9_-]{30,})|api[_-]?key|password|passwd|bearer |private[_-]key|
            BEGIN RSA|BEGIN OPENSSH|sk-[A-Za-z0-9]{20,}|xox[baprs]-" \
     src tests helm Dockerfile migrations drizzle.config.ts
```

Result: **no hardcoded secrets**. The only hits are intentional test material and key *names*:

- `tests/security/dialog-abuse.test.ts:415` — `"../../../etc/passwd"` fuzz payload (SEC-5).
- `helm/.../deployment.yaml:45-57`, `migrate-job.yaml:37-41`, `configmap.yaml:8`, `values.yaml:23-24`,
  `NOTES.txt:4-11` — `secretKeyRef` / documentation references to `BOT_TOKEN`, `DATABASE_URL`,
  `WEBHOOK_SECRET` key names; all values come from `values.existingSecret` (D14), never from values
  or templates. `migrations/**` is clean.

Code-side secret handling verified: `loadConfig` error messages name variables but never echo
values (`src/config.ts:27-35,54`); every catch block logs `error.name` only
(`src/bot/createBot.ts:77,189,552,595`, `src/store/pg.ts:415-418`, `src/webhook.ts:71-74`) —
no raw error objects (grammY errors can embed the token-bearing request URL, trust boundary 2);
`process.env` is read only in `src/index.ts:19` through `loadConfig`; no `console.*` in `src/`.

### 1.3 Dependency / runtime surface of the final Docker image

`npm ci --omit=dev` installs the production set: `grammY`, `drizzle-orm`, `pg`, `pino`, `zod`,
`@lingui/core`, `@lingui/message-utils`, **`tsx`** and **`drizzle-kit`** (intentional per the
Dockerfile comments and AGENTS.md: the app runs through tsx, the migrate Job runs drizzle-kit).
Assessment:

- Image runs as non-root `node`, contains no devDependencies (vitest/fast-check/typescript
  absent), `npm cache clean` after install, multi-stage build with a typecheck gate.
- `tsx` bundles esbuild 0.28.2 — no advisories. Its role is a TS runtime compiler: acceptable
  documented trade-off (D14/D15), it widens the supply-chain surface compared to a prebuilt JS
  bundle — recorded as **SEC-F4** (Info, accepted).
- `drizzle-kit` in the runtime image is what pulls the vulnerable esbuild 0.18.20 (SEC-F3).
- `ENTRYPOINT ["npm", "start"]` spawns npm as an extra process layer (documented trade-off).

### 1.4 Test suite (evidence that the mitigation tests are green)

```
npm test  ->  Test Files 24 passed (24), Tests 198 passed (198)   (vitest run, 1.59s)
npx vitest run tests/security -> Test Files 6 passed (6), Tests 16 passed (16)
```

SEC-1..SEC-15 all green (`tests/security/{authz,config-env,deletion-safety,dialog-abuse,fuzz-updates,secrets}.test.ts`).

## 2. Manual code review against the threat model

| threat | verified in code | verdict |
|---|---|---|
| T-S1 non-admin transfer | `isSourceAdmin(picked, authorId)` gate before `executeTransfer`, unless already authorized at pick time (`src/bot/createBot.ts:488-494`); dialog pick re-checks admin (`:947-951`); refusal has no side effects. SEC-1 green (with admin positive control) | mitigated |
| T-S2 non-global-admin settings | `isGlobalAdmin` on `/settings` (`:787`), settings callbacks (`:864`), lang callbacks (`:919`); refusals carry no chat list (SEC-3 asserts no admin UI leak) | mitigated |
| T-S3 forged/stale callbacks | drafts keyed by author (`getDraft(threadsChatId, userId)`, `:938`); foreign/stale → inert return (`:939`); `answerCallbackQuery` best-effort (`:1005`) | mitigated |
| T-S4 replay / duplicate | whole-batch duplicate check *before any side effect* (`:523-544`); mapped messages refused, zero deletions (SEC-7); fuzz entry hardened (SEC-15) | mitigated |
| T-S5 chat impersonation | `indexMessage` writes only for connected source chats (`:220`); transfer candidates require `source` (`:946`); unconnected chats inert (SEC-13) | mitigated |
| T-S6 ADMIN_IDS parsing | `parseAdminIds` fail-closed: any non-numeric/unsafe entry throws `ConfigError`, no partial sets (`src/config.ts:47-62`); empty list rejected (`:60`) | mitigated (SEC-12) |
| T-S7 webhook forgery | `MODE=webhook` refuses to boot without URL **and** non-empty secret (`src/config.ts:110-136`); listener rejects missing header 401 / mismatch 403 **before** any update handling (`src/webhook.ts:88-93`); comparison via `timingSafeEqual` (`:34-38`); grammY `secretToken` re-check as defence in depth (`:119`) | mitigated |
| T-T1/T-T2 markup injection | no `parse_mode`/`entities` anywhere in `src/` (grep verified); attacker text (titles, texts) sent as plain data; URLs are bot-built (`src/domain/links.ts`) | mitigated (SEC-6) |
| T-T3 matcher abuse | matcher scoped to `store.listSourceMessages(chatId)` (`src/bot/createBot.ts:519-521`); unique-or-none (`src/domain/matcher.ts:31-34`); ambiguous ⇒ nothing deleted (SEC-14) | mitigated |
| T-T4 SQL injection | all queries are schema-typed Drizzle builder calls (`src/store/pg.ts`); the only raw fragment is `sql\`select 1\`` (`:392`) | mitigated (review) |
| T-R1 audit trail | `threads.createdBy` persisted (`src/store/pg.ts:134`) and `transfer_refused_duplicate`/`source_picked` log the actor; `transfer_completed` now logs initiator, chats, thread root, deleted ids and D74 class counts (ids only, no text/secrets) | mitigated (SEC-F1 fixed in T7 follow-up) |
| T-I1 secret leakage | see 1.2; SEC-8/SEC-9 green; boot-time failures now go through `src/boot-report.ts` sanitization (error name only) | mitigated (SEC-F2 fixed in T7 follow-up) |
| T-I2 admin UI leak | refusals are static localized strings; chat enumeration only inside the admin's own settings message (SEC-3) | mitigated |
| T-I3 stack traces to users | user-facing failures are localized i18n strings (`transfer.failure`, `dialog.*`); internals only in logs as `error.name` (SEC-2) | mitigated |
| T-D1 oversized batches | `truncateEntities(entities, config.batchLimit)` cap 50 (`:517`); `chunkIds` ≤ 100 per `deleteMessages` (`src/domain/deletion.ts:12-19`); SEC-10 pins a 500-message batch → 50 | mitigated |
| T-D2 crash on hostile input | `bot.catch` (`:74-78`); unknown callback payloads inert (`:1026`); webhook handler failures answered 400 without killing the server (`src/webhook.ts:67-79`); SEC-5/SEC-15 green | mitigated |
| T-D3 retry_after | `retryAfterMs` honoured in `withRetry429` (`:201-212`) and every delete path (`:727-744,759-762`), D24/D78 | mitigated (ACC-10/21 cover behaviour) |
| T-SC1 vulnerable deps | see 1.1 | accepted → SEC-F3 |

## 3. Findings

| ID | severity | CWE | location | description | recommendation | status |
|---|---|---|---|---|---|---|
| SEC-F1 | Medium | CWE-778 | `src/bot/createBot.ts:661-668` | The `transfer_completed` structured log records chats, root id and counts but **not the initiator (`authorId`) and not the deleted message ids**, which threat model T-R1/R61 requires for attribution of destructive transfers. Attribution is only recoverable indirectly from the DB (`threads.createdBy`, `thread_messages.sourceMessageId`); `transfer_refused_duplicate`/`source_picked` do log the actor, so the gap is inconsistent. Impact: an initiator of a destructive transfer can plausibly deny having ordered the deletions if DB access is unavailable to the auditor (repudiation). | Add `authorId` and `deletedMessageIds` (or `notDeletedIds` + counts per chat) to the `transfer_completed` log record in `src/bot/createBot.ts`. Hand to `software-engineer`. | **mitigated** — fixed in T7 follow-up (audit record now carries `authorId`, `sourceChatId`, `threadsChatId`, `rootMessageId`, `deletedMessageIds` + D74 class counts, ids only), pinned by `tests/unit/transfer-audit-log.test.ts` |
| SEC-F2 | Low | CWE-532 | `src/index.ts:28,35` | Boot-time failures (`store.load()`, `bot.api.setWebhook(...)` — and any top-level await) bypass `bot.catch`'s sanitization: an unhandled rejection makes Node print the raw error (stack + message) to stderr. Per trust boundary 2, grammY error objects may embed the request URL containing `BOT_TOKEN`. Impact: low — only on boot failure, to log collectors; current grammY error messages carry the method name but the sanitization rule (log `error.name` only) is violated on this path. | Wrap the boot sequence in `try/catch` that logs `error instanceof Error ? error.name : "unknown"` and exits non-zero. Hand to `software-engineer`. | **mitigated** — fixed in T7 follow-up (`main()` catch → `src/boot-report.ts` `reportBootFailure`, error name only; raw stderr printing removed), pinned by `tests/unit/boot-failure.test.ts` |
| SEC-F3 | Low | CWE-1104 | `package.json` (`drizzle-kit` dep), `node_modules/@esbuild-kit/core-utils` | esbuild ≤ 0.24.2 (GHSA-67mh-4wv8-2f99, 4 moderate) ships inside the runtime image via `drizzle-kit → @esbuild-kit/{esm-loader,core-utils}`; drizzle-kit is a production dependency by design (Helm migrate Job). The vulnerable dev-server code path is never started (see 1.1) — no runtime exposure. `npm audit fix --force` would break drizzle-kit (downgrade to 0.18.1). | Keep the `npm audit` CI gate; re-check when drizzle-kit drops the `@esbuild-kit` chain (upstream), or run migrations from a separate image and move drizzle-kit out of the runtime set. Rotate nothing; no exploit path today. | accepted |
| SEC-F4 | Info | CWE-1104 | `Dockerfile`, `package.json` | Runtime dependency surface includes `tsx` (TS runtime compiler, esbuild 0.28.2) and `drizzle-kit` — larger supply-chain surface than a prebuilt bundle. Mitigations present: non-root user, no devDependencies in the final image, multi-stage typecheck gate, committed lockfile. | Documented trade-off (D14/D15); revisit if the project later gains a build step. | accepted |
| SEC-F5 | Info | CWE-770 | `src/bot/createBot.ts:385` | `draft.batch.push(incoming)` is unbounded within the 15-minute draft window; the batch cap (50) applies only at transfer time. A user in the threads chat can grow one draft's memory/DB row arbitrarily. Known residual risk (threat model §7: no rate limiting this iteration). | If needed later: cap `draft.batch` length (refuse with the truncation warning) or add per-author rate limiting. | accepted |
| SEC-F6 | Info | CWE-208 | `src/webhook.ts:34-38` | `secretEquals` short-circuits on length mismatch, so timing reveals only the *length* of the webhook secret; equal-length comparison is constant-time. Matches the documented guarantee ("constant-time for equal lengths"); Telegram secrets are high-entropy. | No change required; keep the header check as is. | accepted |

## 4. Summary

| severity | count | open | accepted | mitigated |
|---|---|---|---|---|
| Critical | 0 | 0 | 0 | 0 |
| High | 0 | 0 | 0 | 0 |
| Medium | 1 | 0 | 0 | 1 (SEC-F1) |
| Low | 2 | 0 | 1 (SEC-F3) | 1 (SEC-F2) |
| Info | 3 | 0 | 3 (SEC-F4..F6) | 0 |

Mitigation tests: SEC-1..SEC-15 all exist and pass (16 tests, 6 files). All T-S1..T-SC1
mitigations were verified in code (§2). Security risk statuses in `docs/risk-register.md`
(R48–R61) updated accordingly.

## 5. VERDICT

**VERDICT: NO — there are no open Critical/High findings.** The QA gate may proceed. The two
lower-severity findings were mitigated in the T7 follow-up (SEC-F1 Medium — audit-log completeness
for R61, pinned by `tests/unit/transfer-audit-log.test.ts`; SEC-F2 Low — boot-path error
sanitization, pinned by `tests/unit/boot-failure.test.ts`); SEC-F3..F6 remain accepted as decided.
