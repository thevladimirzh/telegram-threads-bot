/**
 * Webhook serving (D86, R56): grammY `webhookCallback` behind a small HTTP
 * request listener. POST updates are served on the configured path; every
 * request must carry `X-Telegram-Bot-Api-Secret-Token` matching the
 * configured secret — missing → 401, wrong → 403, and NO update handling
 * (the bot is not even initialized) on either (R56). /health and /ready run
 * on the same server (D20/D61).
 *
 * Deterministically testable: `createWebhookListener` takes the update
 * handler as a dependency and works on plain req/res objects; production
 * wires the grammY callback via `createWebhookHandler`/`createWebhookServer`.
 */
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { webhookCallback, type Bot } from "grammy";
import { healthCheck, readyCheck, type HealthDeps, type HealthResponse } from "./health.js";

const SECRET_HEADER = "x-telegram-bot-api-secret-token";

export type SecretCheck =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: "missing" | "mismatch" };

/**
 * Validates the Telegram secret-token header (R56). Comparison is
 * constant-time for equal lengths; the result never reveals the secret.
 */
export function checkWebhookSecret(header: string | string[] | undefined, secret: string): SecretCheck {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return { ok: false, status: 401, reason: "missing" };
  return secretEquals(value, secret) ? { ok: true } : { ok: false, status: 403, reason: "mismatch" };
}

function secretEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The update handler shape (grammY `webhookCallback(bot, "http", ...)`). */
export type WebhookHandler = (req: IncomingMessage, res: ServerResponse) => unknown | Promise<unknown>;

export interface WebhookLogger {
  warn(obj: unknown, msg?: string): void;
}

export interface WebhookListenerDeps {
  /** POST path serving Telegram updates (configurable via WEBHOOK_URL). */
  path: string;
  secret: string;
  handle: WebhookHandler;
  health: HealthDeps;
  logger?: WebhookLogger;
}

/**
 * Routes one HTTP request: webhook path (secret gate → handler), /health,
 * /ready, everything else 404. A failing handler answers 400 and never
 * crashes the server. The returned promise resolves when the response is
 * complete (awaitable in tests).
 */
export function createWebhookListener(
  deps: WebhookListenerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { path, secret, handle, health, logger } = deps;

  return async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      logger?.warn({
        event: "webhook_handler_failed",
        error: error instanceof Error ? error.name : "unknown",
      });
      if (!res.writableEnded) {
        res.writeHead(400, { "content-type": "text/plain" }).end("bad_request");
      }
    }
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === path) {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain" }).end("method_not_allowed");
        return;
      }
      const check = checkWebhookSecret(req.headers[SECRET_HEADER], secret);
      if (!check.ok) {
        // R56: no update handling (and no bot.init) on a failed secret check.
        res.writeHead(check.status, { "content-type": "text/plain" }).end(check.reason === "missing" ? "unauthorized" : "forbidden");
        return;
      }
      await handle(req, res);
      return;
    }
    if (pathname === "/health") {
      answer(res, await healthCheck(health));
      return;
    }
    if (pathname === "/ready") {
      answer(res, await readyCheck(health));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ status: "not_found" }));
  }
}

function answer(res: ServerResponse, response: HealthResponse): void {
  res.writeHead(response.status, { "content-type": "application/json" }).end(response.body);
}

/**
 * The grammY webhook handler (D86). The secret is validated by
 * `createWebhookListener` first; grammY re-checks it (constant-time) as
 * defence in depth via the `secretToken` option.
 */
export function createWebhookHandler(bot: Bot, secret: string): WebhookHandler {
  return webhookCallback(bot, "http", { secretToken: secret });
}

/** Production wiring: one HTTP server with webhook + /health + /ready. */
export function createWebhookServer(
  deps: { path: string; secret: string; bot: Bot; health: HealthDeps; logger?: WebhookLogger },
  port = 8080,
): Server {
  const listener = createWebhookListener({ ...deps, handle: createWebhookHandler(deps.bot, deps.secret) });
  const server = createServer((req, res) => void listener(req, res));
  server.listen(port);
  return server;
}
