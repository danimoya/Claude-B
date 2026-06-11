import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { ClaudeBTelegramBot } from './bot.js';

describe('ClaudeBTelegramBot safety behavior', () => {
  it('does not auto-start when telegram.json is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'claude-b-telegram-'));
    try {
      await writeFile(join(dir, 'telegram.json'), JSON.stringify({
        token: '123456:test-token',
        enabled: false,
        chatIds: [],
        sessionMap: {},
        pendingPrompts: {},
        resultMap: {},
      }));

      const bot = new ClaudeBTelegramBot({ configDir: dir });
      await expect(bot.start()).rejects.toThrow('Telegram bot disabled');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not reconnect Telegram 409 polling conflicts', () => {
    const bot = new ClaudeBTelegramBot({ configDir: '/tmp/claude-b-test' });
    const shouldReconnect = (bot as unknown as {
      shouldReconnect(error: Error): boolean;
    }).shouldReconnect.bind(bot);

    expect(shouldReconnect(
      new Error('ETELEGRAM: 409 Conflict: terminated by other getUpdates request')
    )).toBe(false);
  });
});
