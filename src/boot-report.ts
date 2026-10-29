/**
 * Boot failure reporting (SEC-F2, R55): startup errors are reported through
 * the same sanitization rule as `bot.catch` — only the error class name is
 * logged. Raw error objects (message, stack, custom fields) can embed the
 * request URL with the bot token (trust boundary 2), so they must never reach
 * the logs or stderr.
 */
export interface BootLogger {
  fatal(...args: unknown[]): void;
}

/** Sanitized boot failure record: error name only — never message/stack/object. */
export function bootFailureFields(error: unknown): { event: "boot_failed"; error: string } {
  return { event: "boot_failed", error: error instanceof Error ? error.name : "unknown" };
}

/** Reports a boot failure through the sanitized logger — and nothing else. */
export function reportBootFailure(logger: BootLogger, error: unknown): void {
  logger.fatal(bootFailureFields(error));
}
