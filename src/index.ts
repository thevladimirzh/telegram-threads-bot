/**
 * Entry point (T7/T8): boots the bot from the environment. Thin by design —
 * `loadConfig` validates the env, the store is built from `DATABASE_URL`
 * (pg pool + Drizzle-backed `PgStore`, D85; `InMemoryStore` stays test-only),
 * `createBot` registers the handlers and the run mode follows `MODE`
 * (D15: polling default, webhook opt-in). The HTTP server (health + webhook)
 * listens on `PORT` (default 8080).
 *
 * SEC-F2/R55: the whole boot sequence runs inside `main()`; any startup
 * failure is reported through the sanitized logger (error name only) and exits
 * non-zero — raw error objects are never printed to stderr.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { pino } from "pino";
import { Pool } from "pg";
import { reportBootFailure } from "./boot-report.js";
import { createBot } from "./bot/createBot.js";
import { loadConfig } from "./config.js";
import { createHealthServer } from "./health.js";
import { PgStore, type PgStoreLogger } from "./store/pg.js";
import { createWebhookServer, type WebhookLogger } from "./webhook.js";

const logger = pino();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const log: PgStoreLogger & WebhookLogger = {
    warn: (obj: unknown, msg?: string) => logger.warn(obj, msg),
  };

  // Real storage at runtime (D85): a pg pool + Drizzle-backed store hydrated
  // from the database; tests keep exercising the in-memory store (D25).
  const pool = new Pool({ connectionString: config.databaseUrl });
  const store = new PgStore(drizzle(pool), { logger: log });
  await store.load();

  const bot = createBot({ store, now: () => new Date(), logger, config });

  logger.info({ event: "boot", mode: config.mode });

  if (config.mode === "webhook") {
    await bot.api.setWebhook(config.webhookUrl as string, {
      secret_token: config.webhookSecret,
    });
    logger.info({ event: "webhook_set", url: config.webhookUrl });
    // D86: POST updates on the configured path, secret-validated (R56);
    // /health and /ready are served by the same HTTP server (D20/D61).
    createWebhookServer(
      {
        bot,
        path: config.webhookPath as string,
        secret: config.webhookSecret as string,
        health: { store },
        logger: log,
      },
      config.port,
    );
  } else {
    createHealthServer({ store }, config.port);
    await bot.start();
  }
}

main().catch((error: unknown) => {
  reportBootFailure(logger, error);
  process.exit(1);
});
