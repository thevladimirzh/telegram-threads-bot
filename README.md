# telegram-threads-bot

A Telegram bot that moves a discussion out of a main chat into a "threads chat" as a named
reply thread. Flow: a user forwards 1–50 messages from a connected source chat into the
threads chat → picks the source chat (preselected from `forward_origin` when known) and gives
a thread title (1–255 chars) → the bot creates a reply thread whose root is the title message,
copies the forwarded messages into it as bot messages (albums stay grouped, polls/service
content becomes a `[poll] …`-style placeholder) and closes the thread with a link back to the
source → the forwarded copies and the originals in the source chat are deleted (batched,
`retry_after` respected) → an announce with a link to the thread is posted in the source chat
(same topic for forums). Partial deletion failures are reported inside the thread; already
transferred messages are refused with a link to the existing thread. Dialog, announce and
reports are localized (en/ru).

## Stack

TypeScript (strict, run via `tsx`) · [grammY](https://grammy.dev) · Drizzle ORM + PostgreSQL ·
[Lingui](https://lingui.dev) (en/ru) · Zod (env config) · pino (JSON logs) ·
Vitest 5 + fast-check 4 · Docker + Helm.

## Quickstart

1. Copy `.env.example` to `.env` and fill it in (see the table below).
2. `npm ci` — install from `package-lock.json`.
3. `npm test` — run the full suite (must be green).
4. `npm start` — run the bot (`tsx src/index.ts`).

### Environment variables

| name | description |
|---|---|
| `BOT_TOKEN` | Telegram bot token from @BotFather |
| `ADMIN_IDS` | Comma-separated Telegram user ids of global admins |
| `DATABASE_URL` | PostgreSQL connection string |
| `MODE` | `polling` (default) or `webhook` |
| `PORT` | HTTP port for `/health` and `/ready` (default 8080) |
| `WEBHOOK_URL` | Public HTTPS URL for Telegram updates (`MODE=webhook` only) |
| `WEBHOOK_SECRET` | `X-Telegram-Bot-Api-Secret-Token` for webhook requests (`MODE=webhook` only) |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | Database container setup (docker-compose) |

## Tests & CI

- `npm test` — the clean test command: unit, property-based (fast-check), acceptance and
  security tests. Deterministic by design: no real network (tests drive the bot through an
  in-process fake Bot API), no real clock, no real database, fixed seeds.
- `npm run typecheck` — `tsc --noEmit`.
- CI (`.github/workflows/ci.yml`) runs typecheck + tests on Node 26, builds the Docker image
  and lints/templates the Helm chart on every push to `main` and every pull request.

## Deploy

### VPS (Docker Compose)

On the server (`/opt/telegram-threads-bot`):

1. Put `BOT_TOKEN`, `ADMIN_IDS`, `DATABASE_URL`, `POSTGRES_*` into `.env` (`chmod 600`).
2. `docker compose build`
3. `docker compose up -d db` and wait until it is healthy.
4. `docker compose run --rm --entrypoint npm app run db:migrate`
5. `docker compose up -d`

### Kubernetes (Helm)

Chart: `helm/telegram-threads-bot`. Create a Secret with `BOT_TOKEN` and `DATABASE_URL`
(and `WEBHOOK_SECRET` for webhook mode) out of band and point `existingSecret` at it.
Migrations run automatically in a pre-install/pre-upgrade hook Job.

```sh
helm upgrade --install telegram-threads-bot helm/telegram-threads-bot \
  --set image.repository=<your-registry>/telegram-threads-bot --set image.tag=<tag>
```

`values.mode: polling|webhook` switches update delivery; keep `replicaCount: 1` in polling mode.

## Operational notes

- The bot must be **admin in both chats** (source and threads) with the
  `can_delete_messages` right: it deletes the forwarded copies and the originals.
- **Privacy mode must be disabled** (`/setprivacy` → Disable in @BotFather): the bot indexes
  source-chat messages to match forwarded copies to their originals, which requires seeing
  every message.
- Global admins configure everything via `/settings` in a DM with the bot; thread creation is
  limited to admins of the chosen source chat.
- Telegram API limits are respected (`deleteMessages` ≤ 100 ids per call, `retry_after`
  honored); the bot logs JSON (pino) to stdout and serves `/health` (liveness) and `/ready`
  (DB ping).

## Security

- **Never commit `.env`** — it is gitignored for a reason; keep secrets in env vars or a
  secret store (Kubernetes Secret via `existingSecret`).
- If the bot token ever leaks, **rotate it immediately** with @BotFather and update the
  deployment secret.
