import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPairingChallenge, consumePairingChallenge } from '../telegram/pairing.js';
import { waitForTelegramPairing } from './telegram-pairing.js';

const now = 1800000000000;
const message = (code: string, changes = {}) => ({
  date: now / 1000, text: `/start ${code}`, chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false }, ...changes
});

describe('private challenge enrollment', () => {
  afterEach(() => vi.useRealTimers());

  it('uses unpredictable challenge digests, single use and bounded expiry', () => {
    const first = createPairingChallenge({ now, ttlMs: 1000 });
    const second = createPairingChallenge({ now, ttlMs: 1000 });
    expect(first.code).not.toBe(second.code);
    expect(first.challenge.digest).not.toContain(first.code);
    expect(consumePairingChallenge(first.challenge, message(first.code), now)).toBe('123');
    expect(consumePairingChallenge(first.challenge, message(first.code), now)).toBeNull();
    expect(consumePairingChallenge(second.challenge, message(second.code), now + 1000)).toBeNull();
    expect(() => createPairingChallenge({ ttlMs: 180001 })).toThrow('three minutes');
  });

  it('rejects arbitrary /start, wrong nonce, groups, bots, mismatched actors, old updates and old messages', () => {
    const { code, challenge } = createPairingChallenge({ now, minUpdateId: 50 });
    for (const msg of [
      message(code, { text: '/start' }), message('x'.repeat(32)),
      message(code, { chat: { id: 123, type: 'group' } }),
      message(code, { from: { id: 456 } }), message(code, { from: { id: 123, is_bot: true } }),
      message(code, { date: now / 1000 - 1 }), message(code, { date: now / 1000 + 20 })
    ]) expect(consumePairingChallenge(challenge, msg, now, 50)).toBeNull();
    expect(consumePairingChallenge(challenge, message(code), now, 49)).toBeNull();
    expect(challenge.used).toBe(false);
    expect(consumePairingChallenge(challenge, message(code), now, 50)).toBe('123');
  });

  it('binds an optional expected private sender', () => {
    const { code, challenge } = createPairingChallenge({ now, expectedSenderId: '456' });
    expect(consumePairingChallenge(challenge, message(code), now)).toBeNull();
    expect(consumePairingChallenge(challenge, message(code, { chat: { id: 456, type: 'private' }, from: { id: 456 } }), now)).toBe('456');
  });

  it('fences backlog updates before displaying the nonce and uses one request deadline', async () => {
    let code = '';
    const fetcher = vi.fn().mockImplementation(async (_url, options: RequestInit) => {
      const body = JSON.parse(options.body as string);
      if (body.offset === -1) return Response.json({ ok: true, result: [{ update_id: 40 }] });
      const date = Math.floor(Date.now() / 1000);
      return Response.json({ ok: true, result: [
        { update_id: 39, message: { ...message(code), date } },
        { update_id: 41, message: { ...message(code, { chat: { id: 123, type: 'group' } }), date } },
        { update_id: 42, message: { ...message(code), date } }
      ] });
    });
    expect(await waitForTelegramPairing('test-token', value => { code = value; }, 1000, fetcher)).toBe('123');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).offset).toBe(41);
    expect(fetcher.mock.calls[0][1].signal).toBe(fetcher.mock.calls[1][1].signal);
  });

  it('aborts a stalled poll and cleans its timer', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const pending = waitForTelegramPairing('test-token', () => {}, 100, fetcher as typeof fetch);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails explicitly if another poller owns the bot and never propagates token URLs', async () => {
    await expect(waitForTelegramPairing('test-token', () => {}, 1000,
      vi.fn().mockResolvedValue(new Response('', { status: 409 })))).rejects.toThrow('Another Telegram poller');
    await expect(waitForTelegramPairing('test-token', () => {}, 1000,
      vi.fn().mockRejectedValue(new Error('https://api.telegram.org/bottest-token/getUpdates'))))
      .rejects.toThrow('Telegram pairing failed; verify connectivity and bot ownership');
  });
});
