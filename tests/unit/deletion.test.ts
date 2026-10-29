/**
 * Unit tests — src/domain/deletion.ts, D83 (partial-deletion report classes).
 *
 * D83 mapping (plan §6): Telegram "message to delete not found" -> `not_found`,
 * 403 -> `forbidden`, any other error -> `failed` — plus `deleted` for the
 * successes (counted by the caller). The class is keyed on the error identity
 * (the exact Telegram description), NOT on a broad "not found" substring:
 * a 400 "Bad Request: chat not found" is "any other error" and must land in
 * `failed`.
 */
import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { chunkIds, classifyDeleteError, retryAfterMs } from "../../src/domain/deletion";

describe("classifyDeleteError (D83)", () => {
  test("Telegram 'message to delete not found' maps to not_found", () => {
    expect(classifyDeleteError({ error_code: 400, description: "Bad Request: message to delete not found" })).toBe(
      "not_found",
    );
  });

  test("403 maps to forbidden", () => {
    expect(classifyDeleteError({ error_code: 403, description: "Forbidden: bot was kicked" })).toBe("forbidden");
  });

  test("any other error maps to failed", () => {
    expect(classifyDeleteError({ error_code: 400, description: "Bad Request: oops" })).toBe("failed");
    expect(classifyDeleteError({ error_code: 500, description: "Internal Server Error" })).toBe("failed");
    expect(classifyDeleteError({ error_code: 429, description: "Too Many Requests" })).toBe("failed");
    expect(classifyDeleteError(new Error("boom"))).toBe("failed");
    expect(classifyDeleteError(undefined)).toBe("failed");
    expect(classifyDeleteError(null)).toBe("failed");
    expect(classifyDeleteError("nonsense")).toBe("failed");
    expect(classifyDeleteError({})).toBe("failed");
  });

  test("a 'not found' error that is not the delete-message one is failed (D83: anything else)", () => {
    expect(classifyDeleteError({ error_code: 400, description: "Bad Request: chat not found" })).toBe("failed");
    expect(classifyDeleteError({ error_code: 400, description: "Bad Request: message not found" })).toBe("failed");
  });

  test("the delete-not-found class is keyed on the description, not on a 400 code", () => {
    expect(classifyDeleteError({ error_code: 404, description: "Not Found: message to delete not found" })).toBe(
      "not_found",
    );
    expect(classifyDeleteError({ description: "message to delete not found" })).toBe("not_found");
  });
});

describe("classifyDeleteError properties (fast-check, fixed seed)", () => {
  test("never throws on arbitrary input and always returns one of the four classes", () => {
    fc.assert(
      fc.property(fc.anything(), (error) => {
        const cls = classifyDeleteError(error);
        expect(["deleted", "not_found", "forbidden", "failed"]).toContain(cls);
      }),
      { seed: 20261028, numRuns: 300 },
    );
  });

  test("403 always classifies as forbidden, whatever the description", () => {
    fc.assert(
      fc.property(fc.string(), (description) => {
        expect(classifyDeleteError({ error_code: 403, description })).toBe("forbidden");
      }),
      { seed: 20261028, numRuns: 100 },
    );
  });

  test("the delete-not-found description always classifies as not_found (any code but 403)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }).filter((code) => code !== 403),
        (code) => {
          expect(classifyDeleteError({ error_code: code, description: "Bad Request: message to delete not found" })).toBe(
            "not_found",
          );
        },
      ),
      { seed: 20261028, numRuns: 100 },
    );
  });

  test("descriptions without the delete-not-found phrase and code != 403 classify as failed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 599 }).filter((code) => code !== 403),
        fc.string().filter((s) => !s.toLowerCase().includes("message to delete not found")),
        (code, description) => {
          expect(classifyDeleteError({ error_code: code, description })).toBe("failed");
        },
      ),
      { seed: 20261028, numRuns: 200 },
    );
  });
});

describe("retryAfterMs (D24/D78)", () => {
  test("returns the delay in milliseconds for a positive retry_after", () => {
    expect(retryAfterMs({ parameters: { retry_after: 3 } })).toBe(3000);
    expect(retryAfterMs({ parameters: { retry_after: 0.5 } })).toBe(500);
  });

  test("returns undefined without a usable retry_after", () => {
    expect(retryAfterMs({})).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
    expect(retryAfterMs({ parameters: { retry_after: 0 } })).toBeUndefined();
    expect(retryAfterMs({ parameters: { retry_after: -2 } })).toBeUndefined();
    expect(retryAfterMs({ parameters: { retry_after: "3" } })).toBeUndefined();
  });

  test("never throws on arbitrary input (fast-check, fixed seed)", () => {
    fc.assert(
      fc.property(fc.anything(), (error) => {
        const wait = retryAfterMs(error);
        expect(wait === undefined || (typeof wait === "number" && wait > 0)).toBe(true);
      }),
      { seed: 20261028, numRuns: 200 },
    );
  });
});

describe("chunkIds (R27)", () => {
  test("splits into chunks of at most 100 preserving order (round-trip)", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -1000, max: 1000 }), { maxLength: 500 }), fc.integer({ min: 1, max: 150 }), (ids, size) => {
        const chunks = chunkIds(ids, size);
        expect(chunks.flat()).toEqual(ids);
        for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(size);
        for (const chunk of chunks) expect(chunk.length).toBeGreaterThan(0);
      }),
      { seed: 20261028, numRuns: 200 },
    );
  });
});
