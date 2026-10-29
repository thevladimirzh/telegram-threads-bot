/**
 * Unit tests — src/webhook.ts (D86, R56): webhook serving without network.
 *
 * The request listener is driven with fake req/res objects; the grammY
 * integration is exercised through the real `webhookCallback` over a fake Bot
 * API (deterministic — no sockets, no timers). Pinned behaviour:
 *   - `X-Telegram-Bot-Api-Secret-Token` validated against the configured
 *     secret: missing → 401, wrong → 403, and NO update handling / no bot
 *     initialization for either (R56);
 *   - POST updates are served on the configured path only (404 otherwise,
 *     405 for other methods);
 *   - /health and /ready run on the same server (D20/D61);
 *   - a failing update handler answers 400 and never crashes the server.
 */
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import fc from "fast-check";
import { InMemoryStore } from "../../src/store/in-memory";
import {
  checkWebhookSecret,
  createWebhookHandler,
  createWebhookListener,
  type WebhookListenerDeps,
} from "../../src/webhook";
import { createTestBot, type FakeBotApi } from "../helpers/fake-bot-api";

const SECRET = "hook-secret";
const PATH = "/hook";

class FakeReq extends EventEmitter {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  private readonly body: string;
  private scheduled = false;

  constructor(method: string, url: string, headers: Record<string, string | string[] | undefined>, body = "") {
    super();
    this.method = method;
    this.url = url;
    this.headers = headers;
    this.body = body;
  }

  // The grammY "http" adapter subscribes to "data"/"end" and then waits:
  // replay the body as a microtask once "end" is subscribed (deterministic).
  override once(event: string | symbol, listener: (...args: any[]) => void): this {
    super.once(event, listener);
    if (event === "end" && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        if (this.body.length > 0) this.emit("data", Buffer.from(this.body, "utf8"));
        this.emit("end");
      });
    }
    return this;
  }
}

class FakeRes {
  status = 0;
  headers: Record<string, string> = {};
  body = "";
  ended = false;

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    if (headers !== undefined) Object.assign(this.headers, headers);
    return this;
  }

  end(chunk?: string): this {
    if (this.status === 0) this.status = 200; // Node's implicit 200 on end() without writeHead
    if (chunk !== undefined) this.body += String(chunk);
    this.ended = true;
    return this;
  }

  get writableEnded(): boolean {
    return this.ended;
  }
}

function req(
  method: string,
  url: string,
  headers: Record<string, string | string[] | undefined> = {},
  body = "",
): IncomingMessage {
  return new FakeReq(method, url, headers, body) as unknown as IncomingMessage;
}

function res(): { response: ServerResponse; fake: FakeRes } {
  const fake = new FakeRes();
  return { response: fake as unknown as ServerResponse, fake };
}

function listener(overrides: Partial<WebhookListenerDeps> = {}): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> {
  return createWebhookListener({
    path: PATH,
    secret: SECRET,
    handle: vi.fn(),
    health: { store: new InMemoryStore() },
    ...overrides,
  });
}

describe("checkWebhookSecret (R56)", () => {
  test("missing header → 401; wrong header → 403; exact match → ok", () => {
    expect(checkWebhookSecret(undefined, SECRET)).toEqual({ ok: false, status: 401, reason: "missing" });
    expect(checkWebhookSecret("", SECRET)).toEqual({ ok: false, status: 403, reason: "mismatch" });
    expect(checkWebhookSecret("wrong", SECRET)).toEqual({ ok: false, status: 403, reason: "mismatch" });
    expect(checkWebhookSecret("Hook-Secret", SECRET), "comparison is case-sensitive").toEqual({
      ok: false,
      status: 403,
      reason: "mismatch",
    });
    expect(checkWebhookSecret(SECRET, SECRET)).toEqual({ ok: true });
    expect(checkWebhookSecret([SECRET], SECRET), "duplicated header value").toEqual({ ok: true });
    expect(checkWebhookSecret(["wrong"], SECRET)).toEqual({ ok: false, status: 403, reason: "mismatch" });
  });

  test("arbitrary header values never crash and pass only when equal (seed fixed)", () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.array(fc.string(), { maxLength: 2 }), fc.constant(undefined)),
        fc.string(),
        (header, secret) => {
          const check = checkWebhookSecret(header, secret);
          const value = Array.isArray(header) ? header[0] : header;
          if (check.ok) {
            expect(value).toBe(secret);
          } else {
            expect(check.status === 401 || check.status === 403).toBe(true);
          }
          return true;
        },
      ),
      { seed: 20261029, numRuns: 200 },
    );
  });
});

