/**
 * Unit tests — sanitized boot failure reporting (SEC-F2, R55, TDD).
 *
 * Boot/startup failures must go through the same sanitization rule as
 * `bot.catch` (R55): only `error.name` is logged; the raw error object —
 * message, stack, custom fields — can embed the request URL with the bot token
 * (trust boundary 2) and must never reach the logs or stderr.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { bootFailureFields, reportBootFailure } from "../../src/boot-report";

function recordingLogger(): { fatal: (...args: unknown[]) => void; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return { fatal: (...args: unknown[]): void => void calls.push(args), calls };
}

const SECRET_MESSAGE = "connect ECONNREFUSED https://api.telegram.org/bot123456:TEST-TOKEN/deleteMessage";
const SECRET_STACK = "Error: boom 123456:TEST-TOKEN\n    at boot (/app/src/index.ts:28:5)";

describe("SEC-F2/R55: boot failures are reported sanitized (error.name only)", () => {
  test("an error carrying a token in message/stack leaks none of it", () => {
    const error = new Error(SECRET_MESSAGE);
    error.stack = SECRET_STACK;
    const logger = recordingLogger();

    reportBootFailure(logger, error);

    expect(logger.calls.length, "exactly one fatal record").toBe(1);
    const args = logger.calls[0];
    expect(args.length, "the record is the only argument — no raw error object follows").toBe(1);
    const record = args[0] as Record<string, unknown>;
    expect(record).not.toBeInstanceOf(Error);
    expect(record).toEqual({ event: "boot_failed", error: "Error" });
    const dump = JSON.stringify(logger.calls);
    expect(dump).not.toContain("TEST-TOKEN");
    expect(dump).not.toContain("ECONNREFUSED");
    expect(dump).not.toContain("stack");
    expect(dump).not.toContain("message");
    expect(dump).not.toContain("index.ts");
  });

  test("the error class name is preserved (ConfigError stays distinguishable)", () => {
    const error = new Error("ADMIN_IDS must be non-empty");
    error.name = "ConfigError";
    const logger = recordingLogger();

    reportBootFailure(logger, error);

    expect(logger.calls[0][0]).toEqual({ event: "boot_failed", error: "ConfigError" });
  });

  test("non-Error thrown values report 'unknown' and leak nothing", () => {
    const logger = recordingLogger();
    for (const value of ["plain string with 123456:TEST-TOKEN", 42, null, undefined, { secret: "123456:TEST-TOKEN" }]) {
      reportBootFailure(logger, value);
    }
    expect(logger.calls.length).toBe(5);
    for (const args of logger.calls) {
      expect(args[0]).toEqual({ event: "boot_failed", error: "unknown" });
    }
    expect(JSON.stringify(logger.calls)).not.toContain("TEST-TOKEN");
    expect(JSON.stringify(logger.calls)).not.toContain("secret");
  });
});

describe("bootFailureFields sanitization properties (fast-check, fixed seed)", () => {
  test("the record has exactly the two safe fields and never echoes message/stack", () => {
    fc.assert(
      fc.property(fc.anything(), (value) => {
        const fields = bootFailureFields(value);
        const keys = Object.keys(fields).sort();
        const expected = value instanceof Error ? value.name : "unknown";
        return (
          keys.length === 2 &&
          keys[0] === "error" &&
          keys[1] === "event" &&
          fields.event === "boot_failed" &&
          fields.error === expected &&
          !("message" in fields) &&
          !("stack" in fields)
        );
      }),
      { seed: 20261029, numRuns: 200 },
    );
  });

  test("arbitrary error names/messages/stacks keep the record to name-only", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (name, message, stack) => {
        const error = new Error(message);
        error.name = name;
        error.stack = stack;
        const fields = bootFailureFields(error);
        return fields.error === name && JSON.stringify(fields) === `{"event":"boot_failed","error":${JSON.stringify(name)}}`;
      }),
      { seed: 20261029, numRuns: 200 },
    );
  });
});

describe("SEC-F2 wiring: src/index.ts routes boot failures through the sanitizer", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  test("the entry point reports via reportBootFailure and never prints raw errors", () => {
    expect(source).toContain("reportBootFailure");
    expect(source).toMatch(/\.catch\(/);
    expect(source).not.toMatch(/console\.|process\.stderr|error\.stack|error\.message|String\(error\)/);
  });
});
