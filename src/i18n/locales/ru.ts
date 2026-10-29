import type { Messages } from "@lingui/core";

/**
 * Russian message catalog.
 *
 * Plain TypeScript catalog — no Babel macros, no build step. Keys must match
 * `en.ts` exactly (see AGENTS.md, "i18n"). The thread URL is appended verbatim
 * and never localized (D26).
 */
export const messages: Messages = {
  "app.name": "Бот веток",
  "start.text":
    "Пересылайте сообщения из подключённого чата-источника в чат веток, чтобы перенести обсуждение в именованную ветку.",
  "settings.title": "Настройки",
  "settings.chatList": "Чаты, где я администратор:",
  "settings.refusal": "Настройки могут управлять только глобальные администраторы.",
  "settings.notPrivate": "Настройки доступны только в личном сообщении.",
  "settings.actionSource": "Источник",
  "settings.actionThreads": "Ветки",
  "settings.actionDisconnect": "Отключить",
  "settings.sourceConnected": "Чат подключён как источник: {title}",
  "settings.sourceConnectRefused": "{title} — это чат веток и не может быть источником.",
  "settings.threadsConnected": "Чат веток переключён на {title}.",
  "settings.threadsRepointed": "Чат веток переключён с {previous} на {title}.",
  "settings.sourceDisconnected": "Чат отключён: {title}.",
  "settings.languageChanged": "Язык изменён.",
  "dialog.prompt":
    "Создание ветки: 1. выберите чат-источник 2. отправьте заголовок 3. перенос начнётся автоматически. Заголовок: 1..255 символов; до 50 сообщений; диалог закрывается через 15 минут (отмена: /cancel).",
  "dialog.summary": "Пакет: {count} сообщений из {chats} чатов; будет пропущено: {dropped}.",
  "dialog.batchJoined": "Добавлено в пакет: {count} сообщений. Отмена: /cancel.",
  "dialog.notConnected": "{title} — не подключённый чат-источник.",
  "dialog.timeout": "Диалог закрыт по тайм-ауту.",
  "dialog.invalidTitle": "Заголовок должен содержать 1..255 символов после обрезки пробелов.",
  "dialog.pickFirst": "Сначала выберите чат-источник кнопкой, затем отправьте заголовок.",
  "dialog.noDraft": "Активного диалога нет.",
  "dialog.cancelled": "Диалог отменён.",
  "dialog.cancelForeign": "Отменить диалог может только автор пересланного пакета.",
  "transfer.refusedNotAdmin": "Переносить сообщения {title} могут только администраторы.",
  "transfer.duplicate": "Эти сообщения уже перенесены в «{title}»: {url}",
  "transfer.failure": "Перенос не удался, ничего не перенесено. Попробуйте позже.",
  "transfer.closing": "{title} — перенесено из {link}",
  "transfer.closingPlaceholders": "{count} сообщений заменено заглушками",
  "transfer.announce": "Создана ветка «{title}»: {url}",
  "transfer.reportNoOriginals": "оригиналы для удаления не найдены",
  "transfer.reportUnidentified": "не удалось определить оригиналы: {count}",
  "transfer.reportNotDeleted": "не удалены: {ids}",
};