describe("createWebhookListener — routing and the secret gate", () => {
  test("valid POST on the configured path reaches the handler exactly once", async () => {
    const handle = vi.fn();
    const { response, fake } = res();
    await listener({ handle })(
      req("POST", PATH, { "x-telegram-bot-api-secret-token": SECRET }, '{"update_id":1}'),
      response,
    );
    expect(handle).toHaveBeenCalledTimes(1);
    expect(fake.status, "the handler owns the response").toBe(0);
  });

  test("the path is matched without the query string", async () => {
    const handle = vi.fn();
    const { response } = res();
    await listener({ handle })(req("POST", `${PATH}?x=1`, { "x-telegram-bot-api-secret-token": SECRET }), response);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  test("missing secret → 401 and NO update handling", async () => {
    const handle = vi.fn();
    const { response, fake } = res();
    await listener({ handle })(req("POST", PATH, {}, "{}"), response);
    expect(fake.status).toBe(401);
    expect(handle).not.toHaveBeenCalled();
  });

  test("wrong secret → 403 and NO update handling", async () => {
    const handle = vi.fn();
    const { response, fake } = res();
    await listener({ handle })(req("POST", PATH, { "x-telegram-bot-api-secret-token": "wrong" }, "{}"), response);
    expect(fake.status).toBe(403);
    expect(handle).not.toHaveBeenCalled();
  });

  test("unknown path → 404 even with a valid secret", async () => {
    const handle = vi.fn();
    const { response, fake } = res();
    await listener({ handle })(req("POST", "/other", { "x-telegram-bot-api-secret-token": SECRET }, "{}"), response);
    expect(fake.status).toBe(404);
    expect(handle).not.toHaveBeenCalled();
  });

  test("non-POST on the webhook path → 405", async () => {
    const handle = vi.fn();
    const { response, fake } = res();
    await listener({ handle })(req("GET", PATH, { "x-telegram-bot-api-secret-token": SECRET }), response);
    expect(fake.status).toBe(405);
    expect(handle).not.toHaveBeenCalled();
  });

  test("/health answers 200 with the liveness body", async () => {
    const { response, fake } = res();
    await listener()(req("GET", "/health"), response);
    expect(fake.status).toBe(200);
    expect(JSON.parse(fake.body).status).toBe("ok");
  });

  test("/ready reflects the store ping (200 ready / 503 unavailable)", async () => {
    const ok = await (async () => {
      const { response, fake } = res();
      await listener()(req("GET", "/ready"), response);
      return fake;
    })();
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).status).toBe("ready");

    const down = new InMemoryStore();
    down.ping = async () => {
      throw new Error("db down");
    };
    const { response, fake } = res();
    await listener({ health: { store: down } })(req("GET", "/ready"), response);
    expect(fake.status).toBe(503);
    expect(JSON.parse(fake.body).status).toBe("unavailable");
  });

  test("a rejecting handler answers 400 and never crashes the server", async () => {
    const { response, fake } = res();
    await listener({ handle: () => Promise.reject(new Error("bad json")) })(
      req("POST", PATH, { "x-telegram-bot-api-secret-token": SECRET }, "not json"),
      response,
    );
    expect(fake.status).toBe(400);
    expect(fake.ended).toBe(true);
  });

  test("a throwing handler answers 400", async () => {
    const { response, fake } = res();
    await listener({ handle: () => { throw new Error("sync boom"); } })(
      req("POST", PATH, { "x-telegram-bot-api-secret-token": SECRET }),
      response,
    );
    expect(fake.status).toBe(400);
  });
});

describe("webhook + grammY webhookCallback (D86)", () => {
  const UPDATE = JSON.stringify({
    update_id: 41,
    message: {
      message_id: 1,
      date: 1_700_000_000,
      chat: { id: -1001, type: "supergroup", title: "Source" },
      from: { id: 7, is_bot: false, first_name: "Author" },
      text: "hello",
    },
  });

  function bootBot(): { bot: ReturnType<typeof createTestBot>["bot"]; api: FakeBotApi; seen: unknown[]; serve: ReturnType<typeof listener> } {
    const { bot, api } = createTestBot();
    const seen: unknown[] = [];
    bot.on("message", (ctx) => void seen.push(ctx.message));
    const serve = listener({ handle: createWebhookHandler(bot, SECRET) });
    return { bot, api, seen, serve };
  }

  test("a valid request is dispatched to the bot and answers 200", async () => {
    const { seen, serve } = bootBot();
    const { response, fake } = res();
    await serve(req("POST", PATH, { "x-telegram-bot-api-secret-token": SECRET }, UPDATE), response);
    expect(fake.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { text?: string }).text).toBe("hello");
  });

  test("missing secret → 401; the bot is never initialized nor dispatched", async () => {
    const { api, seen, serve } = bootBot();
    const { response, fake } = res();
    await serve(req("POST", PATH, {}, UPDATE), response);
    expect(fake.status).toBe(401);
    expect(seen).toHaveLength(0);
    expect(api.callsOf("getMe"), "no bot.init() on unauthorized requests").toEqual([]);
  });

  test("wrong secret → 403; the bot is never initialized nor dispatched", async () => {
    const { api, seen, serve } = bootBot();
    const { response, fake } = res();
    await serve(req("POST", PATH, { "x-telegram-bot-api-secret-token": "wrong" }, UPDATE), response);
    expect(fake.status).toBe(403);
    expect(seen).toHaveLength(0);
    expect(api.callsOf("getMe")).toEqual([]);
  });

  test("a malformed update body answers 400 and dispatches nothing", async () => {
    const { seen, serve } = bootBot();
    const { response, fake } = res();
    await serve(req("POST", PATH, { "x-telegram-bot-api-secret-token": SECRET }, "{not json"), response);
    expect(fake.status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
