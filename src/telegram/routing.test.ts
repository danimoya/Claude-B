import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ClaudeBTelegramBot } from './bot.js';

describe('Telegram scoped routing and voice editing', () => {
  let dir: string;
  let bot: any;
  let onPrompt: ReturnType<typeof vi.fn>;
  let transport: Record<string, ReturnType<typeof vi.fn>>;
  let synthesize: ReturnType<typeof vi.fn>;

  const message = (chatId: number, text: string, replyId?: number) => ({
    message_id: 90, date: 0, chat: { id: chatId, type: 'private' },
    from: { id: chatId }, text,
    ...(replyId ? { reply_to_message: { message_id: replyId } } : {}),
  });
  const callback = (chatId: number, data: string) => ({
    id: `query-${chatId}`, data, from: { id: chatId },
    message: { ...message(chatId, ''), message_id: 77 },
  });
  const notification = (sessionId: string, resultPreview: string) => ({
    sessionId, resultPreview, type: 'prompt.completed', exitCode: 0,
  });

  beforeEach(async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '');
    dir = await mkdtemp(join(tmpdir(), 'cb-tg-routing-'));
    await writeFile(join(dir, 'telegram.json'), JSON.stringify({ chatIds: ['123', '456', '-100123'], sessionMap: {}, resultMap: {}, pendingPrompts: {} }));
    onPrompt = vi.fn().mockResolvedValue(undefined);
    bot = new ClaudeBTelegramBot({ configDir: dir, onPrompt });
    await bot.getConfigManager().load();
    synthesize = vi.fn().mockResolvedValue(Buffer.from('fake audio'));
    bot.setVoicePipeline({ synthesize });
    transport = {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 77 }),
      editMessageText: vi.fn().mockResolvedValue(undefined),
      editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      sendVoice: vi.fn().mockResolvedValue(undefined),
    };
    bot.bot = transport;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  function pending(chatId = '123') {
    bot.getConfigManager().addPendingPrompt(chatId, '77', {
      chatId, sessionId: `session-${chatId}`, transcript: 'raw transcript',
      optimizedPrompt: 'original prompt', timestamp: Date.now(),
    });
  }

  it('routes replies and Listen callbacks to the originating chat despite colliding message IDs', async () => {
    await bot.sendNotification('123', notification('session-a', 'result a'));
    await bot.sendNotification('456', notification('session-b', 'result b'));
    await bot.handleMessage(message(123, 'follow up a', 77));
    await bot.handleMessage(message(456, 'follow up b', 77));
    expect(onPrompt.mock.calls).toEqual([['session-a', 'follow up a'], ['session-b', 'follow up b']]);

    await bot.handleCallback(callback(123, 'listen:77'));
    await bot.handleCallback(callback(456, 'listen:77'));
    expect(synthesize.mock.calls).toEqual([['result a'], ['result b']]);
    expect(transport.sendVoice.mock.calls.map(([chat]) => chat)).toEqual(['123', '456']);
  });

  it('does not fall through to another selected session for an expired notification reply', async () => {
    bot.selectedSession.set('123', 'unrelated-session');
    await bot.handleMessage(message(123, 'reply to old notification', 88));
    expect(onPrompt).not.toHaveBeenCalled();
    expect(transport.sendMessage).toHaveBeenCalledWith('123', expect.stringContaining('mapping expired'), {});
  });

  it('never broadcasts private results to old group IDs, unpaired chats or chats excluded by the current allow-list', async () => {
    vi.stubEnv('TELEGRAM_ALLOWED_CHAT_IDS', '456');
    await bot.broadcastNotification(notification('private-session', 'private result'));
    await bot.sendNotification('789', notification('private-session', 'private result'));
    expect(transport.sendMessage.mock.calls.map(([chat]) => chat)).toEqual(['456']);
    expect(bot.getConfigManager().getResult('123', '77')).toBeUndefined();
    expect(bot.getConfigManager().getResult('-100123', '77')).toBeUndefined();
  });

  it('retains one confirmation ID through editing and submits the displayed edit only once', async () => {
    pending();
    await bot.handleCallback(callback(123, 'edit:77'));
    await bot.handleMessage(message(123, 'edited literal prompt'));
    const [, options] = transport.editMessageText.mock.calls[0];
    expect(options).toMatchObject({ chat_id: '123', message_id: 77 });
    expect(options.reply_markup.inline_keyboard[0].map((button: any) => button.callback_data)).toEqual(['confirm:77', 'edit:77', 'cancel:77']);
    expect(bot.getConfigManager().getPendingPrompt('123', '77')?.optimizedPrompt).toBe('edited literal prompt');
    await bot.handleCallback(callback(123, 'confirm:77'));
    await bot.handleCallback(callback(123, 'confirm:77'));
    expect(onPrompt).toHaveBeenCalledOnce();
    expect(onPrompt).toHaveBeenCalledWith('session-123', 'edited literal prompt');
  });

  it('keeps a failed edit pending and prevents stale confirmation until the edit is retried', async () => {
    pending();
    await bot.handleCallback(callback(123, 'edit:77'));
    transport.editMessageText.mockRejectedValueOnce(new Error('transport unavailable'));
    await bot.handleMessage(message(123, 'new prompt'));
    expect(bot.getConfigManager().getPendingPrompt('123', '77')?.optimizedPrompt).toBe('original prompt');
    await bot.handleCallback(callback(123, 'confirm:77'));
    expect(onPrompt).not.toHaveBeenCalled();
    await bot.handleMessage(message(123, 'new prompt'));
    await bot.handleCallback(callback(123, 'confirm:77'));
    expect(onPrompt).toHaveBeenCalledOnce();
    expect(onPrompt).toHaveBeenCalledWith('session-123', 'new prompt');
  });

  it('does not block another chat with the same pending message ID during confirmation', async () => {
    pending('123');
    pending('456');
    let release!: () => void;
    onPrompt.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = bot.handleCallback(callback(123, 'confirm:77'));
    await vi.waitFor(() => expect(onPrompt).toHaveBeenCalledOnce());
    await bot.handleCallback(callback(456, 'confirm:77'));
    expect(onPrompt.mock.calls.map(([session]) => session)).toEqual(['session-123', 'session-456']);
    release();
    await first;
  });

  it('cancels edit mode without turning /cancel into a session prompt', async () => {
    pending();
    await bot.handleCallback(callback(123, 'edit:77'));
    await bot.handleMessage(message(123, '/cancel'));
    expect(bot.editState.has('123')).toBe(false);
    expect(bot.getConfigManager().getPendingPrompt('123', '77')?.optimizedPrompt).toBe('original prompt');
    await bot.handleMessage(message(123, '/cancel'));
    expect(onPrompt).not.toHaveBeenCalled();
  });
});
