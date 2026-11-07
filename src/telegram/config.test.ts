import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TelegramConfigManager } from './config.js';

describe('Telegram message ownership', () => {
  let dir: string;
  let config: TelegramConfigManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-tg-config-'));
    config = new TelegramConfigManager(dir);
    await config.load();
  });

  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it('keeps identical message IDs independent across chats and reloads', async () => {
    await config.mapMessage('123', '77', 'session-a');
    await config.mapMessage('456', '77', 'session-b');
    config.storeResult('123', '77', 'result a');
    config.storeResult('456', '77', 'result b');
    config.addPendingPrompt('123', '77', { chatId: '123', sessionId: 'session-a', transcript: 'a', optimizedPrompt: 'prompt a', timestamp: Date.now() });
    config.addPendingPrompt('456', '77', { chatId: '456', sessionId: 'session-b', transcript: 'b', optimizedPrompt: 'prompt b', timestamp: Date.now() });
    await config.save();

    const restored = new TelegramConfigManager(dir);
    await restored.load();
    for (const [chat, suffix] of [['123', 'a'], ['456', 'b']]) {
      expect(restored.getSessionForMessage(chat, '77')).toBe(`session-${suffix}`);
      expect(restored.getResult(chat, '77')).toBe(`result ${suffix}`);
      expect(restored.getPendingPrompt(chat, '77')?.optimizedPrompt).toBe(`prompt ${suffix}`);
    }
    restored.updatePendingPrompt('123', '77', 'edited');
    restored.removePendingPrompt('456', '77');
    expect(restored.getPendingPrompt('123', '77')?.optimizedPrompt).toBe('edited');
    expect(restored.getPendingPrompt('456', '77')).toBeUndefined();
  });

  it('drops ambiguous legacy message IDs instead of assigning them to a chat', async () => {
    await writeFile(join(dir, 'telegram.json'), JSON.stringify({
      sessionMap: { '77': 'legacy-session' }, resultMap: { '77': 'private result' },
      pendingPrompts: { '77': { chatId: '123', sessionId: 'legacy-session', timestamp: Date.now() } },
    }));
    await config.load();
    expect(config.getSessionForMessage('123', '77')).toBeUndefined();
    expect(config.getResult('456', '77')).toBeUndefined();
    expect(config.getPendingPrompt('123', '77')).toBeUndefined();
    expect(config.get().sessionMap).toEqual({});
  });

  it('keeps fresh manager collections separate and rejects inconsistent pending ownership', async () => {
    const other = new TelegramConfigManager(join(dir, 'other'));
    await other.load();
    await config.addChatId('123');
    await config.mapMessage('123', '77', 'private-session');
    expect(other.get().chatIds).toEqual([]);
    expect(other.getSessionForMessage('123', '77')).toBeUndefined();
    expect(() => config.addPendingPrompt('456', '77', {
      chatId: '123', sessionId: 'private-session', transcript: '', optimizedPrompt: '', timestamp: Date.now(),
    })).toThrow('owner must match');
  });
});
