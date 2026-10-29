# AGENTS.md — project profile

Project: **telegram-threads-bot** — a Telegram bot that moves a discussion from a main chat into a
"threads chat" as a named reply thread. `docs/plan.md` is the single source of truth (requirements,
scope, decisions D1–D25); read it first. This file defines the stack, commands, layout and hard
constraints for all role agents.

## Stack & toolchain

- Node.js LTS (`engines: >=22`; developed on Node 26), **npm** with a committed `package-lock.json`.
- TypeScript 7, `strict: true`, `noEmit: true` (no build step; the app runs through `tsx`).
- grammY (bot framework), Drizzle ORM + `pg` (PostgreSQL), Zod (env config), pino (JSON logs),
  Lingui `@lingui/core` (i18n, runtime catalogs — no Babel macros).
- Tests: **Vitest 5** + **fast-check 4** (property-based). BDD: Gherkin `*.feature` files
  (documentation + acceptance tests mirror them 1:1; no Gherkin runner).
- `drizzle-kit` for schema tooling (generate/compile-check migrations).

## Commands (exact)

| command | meaning |
|---|---|
| `npm test` | **the clean test command** — runs the whole suite once (`vitest run`); must be green at all times |
| `npm run test:watch` | Vitest watch mode |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `tests/`, `vitest.config.ts` |
| `npm start` | runs `src/index.ts` via `tsx` (also the Docker image entrypoint) |
| `npm run db:generate` | `drizzle-kit generate` — offline SQL migrations from `src/store/schema.ts` → `./migrations` |
| `npm run db:migrate` | `drizzle-kit migrate` — applies `./migrations` to `DATABASE_URL` (Helm pre-install/pre-upgrade Job) |
| `npm ci && npm test` | clean-state verification (from a fresh checkout) |

If npm installs fail with `EACCES` in `~/.npm/_cacache` (this machine has root-owned files there),
use `npm_config_cache=/private/var/folders/49/shvp1sp55xn4__vy97b6kpz80000gn/T/opencode/npm-cache`.

## Layout & ownership (who may edit what)

| path | purpose | owner |
|---|---|---|
| `src/**` | production code (`src/index.ts` = entry) | `software-engineer` |
| `src/i18n/**` | Lingui setup + `locales/en.ts`, `locales/ru.ts` catalogs | `software-engineer` |
| `tests/unit/**` | unit tests + property-based tests (fast-check) | `software-engineer` |
| `tests/acceptance/**` | black-box acceptance tests (updates driven into the bot) | `qa-engineer` |
| `tests/security/**` | security/abuse-case tests | `security-engineer` |
| `tests/features/*.feature` | Gherkin scenarios (tagged with risk IDs) | `business-analyst` |
| `tests/helpers/**` | shared test tooling (fake Bot API, fixtures) | `devops-sre` |
| `docs/plan.md` | plan, decisions, tasks | `project-manager` (read-only for others) |
| `docs/risk-register.md` | risk register (RBT) | `product-manager`, `qa-engineer`, `security-engineer` |
| `docs/spec/**` | spec decisions | `business-analyst` |
| `docs/qa/**` | QA verdict | `qa-engineer` |
| `docs/security/**` | threat model, security report | `security-engineer` |
| `docs/product/**` | product materials | `product-manager` |
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `AGENTS.md`, Docker/Helm | build & toolchain | `devops-sre` |

Note: the session permission layer additionally write-protects `tests/unit/`, `tests/acceptance/`,
`tests/security/`, `tests/features/*.feature`, `docs/spec/`, `docs/qa/`, `docs/security/` for
`devops-sre`. The bootstrap smoke tests therefore live in `tests/helpers/*.smoke.test.ts`;
`software-engineer` may move them to `tests/unit/` (leaf names `unit/`, `acceptance/`, `security/`,
`features/` must stay as-is so role permissions match).

## Test tooling

