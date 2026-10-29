/**
 * Smoke tests for the fake Bot API harness (bootstrap T1, devops-sre).
 *
 * NOTE: intended location is tests/unit/, which is write-protected for the
 * devops-sre role; kept here (tests/helpers/) until the owner (software-engineer)
 * re-homes it. Vitest includes tests/**\/*.test.ts, so these run in `npm test`.
 *
 * They prove the harness records calls, returns canned results and simulates
 * Telegram errors (incl. 429 with retry_after).
 */
import { describe, expect, it } from "vitest";
import {
  createTestBot,
  FakeApiError,
  FakeBotApi,
} from "./fake-bot-api.js";

describe("FakeBotApi harness", () => {
  it("records every API call in order with its payload", async () => {
    const { bot, api } = createTestBot();

    await bot.api.sendMessage(100, "hello");
    await bot.api.deleteMessages(100, [1, 2]);

    expect(api.calls.map((call) => call.method)).toEqual([
      "sendMessage",
      "deleteMessages",
    ]);
    expect(api.calls[0].payload).toMatchObject({ chat_id: 100, text: "hello" });
    expect(api.calls[1].payload).toMatchObject({
      chat_id: 100,
      message_ids: [1, 2],
    });
  });

  it("returns canned results (value and handler form)", async () => {
    const { bot, api } = createTestBot();
    api.setMethodResult("sendMessage", { message_id: 42 });
    api.setMethodResult("getChat", (payload: Record<string, unknown>) => ({
      id: payload.chat_id,
      type: "private",
    }));

    const sent = await bot.api.sendMessage(1, "x");
    const chat = await bot.api.getChat(555);

    expect(sent).toMatchObject({ message_id: 42 });
    expect(chat).toMatchObject({ id: 555, type: "private" });
  });

  it("has sane defaults for the core methods and supports bot.init() offline", async () => {
    const { bot, api } = createTestBot();

    await bot.init();

    expect(bot.botInfo.username).toBe("test_bot");
    expect(api.callsOf("getMe")).toHaveLength(1);

    const copied = await bot.api.copyMessages(1, 2, [10, 11]);
    expect(copied).toHaveLength(2);
  });

  it("simulates a 429 error with retry_after like the real Bot API", async () => {
    const { bot, api } = createTestBot();
    api.setMethodError("deleteMessages", {
      error_code: 429,
      description: "Too Many Requests: retry after 3",
      retry_after: 3,
    });

    await expect(bot.api.deleteMessages(1, [1])).rejects.toMatchObject({
      error_code: 429,
      description: "Too Many Requests: retry after 3",
      parameters: { retry_after: 3 },
    });
  });

  it("supports fail-once-then-succeed sequences via handlers", async () => {
    const api = new FakeBotApi();
    const { bot } = createTestBot(api);
    let first = true;
    api.setMethodResult("deleteMessages", () => {
      if (first) {
        first = false;
        return new FakeApiError({ error_code: 429, retry_after: 1 });
      }
      return true;
    });

    await expect(bot.api.deleteMessages(1, [1])).rejects.toMatchObject({
      error_code: 429,
      parameters: { retry_after: 1 },
    });
    await expect(bot.api.deleteMessages(1, [1])).resolves.toBe(true);
    expect(api.callsOf("deleteMessages")).toHaveLength(2);
  });
});
