import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeBTelegramBot } from './bot.js';

const notification = { sessionId: 'fixture', type: 'prompt.completed', exitCode: 0, resultPreview: 'done' };
describe('reliable Telegram broadcast outcome', () => {
  let dir: string;
  let bot: any;
  let send: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '');
    dir = await mkdtemp(join(tmpdir(), 'cb-delivery-'));
    bot = new ClaudeBTelegramBot({ configDir: dir });
    await bot.getConfigManager().load();
    for (const id of ['123', '456', '-100']) await bot.getConfigManager().addChatId(id);
    send = vi.fn().mockResolvedValue({ message_id: 1 });
    bot.bot = { sendMessage: send };
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
  it('rejects when offline so a durable outbox can retain the event', async () => {
    bot.bot = null;
    await expect(bot.broadcastNotification(notification)).rejects.toThrow('offline');
  });
  it('rejects any authorized recipient failure after trying other authorized recipients', async () => {
    send.mockImplementation(async (id: string) => {
      if (id === '123') throw new Error('transport unavailable');
      return { message_id: 1 };
    });
    await expect(bot.broadcastNotification(notification)).rejects.toThrow('1 authorized recipient');
    expect(send.mock.calls.map(([id]) => id)).toContain('456');
    expect(send.mock.calls.map(([id]) => id)).not.toContain('-100');
  });
  it('does not treat excluded recipients as delivery failures', async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '456');
    await expect(bot.broadcastNotification(notification)).resolves.toBeUndefined();
    expect(send.mock.calls.map(([id]) => id)).toEqual(['456']);
  });
  it('reports a lost continuation instead of acknowledging a partial broadcast', async () => {
    let count = 0;
    send.mockImplementation(async (id: string) => {
      if (id === '123' && ++count > 1) throw new Error('transport unavailable');
      return { message_id: count };
    });
    await expect(bot.broadcastNotification({ ...notification, resultPreview: 'x'.repeat(7000) }))
      .rejects.toThrow('1 authorized recipient');
  });
  it('starts no transport request for an already aborted broadcast', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(bot.broadcastNotification(notification, controller.signal)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
  it('starts no further recipient requests after aborting the current send', async () => {
    const controller = new AbortController();
    send.mockImplementationOnce(async () => { controller.abort(); return { message_id: 1 }; });
    await expect(bot.broadcastNotification(notification, controller.signal)).rejects.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

});
