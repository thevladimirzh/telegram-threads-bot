/**
 * In-process fake Telegram Bot API for tests (plan D13, "fake Bot API").
 *
 * Deterministic: no network, no timers. Every API call is recorded in order;
 * responses come from registered canned values/handlers or from sane defaults.
 * Telegram errors (including 429 with `retry_after`) are simulated by returning
 * `{ ok: false, ... }` responses, which grammY turns into `GrammyError`s —
 * production code must honor `parameters.retry_after` (plan §5, D24).
 *
 * Wiring: `createTestBot()` installs the transformer via
 * `bot.api.config.use(...)` (grammY 1.46 has no `client: { transformer }`
 * option; `config.use` is the supported client-transformer entry point).
 * `bot.api.config.use` is the supported way to intercept all client calls;
 * the transformer never reaches the network because `prev` is never called.
 */
import { Bot, type Transformer } from "grammy";

/** Fixed timestamp for all fake messages (2023-11-14T22:13:20Z) — no real clock. */
export const FIXED_DATE = 1_700_000_000;

/** Bot token accepted by grammY; no network access is made with it. */
export const TEST_BOT_TOKEN = "123456:TEST-TOKEN";

const FIRST_MESSAGE_ID = 1000;

const BOT_USER = {
  id: 1,
  is_bot: true,
  first_name: "Test Bot",
  username: "test_bot",
};

const FAKE_USER = {
  id: 777,
  is_bot: false,
  first_name: "Fake User",
  username: "fake_user",
};

export interface RecordedCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface FakeApiErrorInit {
  error_code: number;
  description?: string;
  /** Telegram sets this on 429 responses; production code must honor it. */
  retry_after?: number;
  migrate_to_chat_id?: number;
}

/**
 * Return this from a canned value/handler to make the call fail like the real
 * Bot API does. grammY will throw a `GrammyError` carrying these fields.
 */
export class FakeApiError {
  constructor(readonly init: FakeApiErrorInit) {}
}

export type MethodHandler = (payload: Record<string, unknown>) => unknown;

interface ApiOk {
  ok: true;
  // The fake does not model Bot API result types; `any` keeps the harness
  // usable for every method without per-method typing.
  result: any;
}

interface ApiFail {
  ok: false;
  error_code: number;
  description: string;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

type ApiResult = ApiOk | ApiFail;

/**
 * Fake Bot API instance. Obtain a bot wired to it via `createTestBot()`.
 */
export class FakeBotApi {
  /** Every API call in order: method + (shallow-copied) payload. */
  readonly calls: RecordedCall[] = [];

  private readonly results = new Map<string, unknown>();
  private nextMessageId = FIRST_MESSAGE_ID;

  /**
   * grammY client transformer. Never touches the network: `prev` is ignored.
   */
  readonly transformer: Transformer = (prev, method, payload) => {
    void prev;
    return this.handle(method, payload as unknown as Record<string, unknown>);
  };

  /**
   * Registers a canned result for a method. If the value is a function, it is
   * invoked with the call payload (it may return a `FakeApiError` to fail the
   * call — e.g. to answer with 429 once and succeed afterwards).
   */
  setMethodResult(method: string, result: unknown): void {
    this.results.set(method, result);
  }

  /** Makes every call of a method fail with a Telegram-style error. */
  setMethodError(method: string, init: FakeApiErrorInit): void {
    this.results.set(method, () => new FakeApiError(init));
  }

  /** Recorded calls of one method, in order. */
  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  /** Clears recorded calls and registered overrides; resets message ids. */
  reset(): void {
    this.calls.length = 0;
    this.results.clear();
    this.nextMessageId = FIRST_MESSAGE_ID;
  }

  private async handle(method: string, payload: Record<string, unknown>): Promise<ApiResult> {
    this.calls.push({ method, payload: { ...payload } });
    const registered = this.results.get(method);
    const value =
      registered === undefined
        ? this.defaultResult(method, payload)
        : typeof registered === "function"
          ? (registered as MethodHandler)(payload)
          : registered;
    if (value instanceof FakeApiError) {
      return this.errorResult(value.init);
    }
    return { ok: true, result: value };
  }

  private errorResult(init: FakeApiErrorInit): ApiFail {
    const parameters: NonNullable<ApiFail["parameters"]> = {};
    if (init.retry_after !== undefined) parameters.retry_after = init.retry_after;
    if (init.migrate_to_chat_id !== undefined) {
      parameters.migrate_to_chat_id = init.migrate_to_chat_id;
    }
    return {
      ok: false,
      error_code: init.error_code,
      description: init.description ?? `Fake Bot API error ${init.error_code}`,
      parameters: Object.keys(parameters).length > 0 ? parameters : undefined,
    };
  }

  private defaultResult(method: string, payload: Record<string, unknown>): unknown {
    switch (method) {
      case "getMe":
        return {
          ...BOT_USER,
          can_join_groups: true,
          can_read_all_group_messages: true,
          supports_inline_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
        };
      case "sendMessage":
        return this.makeMessage(payload, { text: payload.text });
      case "editMessageText":
        return this.makeMessage(payload, { text: payload.text });
      case "copyMessage":
        return { message_id: this.takeMessageId() };
      case "copyMessages": {
        const ids = Array.isArray(payload.message_ids) ? payload.message_ids : [];
        return ids.map(() => ({ message_id: this.takeMessageId() }));
      }
      case "forwardMessage":
        return this.makeMessage(payload, {
          forward_origin: {
            type: "user",
            sender_user: { ...FAKE_USER },
            date: FIXED_DATE,
          },
        });
      case "deleteMessage":
      case "deleteMessages":
      case "answerCallbackQuery":
        return true;
      case "getChat":
        return {
          id: payload.chat_id ?? 0,
          type: "supergroup",
          title: "Fake chat",
        };
      case "getChatMember":
        return { status: "member", user: { ...FAKE_USER } };
      case "getChatAdministrators":
        return [{ status: "creator", user: { ...FAKE_USER }, is_anonymous: false }];
      default:
        throw new Error(
          `FakeBotApi: no default result for method '${method}' — register one with setMethodResult()`,
        );
    }
  }

  private makeMessage(
    payload: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      message_id: this.takeMessageId(),
      date: FIXED_DATE,
      chat: {
        id: payload.chat_id ?? 0,
        type: "supergroup",
        title: "Fake chat",
      },
      from: { ...BOT_USER },
      ...(payload.message_thread_id !== undefined
        ? { message_thread_id: payload.message_thread_id }
        : {}),
      ...extra,
    };
  }

  private takeMessageId(): number {
    return this.nextMessageId++;
  }
}

/**
 * Creates a grammY bot wired to a `FakeBotApi`. All API calls go through the
 * fake; `bot.init()` and `bot.handleUpdate(...)` work without any network.
 */
export function createTestBot(api: FakeBotApi = new FakeBotApi()): {
  bot: Bot;
  api: FakeBotApi;
} {
  const bot = new Bot(TEST_BOT_TOKEN);
  bot.api.config.use(api.transformer);
  return { bot, api };
}
