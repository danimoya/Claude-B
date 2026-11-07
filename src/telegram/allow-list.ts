/**
 * Allow-list helper for the Telegram bot's `/start` gate.
 *
 * Reads a comma-separated list of chat IDs from `TELEGRAM_ALLOWED_CHAT_IDS`
 * and returns whether the given chat is permitted to register with the bot.
 *
 * Empty / unset env var denies new registration. Existing owner-paired chats
 * are authorized separately from registration by the bot.
 */
export function isChatAllowed(chatId: string, allowedRaw: string | undefined): boolean {
  const raw = allowedRaw?.trim();
  if (!raw) return false;
  const allowed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (allowed.length === 0) return false;
  return allowed.includes(chatId);
}
