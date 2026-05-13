/**
 * Allow-list helper for the Telegram bot's `/start` gate.
 *
 * Reads a comma-separated list of chat IDs from `TELEGRAM_ALLOWED_CHAT_IDS`
 * and returns whether the given chat is permitted to register with the bot.
 *
 * Empty / unset env var ⇒ open behaviour (any chat may register). This is the
 * default for fresh installs and preserves backward compatibility with
 * Claude-B < 0.3.3, which did not enforce the list at all.
 */
export function isChatAllowed(chatId: string, allowedRaw: string | undefined): boolean {
  const raw = allowedRaw?.trim();
  if (!raw) return true;
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(chatId);
}
