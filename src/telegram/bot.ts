import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import { TelegramConfigManager, telegramMessageKey } from './config.js';
import { VoicePipeline } from './voice.js';
import { SessionContext } from './ai-provider.js';
import { isChatAllowed } from './allow-list.js';
import { sanitizeForSpeech } from './tts-text.js';

/**
 * Convert common Markdown patterns to Telegram-safe HTML.
 * Handles code blocks, inline code, bold, and italic while escaping
 * HTML entities. Intentionally skips underscore-based italic to avoid
 * false positives on file paths like some_file_name.ts.
 */
function markdownToTelegramHtml(md: string): string {
  // 1. Extract fenced code blocks before escaping so their contents stay raw.
  const codeBlocks: string[] = [];
  let html = md.replace(/```[\w]*\n?([\s\S]*?)```/g, (_m, code: string) => {
    codeBlocks.push(code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // 2. Extract markdown tables and render with Unicode box-drawing chars.
  //    Telegram has no <table> support; box-drawing inside <pre> gives
  //    bordered tables that look clean on both desktop and mobile.
  const tables: string[] = [];
  html = html.replace(/(?:^|\n)((?:\|.*\|[ \t]*\n?)+)/g, (_m, table: string) => {
    const rows = table
      .split('\n')
      .filter((line: string) => line.trim().length > 0)
      .filter((line: string) => !/^\|[\s:|-]+\|$/.test(line.trim())); // strip separator

    if (rows.length === 0) return _m;

    // Parse cells and compute column widths
    const parsed = rows.map((row: string) =>
      row.replace(/^\||\|$/g, '').split('|').map((c: string) => c.trim())
    );
    const colCount = Math.max(...parsed.map((r: string[]) => r.length));
    const colWidths = Array.from({ length: colCount }, (_, ci) =>
      Math.max(...parsed.map((r: string[]) => (r[ci] || '').length), 1)
    );

    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

    const hLine = (l: string, m: string, r: string, f: string) =>
      l + colWidths.map((w: number) => f.repeat(w + 2)).join(m) + r;

    const dataRow = (cells: string[]) =>
      '│' + colWidths.map((w: number, i: number) => ` ${pad(esc(cells[i] || ''), w)} `).join('│') + '│';

    const lines: string[] = [];
    lines.push(hLine('┌', '┬', '┐', '─'));
    lines.push(dataRow(parsed[0]));
    if (parsed.length > 1) {
      lines.push(hLine('├', '┼', '┤', '─'));
      for (let i = 1; i < parsed.length; i++) {
        lines.push(dataRow(parsed[i]));
      }
    }
    lines.push(hLine('└', '┴', '┘', '─'));

    tables.push(lines.join('\n'));
    return `\x00TB${tables.length - 1}\x00`;
  });

  // 3. Extract inline code spans.
  const inlineCode: string[] = [];
  html = html.replace(/`([^`]+)`/g, (_m, code: string) => {
    inlineCode.push(code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // 3. Escape remaining HTML entities.
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 4. Bold: **text**
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 5. Italic: *text* (single asterisk only — underscores skipped)
  html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');

  // 6. Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 8. Re-insert code blocks, tables, and inline code.
  html = html.replace(/\x00CB(\d+)\x00/g, (_m, i) => `<pre>${codeBlocks[Number(i)]}</pre>`);
  html = html.replace(/\x00TB(\d+)\x00/g, (_m, i) => `<pre>${tables[Number(i)]}</pre>`);
  html = html.replace(/\x00IC(\d+)\x00/g, (_m, i) => `<code>${inlineCode[Number(i)]}</code>`);

  return html;
}

export interface TelegramBotOptions {
  configDir: string;
  onPrompt?: (sessionId: string, prompt: string) => Promise<void>;
  onCreateSession?: () => Promise<{ sessionId: string; name?: string } | null>;
  getSessions?: () => Array<{ id: string; name?: string; status: string; executionPolicy?: 'default' | 'bypass' }>;
  onExecutionPolicy?: (sessionId: string, policy: 'default' | 'bypass') => Promise<void>;
  getInboxCount?: () => Promise<{ total: number; unread: number }>;
  getSessionContext?: (sessionId: string) => SessionContext | undefined;
  voicePipeline?: VoicePipeline;
}

export class ClaudeBTelegramBot extends EventEmitter {
  private bot: TelegramBot | null = null;
  private configManager: TelegramConfigManager;
  private options: TelegramBotOptions;
  private selectedSession: Map<string, string> = new Map(); // chatId -> sessionId
  private editState: Map<string, string> = new Map(); // chatId -> messageId (awaiting edit)
  private confirmingPrompts = new Set<string>();
  private voicePipeline: VoicePipeline | null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private pollingSuspendedReason: string | null = null;
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private lastPollingErrorMessage: string | null = null;
  private lastPollingErrorLogAt = 0;
  private suppressedPollingErrorCount = 0;

  constructor(options: TelegramBotOptions) {
    super();
    this.options = options;
    this.configManager = new TelegramConfigManager(options.configDir);
    this.voicePipeline = options.voicePipeline || null;
  }

  async beginPairing(expectedSenderId?: string): Promise<{ code: string; expiresAt: number }> {
    return this.configManager.beginPairing(expectedSenderId);
  }

  setVoicePipeline(pipeline: VoicePipeline): void {
    this.voicePipeline = pipeline;
  }

  async start(token?: string): Promise<{ username?: string }> {
    const config = await this.configManager.load();
    const botToken = token || config.token;
    const explicitStart = !!token;

    if (!botToken) {
      throw new Error('No Telegram bot token configured');
    }

    if (!explicitStart && !config.enabled) {
      throw new Error('Telegram bot disabled');
    }

    if (token) {
      await this.configManager.setToken(token);
    }

    if (this.bot) {
      const me = await this.bot.getMe();
      return { username: me.username };
    }

    this.pollingSuspendedReason = null;

    this.bot = new TelegramBot(botToken, {
      polling: {
        interval: 300,
        autoStart: true,
        params: {
          timeout: 60,  // Telegram recommends 60s for long polling
        },
      },
    });

    // Handle polling errors — log + auto-reconnect on transient failures
    this.bot.on('polling_error', (error) => {
      if (this.isPollingConflict(error)) {
        this.suspendPolling('Telegram 409 Conflict: another getUpdates poller is using this bot token').catch(() => {});
        return;
      }

      this.logPollingError(error);
      if (this.shouldReconnect(error)) {
        this.scheduleReconnect();
      }
    });

    // Register command handlers
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/sessions/, (msg) => this.handleSessions(msg));
    this.bot.onText(/\/select (.+)/, (msg, match) => this.handleSelect(msg, match));
    this.bot.onText(/\/inbox/, (msg) => this.handleInbox(msg));
    this.bot.onText(/\/voice/, (msg) => this.handleVoiceStatus(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));
    this.bot.onText(/^\/policy(?:@\w+)?(?:\s+.*)?$/, (msg) => this.handlePolicy(msg));
    this.bot.onText(/^\/cancel(?:@\w+)?$/, (msg) => this.handleMessage({ ...msg, text: '/cancel' }));

    // Handle voice messages
    this.bot.on('voice', (msg) => this.handleVoice(msg));

    // Handle inline keyboard callbacks
    this.bot.on('callback_query', (query) => this.handleCallback(query));

    // Handle regular messages (prompts to sessions)
    this.bot.on('message', (msg) => {
      // Skip commands and voice messages
      if (msg.text?.startsWith('/')) return;
      if (msg.voice) return;
      this.handleMessage(msg);
    });

    // Get bot info
    const me = await this.bot.getMe();
    this.reconnectAttempts = 0;
    this.startHealthCheck();
    return { username: me.username };
  }

  async stop(): Promise<void> {
    this.clearReconnectTimer();
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
  }

  async disable(): Promise<void> {
    await this.stop();
    await this.configManager.disable();
  }

  async sendNotification(chatId: string, notification: {
    sessionId: string;
    sessionName?: string;
    type: string;
    goal?: string;
    exitCode: number | null;
    durationMs?: number;
    costUsd?: number;
    resultPreview?: string;
  }): Promise<number | undefined> {
    if (!this.bot || !/^[1-9]\d*$/.test(chatId) || !this.isAuthorizedChat(chatId)) return;

    const isSuccess = notification.type === 'prompt.completed';
    const icon = isSuccess ? '✅' : '❌';
    const status = isSuccess ? 'completed' : 'failed';
    const name = notification.sessionName || notification.sessionId;
    const duration = notification.durationMs ? `${(notification.durationMs / 1000).toFixed(1)}s` : '';
    const cost = notification.costUsd ? ` · $${notification.costUsd.toFixed(4)}` : '';

    // Build HTML-formatted message so markdown in Claude Code output renders.
    // Long bodies are chunked across multiple messages to stay under Telegram's
    // 4096-char per-message hard limit. The first message holds header / PWD,
    // owns the session->message_id mapping, and carries the Listen button.
    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    const header = `${icon} <b>${escHtml(name)}</b> ${status}${duration ? ` (${duration}${cost})` : ''}`;
    const pwdLine = notification.goal ? `PWD: ${escHtml(notification.goal)}` : '';
    const footer = `Reply to follow up, or /select ${notification.sessionId.slice(0, 8)}`;

    // Markdown -> HTML expands (tables, fences, bold), so budget raw input per
    // chunk well below 4096. 2800 leaves headroom for the wrappers + headers.
    const RAW_CHUNK_BUDGET = 2800;
    const HARD_LIMIT = 4096;

    const rawBody = notification.resultPreview || '';
    const rawChunks: string[] = [];
    if (rawBody) {
      const inLines = rawBody.split('\n');
      let cur = '';
      const flush = () => { if (cur) { rawChunks.push(cur); cur = ''; } };
      for (const ln of inLines) {
        // Hard-split any single line longer than the budget
        let remaining = ln;
        while (remaining.length > RAW_CHUNK_BUDGET) {
          flush();
          rawChunks.push(remaining.slice(0, RAW_CHUNK_BUDGET));
          remaining = remaining.slice(RAW_CHUNK_BUDGET);
        }
        if (cur.length + remaining.length + 1 > RAW_CHUNK_BUDGET) flush();
        cur += (cur ? '\n' : '') + remaining;
      }
      flush();
    }

    const total = Math.max(1, rawChunks.length);

    // Build each message's text
    const buildMessage = (idx: number): string => {
      const parts: string[] = [];
      const tag = total > 1 ? ` (${idx + 1}/${total})` : '';
      if (idx === 0) {
        parts.push(`${header}${tag}`);
        if (pwdLine) parts.push(pwdLine);
        if (rawChunks[0]) {
          parts.push('');
          parts.push(markdownToTelegramHtml(rawChunks[0]));
        }
      } else {
        parts.push(`📄 <b>${escHtml(name)}</b> continued${tag}`);
        parts.push('');
        parts.push(markdownToTelegramHtml(rawChunks[idx]));
      }
      if (idx === total - 1) {
        parts.push('');
        parts.push(footer);
      }
      let text = parts.join('\n');
      if (text.length > HARD_LIMIT) {
        // Last-resort truncate (shouldn't trigger given the raw budget).
        text = text.slice(0, HARD_LIMIT - 24) + '\n… [truncated]';
      }
      return text;
    };

    const sendOne = async (text: string): Promise<TelegramBot.Message | undefined> => {
      const opts: TelegramBot.SendMessageOptions = { parse_mode: 'HTML' };
      try {
        return await this.bot!.sendMessage(chatId, text, opts);
      } catch {
        // HTML parse failed (or some other Telegram rejection) — strip tags and retry.
        let plain = text.replace(/<[^>]+>/g, '');
        if (plain.length > HARD_LIMIT) plain = plain.slice(0, HARD_LIMIT - 24) + '\n… [truncated]';
        try {
          return await this.bot!.sendMessage(chatId, plain);
        } catch {
          return undefined;
        }
      }
    };

    try {
      // Send first message — this one anchors the session mapping + Listen button.
      const firstSent = await sendOne(buildMessage(0));
      if (!firstSent) return undefined;

      await this.configManager.mapMessage(chatId, String(firstSent.message_id), notification.sessionId);

      if (this.voicePipeline && notification.resultPreview) {
        this.configManager.storeResult(chatId, String(firstSent.message_id), notification.resultPreview);
        try {
          await this.bot.editMessageReplyMarkup({
            inline_keyboard: [[
              { text: '🔊 Listen', callback_data: `listen:${firstSent.message_id}` }
            ]]
          }, { chat_id: chatId, message_id: firstSent.message_id });
        } catch {
          // Not critical if button fails
        }
      }

      // Send continuation chunks. Map each to the same session so replies on any
      // chunk still route correctly. Don't fail the whole notification if a
      // continuation drops — first message already landed.
      for (let i = 1; i < total; i++) {
        const cont = await sendOne(buildMessage(i));
        if (cont) {
          await this.configManager.mapMessage(chatId, String(cont.message_id), notification.sessionId);
        }
      }

      return firstSent.message_id;
    } catch (err) {
      this.emit('error', err);
      return undefined;
    }
  }

  async broadcastNotification(notification: {
    sessionId: string;
    sessionName?: string;
    type: string;
    goal?: string;
    exitCode: number | null;
    durationMs?: number;
    costUsd?: number;
    resultPreview?: string;
  }): Promise<void> {
    const config = this.configManager.get();
    for (const chatId of config.chatIds) {
      await this.sendNotification(chatId, notification);
    }
  }

  isRunning(): boolean {
    return this.bot !== null;
  }

  getConfig(): { enabled: boolean; chatIds: string[] } {
    const config = this.configManager.get();
    return { enabled: config.enabled, chatIds: config.chatIds };
  }

  getConfigManager(): TelegramConfigManager {
    return this.configManager;
  }

  // Safe send: try with parse_mode, fall back to plain text on parse error
  private async safeSend(chatId: string, text: string, parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(chatId, text, parseMode ? { parse_mode: parseMode } : {});
    } catch {
      // If formatted send fails, retry as plain text
      if (parseMode) {
        try { await this.bot.sendMessage(chatId, text); } catch { /* give up */ }
      }
    }
  }

  private isPrivateActor(chat: TelegramBot.Chat, sender: TelegramBot.User | undefined): boolean {
    return chat.type === 'private' && !!sender && String(sender.id) === String(chat.id);
  }

  private isAuthorizedChat(chatId: string): boolean {
    const allowedRaw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    return this.configManager.get().chatIds.includes(chatId) &&
      (!allowedRaw?.trim() || isChatAllowed(chatId, allowedRaw));
  }

  private async authorizeMessage(msg: TelegramBot.Message): Promise<boolean> {
    if (!this.isPrivateActor(msg.chat, msg.from)) return false;
    if (this.isAuthorizedChat(String(msg.chat.id))) return true;
    await this.safeSend(String(msg.chat.id), 'Not authorized. Ask the owner to pair this private chat.');
    return false;
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    if (!this.isPrivateActor(msg.chat, msg.from)) return;
    const chatId = String(msg.chat.id);

    // A challenge is an owner-created capability, bound to a private sender.
    // An explicit allow-list remains an additional restriction on all actions.
    const allowedRaw = process.env.TELEGRAM_ALLOWED_CHAT_IDS;
    if (allowedRaw?.trim() && !isChatAllowed(chatId, allowedRaw)) return;
    if (!this.isAuthorizedChat(chatId) && !isChatAllowed(chatId, allowedRaw)) {
      if (!await this.configManager.consumePairing(msg)) {
        await this.safeSend(chatId, '⛔ This bot is private. Pair with the owner-provided /start challenge.');
        return;
      }
    }
    await this.configManager.addChatId(chatId);

    const voiceStatus = this.voicePipeline ? '🎤 Voice input: Active' : '🎤 Voice input: Not configured';

    const text = [
      '🤖 Claude-B Telegram Integration',
      '',
      'You are now registered for notifications.',
      '',
      'Commands:',
      '/sessions - List active sessions',
      '/select <id> - Select session for replies',
      '/inbox - Show notification inbox',
      '/voice - Voice pipeline status',
      '/help - Show this help',
      '',
      'Send any text to prompt the selected session.',
      'Send a voice message for AI-optimized prompts.',
      '',
      voiceStatus,
    ].join('\n');

    await this.safeSend(chatId, text);
  }

  private async handleSessions(msg: TelegramBot.Message): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);

    if (!this.options.getSessions) {
      await this.safeSend(chatId, 'Session listing not available');
      return;
    }

    const sessions = this.options.getSessions();
    if (sessions.length === 0) {
      await this.safeSend(chatId, 'No active sessions. Send a message to create one.');
      return;
    }

    const selected = this.selectedSession.get(chatId);
    const lines = sessions.map(s => {
      const marker = s.id === selected ? '▸ ' : '  ';
      const name = s.name ? ` (${s.name})` : '';
      const policy = s.executionPolicy ? ` policy:${s.executionPolicy}` : '';
      return `${marker}${s.id.slice(0, 8)}${name} [${s.status}${policy}]`;
    });

    // Build inline keyboard — one button per session
    const keyboard = sessions.map(s => {
      const label = s.name || s.id.slice(0, 8);
      const suffix = s.id === selected ? ' ✓' : '';
      return [{ text: `${label}${suffix}`, callback_data: `select:${s.id}` }];
    });

    const text = `Sessions:\n\n${lines.join('\n')}`;
    try {
      await this.bot!.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch {
      // Fallback to plain text if keyboard fails
      await this.safeSend(chatId, `${text}\n\nUse /select <id> to choose one.`);
    }
  }

  private async handlePolicy(msg: TelegramBot.Message): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);
    const args = (msg.text || '').trim().split(/\s+/).slice(1);
    const sessions = this.options.getSessions?.() || [];
    const selected = this.selectedSession.get(chatId);
    if (args.length === 0) {
      const session = sessions.find(item => item.id === selected);
      await this.safeSend(chatId, session?.executionPolicy
        ? `Session ${session.id}: policy ${session.executionPolicy}`
        : 'Usage: /policy <default|bypass> [session-id]. Select a managed session first.');
      return;
    }
    if (args.length > 2 || !['default', 'bypass'].includes(args[0])) {
      await this.safeSend(chatId, 'Usage: /policy <default|bypass> [session-id]');
      return;
    }
    const target = args[1] || selected;
    const exact = sessions.find(item => item.id === target || item.name === target);
    const matches = exact ? [exact] : sessions.filter(item => target && item.id.startsWith(target));
    if (matches.length !== 1 || !this.options.onExecutionPolicy) {
      await this.safeSend(chatId, 'Select one known managed session; policy changes are unavailable for ambiguous targets.');
      return;
    }
    if (matches[0].id.startsWith('tmux:')) {
      await this.safeSend(chatId, 'Native tmux agents manage their own execution policy.');
      return;
    }
    try {
      await this.options.onExecutionPolicy(matches[0].id, args[0] as 'default' | 'bypass');
      await this.safeSend(chatId, `Session ${matches[0].id}: policy ${args[0]}`);
    } catch (error) {
      await this.safeSend(chatId, `Policy change failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  private async handleSelect(msg: TelegramBot.Message, match: RegExpMatchArray | null): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);
    const sessionId = match?.[1]?.trim();

    if (!sessionId) {
      await this.safeSend(chatId, 'Usage: /select <session-id>');
      return;
    }

    // Find matching session (partial ID match)
    if (this.options.getSessions) {
      const sessions = this.options.getSessions();
      const found = sessions.find(s => s.id.startsWith(sessionId) || s.name === sessionId);
      if (found) {
        this.selectedSession.set(chatId, found.id);
        const name = found.name ? ` (${found.name})` : '';
        await this.safeSend(chatId, `Selected session: ${found.id.slice(0, 8)}${name}`);
        return;
      }
    }

    // Store as-is if we can't verify
    this.selectedSession.set(chatId, sessionId);
    await this.safeSend(chatId, `Selected session: ${sessionId}`);
  }

  private async handleInbox(msg: TelegramBot.Message): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);

    if (!this.options.getInboxCount) {
      await this.safeSend(chatId, 'Inbox not available');
      return;
    }

    const counts = await this.options.getInboxCount();
    const text = counts.unread > 0
      ? `📬 ${counts.unread} unread notification${counts.unread !== 1 ? 's' : ''} (${counts.total} total)\n\nUse cb -i on the server for full inbox.`
      : `📭 No unread notifications (${counts.total} total)`;

    await this.safeSend(chatId, text);
  }

  private async handleVoiceStatus(msg: TelegramBot.Message): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);

    if (!this.voicePipeline) {
      const text = [
        '🎤 Voice Pipeline: Not configured',
        '',
        'Set up with:',
        '  cb --voice-setup <speechmatics-key>',
        '  cb --ai-provider anthropic <key>',
      ].join('\n');
      await this.safeSend(chatId, text);
      return;
    }

    const info = this.voicePipeline.getInfo();
    const ttsAvailable = await this.voicePipeline.isTTSAvailable();

    const text = [
      '🎤 Voice Pipeline: Active',
      `  STT: ${info.stt} (${info.language})`,
      `  AI: ${info.ai.provider} (${info.ai.model})`,
      `  TTS: ${ttsAvailable ? 'Available (ffmpeg found)' : 'Unavailable (ffmpeg not found)'}`,
      '',
      'Send a voice message to create an AI-optimized prompt.',
    ].join('\n');

    await this.safeSend(chatId, text);
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);
    const text = [
      '🤖 Claude-B Commands',
      '',
      '/sessions - List active sessions',
      '/select <id> - Select session for replies',
      '/inbox - Show notification inbox summary',
      '/voice - Voice pipeline status',
      '/help - Show this help',
      '',
      'Send any text to prompt the selected session.',
      'Send a voice message for AI-optimized prompts.',
      'Reply to a notification to follow up on that session.',
    ].join('\n');

    await this.safeSend(chatId, text);
  }

  // ─── Voice Message Handler ─────────────────────────────────────────

  private async handleVoice(msg: TelegramBot.Message): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);

    if (!this.voicePipeline) {
      await this.safeSend(chatId, '🎤 Voice pipeline not configured.\nUse cb --voice-setup <speechmatics|deepgram|openai> <api-key> on the server.');
      return;
    }

    if (!msg.voice) return;

    // Determine target session
    let targetSession: string | undefined;
    if (msg.reply_to_message) {
      targetSession = this.configManager.getSessionForMessage(chatId, String(msg.reply_to_message.message_id));
      if (!targetSession) {
        await this.safeSend(chatId, 'Notification mapping expired. Use /select <id> and send a new message.');
        return;
      }
    }
    if (!targetSession) {
      targetSession = this.selectedSession.get(chatId);
    }
    // Auto-create session if none selected
    if (!targetSession) {
      if (!this.options.onCreateSession) {
        await this.safeSend(chatId, 'No session selected. Use /select <id> first.');
        return;
      }
      try {
        const created = await this.options.onCreateSession();
        if (!created) {
          await this.safeSend(chatId, '❌ Failed to create session');
          return;
        }
        targetSession = created.sessionId;
        this.selectedSession.set(chatId, targetSession);
        const label = created.name || targetSession.slice(0, 8);
        await this.safeSend(chatId, `New session created: ${label}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.safeSend(chatId, `❌ Failed to create session: ${errMsg}`);
        return;
      }
    }

    // Send status message
    let statusMsg: TelegramBot.Message | undefined;
    try {
      statusMsg = await this.bot!.sendMessage(chatId, '🎤 Transcribing...');
    } catch {
      return;
    }

    try {
      // 1. Download and transcribe audio
      const fileStream = this.bot!.getFileStream(msg.voice.file_id);
      const transcript = await this.voicePipeline.transcribe(fileStream);

      if (!transcript) {
        await this.bot!.editMessageText('❌ Could not transcribe audio. Try again or send text.', {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
        return;
      }

      // 2. Get session context
      const context = this.options.getSessionContext?.(targetSession);

      // 3. Optimize prompt
      await this.bot!.editMessageText('🎤 Transcribed. Optimizing prompt...', {
        chat_id: chatId,
        message_id: statusMsg.message_id,
      });

      const optimizedPrompt = await this.voicePipeline.optimizePrompt(transcript, context);

      // 4. Show transcript + optimized prompt with confirmation buttons
      const sessionName = context?.sessionName || targetSession.slice(0, 8);
      const displayText = [
        `🎤 Transcript:`,
        `"${transcript}"`,
        '',
        `📝 Optimized prompt:`,
        optimizedPrompt,
        '',
        `Session: ${sessionName} (${context?.status || 'unknown'})`,
      ].join('\n');

      await this.bot!.editMessageText(displayText, {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Send', callback_data: `confirm:${statusMsg.message_id}` },
            { text: '✏️ Edit', callback_data: `edit:${statusMsg.message_id}` },
            { text: '❌ Cancel', callback_data: `cancel:${statusMsg.message_id}` },
          ]],
        },
      });

      // 5. Store pending prompt
      this.configManager.addPendingPrompt(chatId, String(statusMsg.message_id), {
        chatId,
        sessionId: targetSession,
        transcript,
        optimizedPrompt,
        timestamp: Date.now(),
      });

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      try {
        await this.bot!.editMessageText(`❌ Voice error: ${errMsg}`, {
          chat_id: chatId,
          message_id: statusMsg.message_id,
        });
      } catch {
        await this.safeSend(chatId, `❌ Voice error: ${errMsg}`);
      }
    }
  }

  // ─── Callback Query Handler (inline keyboard buttons) ─────────────

  private async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    if (!this.bot || !query.data || !query.message) return;
    if (!this.isPrivateActor(query.message.chat, query.from) || !this.isAuthorizedChat(String(query.message.chat.id))) return;

    const chatId = String(query.message.chat.id);
    const data = query.data;

    // Always acknowledge the callback
    await this.bot.answerCallbackQuery(query.id).catch(() => {});

    if (data.startsWith('confirm:')) {
      await this.handleConfirmPrompt(chatId, data.slice(8), query.message.message_id);
    } else if (data.startsWith('edit:')) {
      await this.handleEditPrompt(chatId, data.slice(5), query.message.message_id);
    } else if (data.startsWith('cancel:')) {
      await this.handleCancelPrompt(chatId, data.slice(7), query.message.message_id);
    } else if (data.startsWith('listen:')) {
      await this.handleListenTTS(chatId, data.slice(7));
    } else if (data.startsWith('select:')) {
      await this.handleSelectCallback(chatId, data.slice(7), query.message.message_id);
    }
  }

  private async handleConfirmPrompt(chatId: string, pendingId: string, messageId: number): Promise<void> {
    const pending = this.configManager.getPendingPrompt(chatId, pendingId);
    if (!pending || pending.chatId !== chatId) {
      await this.safeSend(chatId, '⏰ Prompt expired. Send another voice message.');
      return;
    }

    if (!this.options.onPrompt) {
      await this.safeSend(chatId, 'Prompt routing not available');
      return;
    }
    if (this.confirmingPrompts.has(telegramMessageKey(chatId, pendingId))) return;
    if (this.editState.get(chatId) === pendingId) {
      await this.safeSend(chatId, 'Finish editing the prompt before confirming.');
      return;
    }
    this.confirmingPrompts.add(telegramMessageKey(chatId, pendingId));

    try {
      await this.options.onPrompt(pending.sessionId, pending.optimizedPrompt);
      this.configManager.removePendingPrompt(chatId, pendingId);

      // Debug / audit view: keep both the raw transcript and the optimized
      // prompt visible after send so the user can see "what I said" vs
      // "what was actually submitted to the session".
      const sentLabel = pending.sessionId.startsWith('tmux:')
        ? pending.sessionId.slice('tmux:'.length)
        : pending.sessionId.slice(0, 8);
      const confirmedText = [
        `⏳ Prompt sent → ${sentLabel}`,
        '',
        `🎤 Transcript:`,
        `"${pending.transcript}"`,
        '',
        `📝 Submitted prompt:`,
        pending.optimizedPrompt,
      ].join('\n');
      await this.bot!.editMessageText(confirmedText, {
        chat_id: chatId,
        message_id: messageId,
      }).catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.safeSend(chatId, `❌ Error: ${errMsg}`);
    } finally {
      this.confirmingPrompts.delete(telegramMessageKey(chatId, pendingId));
    }
  }

  private async handleEditPrompt(chatId: string, pendingId: string, _messageId: number): Promise<void> {
    const pending = this.configManager.getPendingPrompt(chatId, pendingId);
    if (!pending || pending.chatId !== chatId || this.confirmingPrompts.has(telegramMessageKey(chatId, pendingId))) {
      await this.safeSend(chatId, '⏰ Prompt expired. Send another voice message.');
      return;
    }

    // Set edit state — next text message from this chat replaces the prompt
    this.editState.set(chatId, pendingId);
    await this.safeSend(chatId, '✏️ Send your edited prompt (or /cancel to abort):');
  }

  private async handleCancelPrompt(chatId: string, pendingId: string, messageId: number): Promise<void> {
    const pending = this.configManager.getPendingPrompt(chatId, pendingId);
    if (!pending || pending.chatId !== chatId || this.confirmingPrompts.has(telegramMessageKey(chatId, pendingId))) return;
    this.configManager.removePendingPrompt(chatId, pendingId);
    if (this.editState.get(chatId) === pendingId) this.editState.delete(chatId);

    await this.bot!.editMessageText('❌ Cancelled', {
      chat_id: chatId,
      message_id: messageId,
    }).catch(() => {});
  }

  private async handleListenTTS(chatId: string, resultMsgId: string): Promise<void> {
    if (!this.voicePipeline) {
      await this.safeSend(chatId, '🔊 TTS not available');
      return;
    }

    const resultText = this.configManager.getResult(chatId, resultMsgId);
    if (!resultText) {
      await this.safeSend(chatId, '🔊 Result no longer available for playback');
      return;
    }

    // Strip code blocks, tables, links, emoji and metadata so the TTS reads the
    // prose, not the markup. If nothing speakable remains (e.g. a code-only
    // reply), say so instead of synthesizing an empty/odd clip.
    const speechText = sanitizeForSpeech(resultText);
    if (!speechText) {
      await this.safeSend(chatId, '🔊 Nothing to read aloud (the result was code or non-text content).');
      return;
    }

    try {
      await this.safeSend(chatId, '🔊 Generating audio...');
      const audioBuffer = await this.voicePipeline.synthesize(speechText);
      await this.bot!.sendVoice(chatId, audioBuffer, {}, { filename: 'result.ogg', contentType: 'audio/ogg' });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.safeSend(chatId, `🔊 TTS error: ${errMsg}`);
    }
  }

  private async handleSelectCallback(chatId: string, sessionId: string, messageId: number): Promise<void> {
    // Verify session exists
    if (this.options.getSessions) {
      const sessions = this.options.getSessions();
      const found = sessions.find(s => s.id === sessionId);
      if (found) {
        this.selectedSession.set(chatId, found.id);
        const name = found.name ? ` (${found.name})` : '';
        // Update the sessions message to reflect new selection
        const selected = found.id;
        const lines = sessions.map(s => {
          const marker = s.id === selected ? '▸ ' : '  ';
          const sName = s.name ? ` (${s.name})` : '';
          return `${marker}${s.id.slice(0, 8)}${sName} [${s.status}]`;
        });
        const keyboard = sessions.map(s => {
          const label = s.name || s.id.slice(0, 8);
          const suffix = s.id === selected ? ' ✓' : '';
          return [{ text: `${label}${suffix}`, callback_data: `select:${s.id}` }];
        });
        try {
          await this.bot!.editMessageText(`Sessions:\n\n${lines.join('\n')}\n\nSelected: ${found.id.slice(0, 8)}${name}`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard },
          });
        } catch {
          await this.safeSend(chatId, `Selected session: ${found.id.slice(0, 8)}${name}`);
        }
        return;
      }
    }

    // Fallback — store as-is
    this.selectedSession.set(chatId, sessionId);
    await this.safeSend(chatId, `Selected session: ${sessionId.slice(0, 8)}`);
  }

  // ─── Connection Stability ──────────────────────────────────────────

  private shouldReconnect(error: Error): boolean {
    if (this.pollingSuspendedReason || this.isPollingConflict(error)) {
      return false;
    }

    const message = error.message.toLowerCase();
    if (message.includes('unauthorized') || message.includes('not found')) {
      return false;
    }
    if (message.includes('etelegram') || message.includes('timeout') ||
        message.includes('network') || message.includes('econnrefused') ||
        message.includes('econnreset') || message.includes('socket')) {
      return this.reconnectAttempts < this.maxReconnectAttempts;
    }
    return false;
  }

  private isPollingConflict(error: Error): boolean {
    const message = error.message.toLowerCase();
    return message.includes('409 conflict') ||
      message.includes('terminated by other getupdates request') ||
      message.includes('only one bot instance is running');
  }

  private logPollingError(error: Error): void {
    const now = Date.now();
    const message = error.message;
    const sameRecentError = this.lastPollingErrorMessage === message &&
      now - this.lastPollingErrorLogAt < 60_000;

    if (sameRecentError) {
      this.suppressedPollingErrorCount++;
      return;
    }

    if (this.suppressedPollingErrorCount > 0 && this.lastPollingErrorMessage) {
      console.error(
        `[Telegram Bot] Suppressed ${this.suppressedPollingErrorCount} repeated polling errors: ${this.lastPollingErrorMessage}`
      );
      this.suppressedPollingErrorCount = 0;
    }

    this.lastPollingErrorMessage = message;
    this.lastPollingErrorLogAt = now;
    console.error(`[Telegram Bot] Polling error: ${message}`);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.bot || this.reconnectTimer || this.reconnecting) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;

    this.reconnectAttempts++;
    const baseDelay = Math.min(5 * 60_000, 5000 * 2 ** (this.reconnectAttempts - 1));
    const jitter = Math.floor(Math.random() * 1000);
    const delay = baseDelay + jitter;

    console.log(`[Telegram Bot] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect().catch(() => {});
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.bot || this.reconnecting || this.pollingSuspendedReason) return;

    this.reconnecting = true;
    try {
      await this.bot.stopPolling();
      await this.bot.startPolling();
      console.log('[Telegram Bot] Reconnected successfully');
    } catch (error) {
      console.error(`[Telegram Bot] Reconnect failed: ${error instanceof Error ? error.message : error}`);
      this.scheduleReconnect();
    } finally {
      this.reconnecting = false;
    }
  }

  private async suspendPolling(reason: string): Promise<void> {
    if (this.pollingSuspendedReason) return;

    this.pollingSuspendedReason = reason;
    this.clearReconnectTimer();
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    const bot = this.bot;
    this.bot = null;
    console.error(`[Telegram Bot] Polling suspended: ${reason}. Telegram has been disabled in telegram.json.`);

    try {
      await bot?.stopPolling();
    } catch {
      // Best effort; the important part is to stop scheduling more polling.
    }

    try {
      await this.configManager.setEnabled(false);
    } catch (error) {
      console.error(`[Telegram Bot] Failed to persist disabled state: ${error instanceof Error ? error.message : error}`);
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    this.healthCheckInterval = setInterval(async () => {
      if (!this.bot) return;
      try {
        await this.bot.getMe();
        this.reconnectAttempts = 0;
      } catch (error) {
        console.error(`[Telegram Bot] Health check failed: ${error instanceof Error ? error.message : error}`);
        if (error instanceof Error && this.isPollingConflict(error)) {
          await this.suspendPolling('Telegram 409 Conflict during health check');
          return;
        }
        this.scheduleReconnect();
      }
    }, 5 * 60 * 1000);  // Every 5 minutes
  }

  // ─── Text Message Handler ─────────────────────────────────────────

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    if (!await this.authorizeMessage(msg)) return;
    const chatId = String(msg.chat.id);
    const text = msg.text?.trim();
    if (!text) return;

    // Check if user is in edit mode (editing a voice prompt)
    const editPendingId = this.editState.get(chatId);
    if (editPendingId) {
      const editKey = telegramMessageKey(chatId, editPendingId);
      if (this.confirmingPrompts.has(editKey)) return;

      if (text === '/cancel') {
        this.editState.delete(chatId);
        await this.safeSend(chatId, '✏️ Edit cancelled');
        return;
      }

      const pending = this.configManager.getPendingPrompt(chatId, editPendingId);
      if (!pending) {
        this.editState.delete(chatId);
        await this.safeSend(chatId, '⏰ Prompt expired. Send another voice message.');
        return;
      }

      // Show updated prompt with buttons
      const displayText = [
        `🎤 Original transcript:`,
        `"${pending.transcript}"`,
        '',
        `📝 Edited prompt:`,
        text,
      ].join('\n');

      this.confirmingPrompts.add(editKey);
      try {
        // Keep the same confirmation message and ID throughout editing. Both
        // displayed content and callback payloads now refer to the same prompt.
        await this.bot!.editMessageText(displayText, {
          chat_id: chatId,
          message_id: Number(editPendingId),
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Send', callback_data: `confirm:${editPendingId}` },
              { text: '✏️ Edit', callback_data: `edit:${editPendingId}` },
              { text: '❌ Cancel', callback_data: `cancel:${editPendingId}` },
            ]],
          },
        });

        this.configManager.updatePendingPrompt(chatId, editPendingId, text);
        this.editState.delete(chatId);
      } catch {
        await this.safeSend(chatId, '❌ Failed to update prompt');
      } finally {
        this.confirmingPrompts.delete(editKey);
      }
      return;
    }

    if (text === '/cancel') {
      await this.safeSend(chatId, 'No prompt edit is pending.');
      return;
    }

    if (!this.options.onPrompt) {
      await this.safeSend(chatId, 'Prompt routing not available');
      return;
    }

    // Determine target session
    let targetSession: string | undefined;

    // If replying to a notification message, route to that session
    if (msg.reply_to_message) {
      const replyMsgId = String(msg.reply_to_message.message_id);
      targetSession = this.configManager.getSessionForMessage(chatId, replyMsgId);
      if (!targetSession) {
        await this.safeSend(chatId, 'Notification mapping expired. Use /select <id> and send a new message.');
        return;
      }
    }

    // Otherwise use the selected session
    if (!targetSession) {
      targetSession = this.selectedSession.get(chatId);
    }

    // Auto-create session if none selected
    if (!targetSession) {
      if (!this.options.onCreateSession) {
        await this.safeSend(chatId, 'No session selected. Use /select <id> or reply to a notification.');
        return;
      }

      try {
        const created = await this.options.onCreateSession();
        if (!created) {
          await this.safeSend(chatId, '❌ Failed to create session');
          return;
        }
        targetSession = created.sessionId;
        this.selectedSession.set(chatId, targetSession);
        const label = created.name || targetSession.slice(0, 8);
        await this.safeSend(chatId, `New session created: ${label}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.safeSend(chatId, `❌ Failed to create session: ${errMsg}`);
        return;
      }
    }

    try {
      await this.options.onPrompt(targetSession, text);
      await this.safeSend(chatId, `⏳ Prompt queued for session ${targetSession.slice(0, 8)}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.safeSend(chatId, `❌ Error: ${errMsg}`);
    }
  }
}
