import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeBTelegramBot } from './bot.js';

describe('Telegram private chat authorization', () => {
  let dir: string;
  let bot: any;
  let onPrompt: ReturnType<typeof vi.fn>;
  let getSessions: ReturnType<typeof vi.fn>;
  let getInboxCount: ReturnType<typeof vi.fn>;
  let transport: Record<string, ReturnType<typeof vi.fn>>;

  const message = (id = 123, type = 'private', sender = id) => ({
    message_id: 1, date: 0, chat: { id, type }, from: { id: sender }, text: 'hello',
  });
  const callback = (data: string, id = 123, sender = id, type = 'private') => ({
    id: 'query', data, from: { id: sender }, message: message(id, type, sender),
  });

  beforeEach(async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '');
    dir = await mkdtemp(join(tmpdir(), 'cb-bot-auth-'));
    await writeFile(join(dir, 'telegram.json'), JSON.stringify({ chatIds: ['123', '456'], pendingPrompts: {}, sessionMap: {}, resultMap: {} }));
    onPrompt = vi.fn().mockResolvedValue(undefined);
    getSessions = vi.fn().mockReturnValue([{ id: 'session', name: 'work', status: 'idle' }]);
    getInboxCount = vi.fn().mockResolvedValue({ total: 1, unread: 1 });
    bot = new ClaudeBTelegramBot({ configDir: dir, onPrompt, getSessions, getInboxCount });
    await bot.configManager.load();
    transport = { sendMessage: vi.fn().mockResolvedValue({ message_id: 2 }), editMessageText: vi.fn().mockResolvedValue(undefined), answerCallbackQuery: vi.fn().mockResolvedValue(undefined) };
    bot.bot = transport;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  function pending() {
    bot.configManager.addPendingPrompt('123', 'pending', { chatId: '123', sessionId: 'session', transcript: 'raw', optimizedPrompt: 'optimized', timestamp: Date.now() });
  }

  it('denies new registrations until explicitly allowed and requires a private sender', async () => {
    await bot.handleStart(message(789));
    expect(bot.configManager.get().chatIds).not.toContain('789');
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '789');
    await bot.handleStart(message(789, 'group'));
    await bot.handleStart(message(789, 'private', 999));
    expect(bot.configManager.get().chatIds).not.toContain('789');
    await bot.handleStart(message(789));
    expect(bot.configManager.get().chatIds).toContain('789');
  });

  it('keeps existing paired private chats usable and applies later allow-list restrictions', async () => {
    await bot.handleSessions(message());
    expect(getSessions).toHaveBeenCalledOnce();
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '456');
    await bot.handleSessions(message());
    expect(getSessions).toHaveBeenCalledOnce();
  });

  it('guards every command, message, voice action and callback from unregistered chats', async () => {
    for (const method of ['handleSessions', 'handleSelect', 'handleInbox', 'handleVoiceStatus', 'handleHelp', 'handleVoice', 'handleMessage']) {
      await bot[method](message(999), ['/select session', 'session']);
    }
    await bot.handleCallback(callback('select:session', 999));
    expect(getSessions).not.toHaveBeenCalled();
    expect(getInboxCount).not.toHaveBeenCalled();
    expect(onPrompt).not.toHaveBeenCalled();
    expect(bot.selectedSession.size).toBe(0);
  });

  it('rejects group actions and callbacks whose sender is not the registered private chat', async () => {
    await bot.handleSessions(message(123, 'group'));
    await bot.handleCallback(callback('select:session', 123, 456));
    await bot.handleCallback(callback('select:session', 123, 123, 'group'));
    expect(getSessions).not.toHaveBeenCalled();
    expect(bot.selectedSession.size).toBe(0);
  });

  it('does not let another paired chat confirm, edit or cancel a pending prompt', async () => {
    pending();
    for (const action of ['confirm', 'edit', 'cancel']) await bot.handleCallback(callback(`${action}:pending`, 456));
    expect(onPrompt).not.toHaveBeenCalled();
    expect(bot.configManager.getPendingPrompt('123', 'pending')).toBeDefined();
    expect(bot.editState.size).toBe(0);
  });

  it('submits concurrent and repeated confirmation callbacks only once', async () => {
    pending();
    let release!: () => void;
    onPrompt.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = bot.handleCallback(callback('confirm:pending'));
    await vi.waitFor(() => expect(onPrompt).toHaveBeenCalledOnce());
    await bot.handleCallback(callback('confirm:pending'));
    release();
    await first;
    await bot.handleCallback(callback('confirm:pending'));
    expect(onPrompt).toHaveBeenCalledOnce();
    expect(bot.configManager.getPendingPrompt('123', 'pending')).toBeUndefined();
  });

  it('retains a pending prompt after a failed submission and permits an explicit retry', async () => {
    pending();
    onPrompt.mockRejectedValueOnce(new Error('provider unavailable'));
    await bot.handleCallback(callback('confirm:pending'));
    expect(bot.configManager.getPendingPrompt('123', 'pending')).toBeDefined();
    await bot.handleCallback(callback('confirm:pending'));
    expect(onPrompt).toHaveBeenCalledTimes(2);
    expect(bot.configManager.getPendingPrompt('123', 'pending')).toBeUndefined();
  });

  it('does not submit an old prompt while an edit is pending', async () => {
    pending();
    await bot.handleCallback(callback('edit:pending'));
    await bot.handleCallback(callback('confirm:pending'));
    expect(onPrompt).not.toHaveBeenCalled();
    expect(bot.configManager.getPendingPrompt('123', 'pending')).toBeDefined();
  });
  it('pairs only a fresh matching private challenge and persists single-use consumption', async () => {
    const { code } = await bot.beginPairing('789');
    const date = Math.floor(Date.now() / 1000);
    await bot.handleStart({ ...message(789, 'group'), date, text: `/start ${code}` });
    await bot.handleStart({ ...message(789, 'private', 999), date, text: `/start ${code}` });
    expect(bot.configManager.get().chatIds).not.toContain('789');
    await bot.handleStart({ ...message(789), date, text: `/start ${code}` });
    expect(bot.configManager.get().chatIds).toContain('789');
    expect(bot.configManager.get().pairingChallenge.used).toBe(true);
    await bot.configManager.load();
    await bot.handleStart({ ...message(999), date, text: `/start ${code}` });
    expect(bot.configManager.get().chatIds).not.toContain('999');
  });

  it('expires challenge enrollment and preserves explicit manual allow-list enrollment', async () => {
    const { code } = await bot.beginPairing();
    bot.configManager.get().pairingChallenge.expiresAt = Date.now() - 1;
    await bot.handleStart({ ...message(789), date: Math.floor(Date.now() / 1000), text: `/start ${code}` });
    expect(bot.configManager.get().chatIds).not.toContain('789');
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '789');
    await bot.handleStart(message(789));
    expect(bot.configManager.get().chatIds).toContain('789');
  });

});