- **Fake Bot API** — `tests/helpers/fake-bot-api.ts` (plan D13):
  - `createTestBot()` returns `{ bot, api }` where `api` is a `FakeBotApi` installed as a grammY
    client transformer via `bot.api.config.use(api.transformer)` (grammY 1.46 has no
    `client: { transformer }` option; `api.config.use` is the supported entry point). No network:
    the transformer never calls the upstream fetch.
  - `api.calls` records every API call in order (`method` + payload); `api.callsOf(method)` filters.
  - `setMethodResult(method, value | handler)` — canned results; a function receives the call
    payload and may return `new FakeApiError({...})` to fail (e.g. 429 once, then succeed).
  - `setMethodError(method, { error_code, description?, retry_after?, migrate_to_chat_id? })` —
    permanent Telegram-style failure; grammY throws `GrammyError` with `parameters.retry_after`.
  - Defaults exist for `getMe`, `sendMessage`, `copyMessage`, `copyMessages`, `forwardMessage`,
    `deleteMessage`, `deleteMessages`, `getChat`, `getChatMember`, `getChatAdministrators`,
    `answerCallbackQuery`, `editMessageText`. Any other method throws — register a canned result.
  - Deterministic: fixed `FIXED_DATE` instead of the real clock, sequential message ids per
    instance, `reset()` clears state.
- Tests drive the bot through `bot.handleUpdate(update)` against this fake; never construct real
  network clients.

## i18n (Lingui without Babel/macros)

- Runtime catalogs under `src/i18n/locales/{en,ru}.ts` (plain TS `Messages` records), loaded by
  `src/i18n/index.ts` (`createI18n(locale)`); messages are compiled on the fly by
  `@lingui/message-utils/compileMessage`. This works in Vitest and under `tsx` with **no build
  plugins**.
- Adding a message: choose an explicit id (e.g. `settings.title`), add the **same key** to both
  catalogs, then use `i18n._("settings.title", values)` / `i18n.t`. Keep key sets identical.
- Do **not** introduce `@lingui/macro` or Babel plugins — they require a build step and break Vitest.
- Locales: `en` (default) + `ru`; locale is chosen by `language_code` and can be switched manually
  in `/settings` (D19). No extraction pipeline yet; if ids must become type-safe later, augment
  `Register` in a `src/lingui.d.ts` per the Lingui docs.

## Deploy artifacts (T8, D14/D15/D86)

- `Dockerfile` (multi-stage: deps → typecheck gate → runtime `node:26-slim`, non-root `node`,
  `npm ci --omit=dev`, `ENTRYPOINT ["npm", "start"]` → `tsx src/index.ts`, `PORT` default 8080,
  `HEALTHCHECK` on `/health`). `tsx` and `drizzle-kit` are **production** dependencies on purpose:
  the app runs through tsx and the migrate Job runs `drizzle-kit migrate`, while the final image
  must contain no devDependencies. `.dockerignore` keeps tests/docs/helm out of the build context.
- `drizzle.config.ts` → schema `src/store/schema.ts`, out `./migrations` (committed).
- Helm chart `helm/telegram-threads-bot/`: Deployment (replicaCount 1 — ordered update handling),
  ConfigMap env + `existingSecret` (BOT_TOKEN, DATABASE_URL; webhook secret = same secret,
  key `webhook.secretKey`), pre-install/pre-upgrade hook Job (`npm run db:migrate`),
  probes on `/health` (liveness) and `/ready` (readiness), optional TLS Ingress for webhook mode,
  `values.mode: polling|webhook` (default polling).
- Runtime wiring (D85/D86): `src/index.ts` builds `PgStore` (Drizzle + pg pool) from `DATABASE_URL`
  (`InMemoryStore` is test-only), and serves `/health`/`/ready` via `src/health.ts` (polling mode) or
  `src/webhook.ts` (webhook mode, secret validation). The listener port comes from `src/config.ts`
  (`PORT`, default 8080) and matches the chart's `containerPort`.

## Hard constraints (docs/plan.md §5 + decisions)

- **Deterministic tests**: no real network (fake Bot API only), no real clock (inject time),
  fixed seeds for fast-check; no timers in tests.
- **Tests never touch a real database**: repositories are covered through the in-memory store; the
  Drizzle schema is compile-checked only (D25).
- Telegram API limits are respected: `deleteMessages` ≤ 100 ids per call; `retry_after` is honored
  everywhere (D24).
- The bot is admin in both chats with `can_delete_messages`; privacy mode must be disabled.
- **Do not weaken or edit tests to make them green — fix the code.**
- Real Telegram network calls are out of scope this iteration.
- All user-facing strings go through i18n (ru/en).

## VCS gotchas

- Commit `package-lock.json` (never gitignore it); `node_modules/` is gitignored.
- Empty directories need a `.gitkeep` (`tests/features/` has one; `tests/acceptance/` and
  `tests/security/` still need theirs from their owners).
