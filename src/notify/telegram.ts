/**
 * Owner notifications over Telegram. Off unless `NOTIFICATIONS` is "telegram". The bot token is a
 * Worker secret (`TELEGRAM_BOT_TOKEN`, never a config variable); the chat ID is the owner's
 * private chat with the bot. Messages are plain text, so contributor-supplied titles cannot inject
 * formatting or links.
 */

/** Delivers one message; true only when Telegram accepted it. */
export type TelegramSend = (text: string) => Promise<boolean>;

export interface NotifyEnv {
  readonly NOTIFICATIONS?: string;
  readonly TELEGRAM_BOT_TOKEN?: string;
  readonly TELEGRAM_CHAT_ID?: string;
  /** Test injection for delivery; never set from configuration. */
  readonly TELEGRAM_SEND?: TelegramSend;
}

export type TelegramConfig =
  | { readonly mode: "off" }
  | { readonly mode: "invalid" }
  | { readonly mode: "on"; readonly send: TelegramSend };

/** Telegram's limit is 4096 characters; stay under it. */
export const MAX_MESSAGE_CHARS = 3900;

const BOT_TOKEN = /^\d{5,15}:[A-Za-z0-9_-]{30,64}$/;
const CHAT_ID = /^-?\d{1,20}$/;

export function telegramOf(env: NotifyEnv): TelegramConfig {
  const mode = env.NOTIFICATIONS;
  if (mode === undefined || mode === "off") return { mode: "off" };
  if (mode !== "telegram") return { mode: "invalid" };
  if (env.TELEGRAM_SEND) return { mode: "on", send: env.TELEGRAM_SEND };
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (typeof token !== "string" || !BOT_TOKEN.test(token)) return { mode: "invalid" };
  if (typeof chatId !== "string" || !CHAT_ID.test(chatId)) return { mode: "invalid" };
  return {
    mode: "on",
    send: async (text) => {
      try {
        const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: clip(text, MAX_MESSAGE_CHARS),
            disable_web_page_preview: true,
          }),
          redirect: "manual",
        });
        return response.ok;
      } catch {
        return false;
      }
    },
  };
}

/** Shortens text to `max` characters, marking the cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
