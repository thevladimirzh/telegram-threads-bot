/**
 * Lingui i18n setup — runtime catalogs, no Babel/macro build plugins.
 *
 * Works in Vitest and under tsx as-is: catalogs are plain TypeScript records
 * of message id -> source string; messages are compiled on the fly by
 * `@lingui/message-utils/compileMessage`. See AGENTS.md, "i18n", for the
 * workflow of adding messages.
 */
import {
  type AllMessages,
  type I18n,
  setupI18n,
} from "@lingui/core";
import { compileMessage } from "@lingui/message-utils/compileMessage";
import { messages as en } from "./locales/en.js";
import { messages as ru } from "./locales/ru.js";

export const locales = ["en", "ru"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

const catalogs: AllMessages = { en, ru };

/**
 * Creates an isolated i18n instance with all catalogs loaded.
 * Isolation keeps tests deterministic (no shared global state).
 */
export function createI18n(locale: Locale = defaultLocale): I18n {
  const i18n = setupI18n();
  i18n.setMessagesCompiler(compileMessage);
  i18n.load(catalogs);
  i18n.activate(locale);
  return i18n;
}
