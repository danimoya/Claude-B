import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelegramConfigManager } from './config.js';
import { ClaudeBTelegramBot } from './bot.js';

const message = (text = '') => ({ message_id: 77, date: 0, chat: { id: 123, type: 'private' }, from: { id: 123 }, text });
const callback = (action: string) => ({ id: 'callback', data: `${action}:77`, from: { id: 123 }, message: message() });

describe('durable Telegram confirmation and routing state', () => {
  let dir: string;
  beforeEach(async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '');
    dir = await mkdtemp(join(tmpdir(), 'cb-tg-durable-'));
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

  async function createBot(onPrompt = vi.fn().mockResolvedValue(undefined), getPromptReceipt?: (key: string) => Promise<{ taskId: string } | undefined>) {
    const bot: any = new ClaudeBTelegramBot({ configDir: dir, onPrompt, getPromptReceipt,
      getSessions: () => [{ id: 'session-a', status: 'idle' }] });
    await bot.getConfigManager().load();
    await bot.getConfigManager().addChatId('123');
    bot.bot = { sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
      editMessageText: vi.fn().mockResolvedValue(undefined), answerCallbackQuery: vi.fn().mockResolvedValue(undefined) };
    return bot;
  }
  async function pending(bot: any) {
    bot.getConfigManager().addPendingPrompt('123', '77', {
      chatId: '123', sessionId: 'session-a', transcript: 'raw', optimizedPrompt: 'optimized', timestamp: Date.now()
    });
    await bot.getConfigManager().save();
  }
  async function stored() { return JSON.parse(await readFile(join(dir, 'telegram.json'), 'utf8')); }

  it('records submitting before invoking a stable idempotent callback and retains its receipt before removal', async () => {
    const execute = vi.fn().mockImplementation(async (_session, _prompt, options) => {
      const state = await stored();
      expect(Object.values(state.pendingPrompts)[0]).toMatchObject({ state: 'submitting', idempotencyKey: options.idempotencyKey });
      return { taskId: 'durable-task' };
    });
    const bot = await createBot(execute);
    await pending(bot);
    vi.spyOn(bot.getConfigManager(), 'removePendingPrompt').mockImplementationOnce(() => { throw new Error('simulated crash after receipt'); });
    await bot.handleCallback(callback('confirm'));
    expect(Object.values((await stored()).pendingPrompts)[0]).toMatchObject({ state: 'submitted', taskId: 'durable-task' });
    const restarted = await createBot(execute);
    await restarted.handleCallback(callback('confirm'));
    expect(execute).toHaveBeenCalledOnce();
    expect(restarted.bot.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('durable-task'), {});
  });

  it('reconciles interrupted submissions as uncertain, looks up receipts, and never replays', async () => {
    const bot = await createBot();
    await pending(bot);
    await bot.getConfigManager().setPendingState('123', '77', 'submitting');
    const execute = vi.fn();
    const receipt = vi.fn().mockResolvedValue({ taskId: 'known-task' });
    const restarted = await createBot(execute, receipt);
    expect(restarted.getConfigManager().getPendingPrompt('123', '77').state).toBe('uncertain');
    await restarted.handleCallback(callback('confirm'));
    expect(receipt).toHaveBeenCalledWith('telegram:123:77');
    expect(execute).not.toHaveBeenCalled();
    expect(Object.values((await stored()).pendingPrompts)[0]).toMatchObject({ state: 'submitted', taskId: 'known-task' });
  });

  it('does not invoke the callback if durable intent cannot be written', async () => {
    const execute = vi.fn();
    const bot = await createBot(execute);
    await pending(bot);
    vi.spyOn(bot.getConfigManager(), 'save').mockRejectedValueOnce(new Error('disk unavailable'));
    await bot.handleCallback(callback('confirm'));
    expect(execute).not.toHaveBeenCalled();
    expect(bot.getConfigManager().getPendingPrompt('123', '77').state).toBe('pending');
  });

  it('restores edit and selection state, then submits the displayed persisted edit once', async () => {
    const bot = await createBot();
    await pending(bot);
    await bot.handleSelect(message('/select session-a'), ['/select session-a', 'session-a']);
    await bot.handleCallback(callback('edit'));
    const execute = vi.fn().mockResolvedValue({ taskId: 'edited-task' });
    const restarted = await createBot(execute);
    expect(restarted.getConfigManager().getSelectedSession('123')).toBe('session-a');
    await restarted.handleCallback(callback('confirm'));
    expect(execute).not.toHaveBeenCalled();
    await restarted.handleMessage(message('edited after restart'));
    await restarted.handleCallback(callback('confirm'));
    expect(execute).toHaveBeenCalledWith('session-a', 'edited after restart', { idempotencyKey: 'telegram:123:77' });
    expect((await stored()).pendingPrompts).toEqual({});
    expect((await stored()).editingPrompts).toEqual({});
  });

  it('validates persisted fields and drops foreign, stale and malformed routing state', async () => {
    await writeFile(join(dir, 'telegram.json'), JSON.stringify({
      schemaVersion: 1, token: { bad: 'credential' }, enabled: 'yes', chatIds: ['123', '-100', {}],
      sessionMap: { '["123","77"]': 42 }, resultMap: { '["123","77"]': {} },
      pendingPrompts: { '["123","77"]': { chatId: '456', timestamp: Date.now() } },
      selectedSessions: { '456': 'foreign' }, editingPrompts: { '123': '77' }
    }));
    const config = new TelegramConfigManager(dir);
    await config.load();
    expect(config.get()).toMatchObject({ token: '', enabled: false, chatIds: ['123'],
      sessionMap: {}, resultMap: {}, pendingPrompts: {}, selectedSessions: {}, editingPrompts: {} });
    expect((await stat(join(dir, 'telegram.json'))).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent atomic snapshots without partial JSON or temporary files', async () => {
    const config = new TelegramConfigManager(dir);
    await config.load();
    await config.addChatId('123');
    await Promise.all(Array.from({ length: 12 }, (_, index) => config.mapMessage('123', String(index), `session-${index}`)));
    expect(Object.keys((await stored()).sessionMap)).toHaveLength(12);
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
});
