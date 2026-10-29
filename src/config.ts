/**
 * Startup configuration (plan §7.1, D80, SEC-9/11/12).
 *
 * `loadConfig(env)` validates the environment with Zod and throws a typed
 * `ConfigError` on invalid input (fail closed). Error messages name the
 * offending variable but never echo its value — BOT_TOKEN / DATABASE_URL
 * material must never reach logs or error output (R55).
 */
import { z } from "zod";

export interface AppConfig {
  botToken: string;
  databaseUrl: string;
  adminIds: number[];
  mode: "polling" | "webhook";
  webhookUrl?: string;
  webhookSecret?: string;
  /** D86: POST path serving webhook updates (the pathname of `webhookUrl`). */
  webhookPath?: string;
  /** HTTP port for /health, /ready (and the webhook listener) — `PORT`, default 8080. */
  port: number;
  draftTimeoutMs: number;
  batchLimit: number;
}

/** Typed configuration error: names the offending variables, never their values. */
export class ConfigError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid configuration: ${issues.join("; ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

const adminIdSchema = z
  .string()
  .regex(/^\d+$/, "must be a positive integer")
  .transform((raw) => Number(raw))
  .refine((n) => Number.isSafeInteger(n) && n > 0, "must be a positive safe integer");

/**
 * D80: entries are trimmed, empty entries ignored; any non-numeric entry fails
 * config load (fail-closed); the resulting admin set must be non-empty.
 */
function parseAdminIds(raw: string): number[] {
  const parts = raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  const issues: string[] = [];
  const ids: number[] = [];
  for (const part of parts) {
    const parsed = adminIdSchema.safeParse(part);
    if (!parsed.success) {
      issues.push(`ADMIN_IDS entry ${JSON.stringify(part)} is not a positive integer`);
    } else if (!ids.includes(parsed.data)) {
      ids.push(parsed.data);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
  if (ids.length === 0) throw new ConfigError(["ADMIN_IDS must list at least one admin id"]);
  return ids;
}

function requireString(env: Record<string, string | undefined>, name: string, issues: string[]): string {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    issues.push(`${name} is required`);
    return "";
  }
  return raw;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const issues: string[] = [];

  const botToken = requireString(env, "BOT_TOKEN", issues);

  const databaseUrlRaw = requireString(env, "DATABASE_URL", issues);
  if (databaseUrlRaw !== "") {
    try {
      const url = new URL(databaseUrlRaw);
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
        issues.push("DATABASE_URL must be a postgresql:// URL");
      }
    } catch {
      issues.push("DATABASE_URL must be a valid URL");
    }
  }

  let adminIds: number[] = [];
  const adminRaw = env.ADMIN_IDS;
  if (adminRaw === undefined) {
    issues.push("ADMIN_IDS is required");
  } else {
    try {
      adminIds = parseAdminIds(adminRaw);
    } catch (error) {
      if (error instanceof ConfigError) issues.push(...error.issues);
      else issues.push("ADMIN_IDS is invalid");
    }
  }

  const modeRaw = env.MODE ?? "polling";
  const mode = z.enum(["polling", "webhook"]).safeParse(modeRaw);
  if (!mode.success) issues.push('MODE must be "polling" or "webhook"');

  let webhookUrl: string | undefined;
  let webhookSecret: string | undefined;
  let webhookPath: string | undefined;
  if (mode.success && mode.data === "webhook") {
    const missing: string[] = [];
    const urlRaw = env.WEBHOOK_URL;
    if (urlRaw === undefined || urlRaw.trim() === "") {
      missing.push("WEBHOOK_URL");
    } else {
      try {
        const url = new URL(urlRaw);
        if (url.protocol !== "https:" && url.protocol !== "http:") missing.push("WEBHOOK_URL");
        else {
          webhookUrl = urlRaw;
          // D86: updates are served on the configured path — the WEBHOOK_URL
          // pathname Telegram posts to (query string excluded).
          webhookPath = url.pathname;
        }
      } catch {
        missing.push("WEBHOOK_URL");
      }
    }
    const secretRaw = env.WEBHOOK_SECRET;
    if (secretRaw === undefined || secretRaw.trim() === "") {
      missing.push("WEBHOOK_SECRET");
    } else {
      webhookSecret = secretRaw;
    }
    for (const name of missing) issues.push(`${name} is required in webhook mode`);
  }

  const draftTimeoutMs = parsePositiveInt(env.DRAFT_TIMEOUT_MS, "DRAFT_TIMEOUT_MS", 900000, issues);
  const batchLimit = parsePositiveInt(env.BATCH_LIMIT, "BATCH_LIMIT", 50, issues);
  const port = parsePositiveInt(env.PORT, "PORT", 8080, issues);

  if (issues.length > 0) throw new ConfigError(issues);

  return {
    botToken,
    databaseUrl: databaseUrlRaw,
    adminIds,
    mode: mode.success ? mode.data : "polling",
    ...(webhookUrl !== undefined ? { webhookUrl } : {}),
    ...(webhookSecret !== undefined ? { webhookSecret } : {}),
    ...(webhookPath !== undefined ? { webhookPath } : {}),
    port,
    draftTimeoutMs,
    batchLimit,
  };
}

function parsePositiveInt(
  raw: string | undefined,
  name: string,
  fallback: number,
  issues: string[],
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) {
    issues.push(`${name} must be a positive integer`);
    return fallback;
  }
  return n;
}
