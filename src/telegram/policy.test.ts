import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClaudeBTelegramBot } from './bot.js';

describe('authorized Telegram execution policy', () => {
  let dir: string;
  let bot: any;
  const change = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue({ message_id: 1 });
  const message = (text: string, id = 123, type = 'private', sender = id) => ({
    text, message_id: 1, date: 0, chat: { id, type }, from: { id: sender }
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '');
    dir = await mkdtemp(join(tmpdir(), 'cb-policy-'));
    bot = new ClaudeBTelegramBot({ configDir: dir, onExecutionPolicy: change,
      getSessions: () => [{ id: 'session-a', status: 'idle', executionPolicy: 'default' },
        { id: 'session-b', status: 'idle', executionPolicy: 'bypass' },
        { id: 'tmux:%5', status: 'idle' }] });
    await bot.getConfigManager().load();
    await bot.getConfigManager().addChatId('123');
    bot.bot = { sendMessage: send };
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  it('sets an enum policy on a selected or explicit managed session', async () => {
    bot.selectedSession.set('123', 'session-a');
    await bot.handlePolicy(message('/policy bypass'));
    await bot.handlePolicy(message('/policy default session-b'));
    expect(change.mock.calls).toEqual([['session-a', 'bypass'], ['session-b', 'default']]);
  });
  it('shows current policy without changing it and includes it in session listings', async () => {
    bot.selectedSession.set('123', 'session-a');
    await bot.handlePolicy(message('/policy'));
    expect(send).toHaveBeenCalledWith('123', 'Session session-a: policy default', {});
    await bot.handleSessions(message('/sessions'));
    expect(send.mock.calls.at(-1)?.[1]).toContain('policy:default');
    expect(change).not.toHaveBeenCalled();
  });
  it('rejects unauthorized, forged and group actors before policy access', async () => {
    for (const msg of [message('/policy bypass session-a', 999), message('/policy bypass session-a', 123, 'group'), message('/policy bypass session-a', 123, 'private', 456)]) {
      await bot.handlePolicy(msg);
    }
    expect(change).not.toHaveBeenCalled();
  });
  it('rejects non-enum, unknown, ambiguous and external native targets', async () => {
    for (const text of ['/policy anything session-a', '/policy bypass missing', '/policy bypass session-', '/policy bypass tmux:%5']) await bot.handlePolicy(message(text));
    expect(change).not.toHaveBeenCalled();
  });
});
