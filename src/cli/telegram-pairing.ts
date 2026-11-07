import { consumePairingChallenge, createPairingChallenge, MAX_PAIRING_TTL_MS, type PairingMessage } from '../telegram/pairing.js';

interface Update { update_id: number; message?: PairingMessage }

/** Standalone setup only. A conflicting existing poller is an explicit error. */
export async function waitForTelegramPairing(token: string, onChallenge: (code: string) => void,
  timeoutMs = MAX_PAIRING_TTL_MS, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_PAIRING_TTL_MS) throw new Error('Invalid pairing timeout');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  async function updates(offset: number, timeout: number): Promise<Update[]> {
    const response = await fetcher(`https://api.telegram.org/bot${token}/getUpdates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ offset, timeout, allowed_updates: ['message'] }), signal: controller.signal
    });
    if (response.status === 409) throw new Error('Another Telegram poller is active; use that owner for pairing');
    if (!response.ok) throw new Error('Telegram pairing request rejected');
    const body = await response.json() as { ok?: boolean; result?: Update[] };
    if (!body.ok || !Array.isArray(body.result)) throw new Error('Invalid Telegram pairing response');
    return body.result;
  }
  try {
    // Fence old updates before publishing a fresh capability. Ordinary /start,
    // arbitrary messages and groups can never enroll a chat.
    const old = await updates(-1, 0);
    let offset = old.reduce((max, update) => Number.isSafeInteger(update.update_id)
      ? Math.max(max, update.update_id + 1) : max, 0);
    const { code, challenge } = createPairingChallenge({ ttlMs: Math.max(1, timeoutMs - 1), minUpdateId: offset });
    onChallenge(code);
    while (!controller.signal.aborted) {
      const remaining = challenge.expiresAt - Date.now();
      if (remaining <= 0) return null;
      for (const update of await updates(offset, Math.max(0, Math.min(25, Math.floor(remaining / 1000))))) {
        if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue;
        offset = update.update_id + 1;
        if (update.message) {
          const chat = consumePairingChallenge(challenge, update.message, Date.now(), update.update_id);
          if (chat) return chat;
        }
      }
    }
    return null;
  } catch (error) {
    if (controller.signal.aborted) return null;
    // Fetch errors may include the token-bearing URL. Never propagate it.
    if (error instanceof Error && error.message === 'Another Telegram poller is active; use that owner for pairing') throw error;
    throw new Error('Telegram pairing failed; verify connectivity and bot ownership');
  } finally {
    clearTimeout(timer);
  }
}
