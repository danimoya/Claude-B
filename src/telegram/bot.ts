import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import { TelegramConfigManager } from './config.js';

export interface TelegramBotOptions {
  configDir: string;
  onPrompt?: (sessionId: string, prompt: string) => Promise<void>;
  getSessions?: () => Array<{ id: string; name?: string; status: string }>;
  getInboxCount?: () => Promise<{ total: number; unread: number }>;
}

export class ClaudeBTelegramBot extends EventEmitter {
  private bot: TelegramBot | null = null;
  private configManager: TelegramConfigManager;
  private options: TelegramBotOptions;
  private selectedSession: Map<string, string> = new Map(); // chatId -> sessionId

  constructor(options: TelegramBotOptions) {
    super();
    this.options = options;
    this.configManager = new TelegramConfigManager(options.configDir);
  }

  async start(token?: string): Promise<{ username?: string }> {
    const config = await this.configManager.load();
    const botToken = token || config.token;

    if (!botToken) {
      throw new Error('No Telegram bot token configured');
    }

    if (token) {
      await this.configManager.setToken(token);
    }

    this.bot = new TelegramBot(botToken, { polling: true });

    // Register command handlers
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/sessions/, (msg) => this.handleSessions(msg));
    this.bot.onText(/\/select (.+)/, (msg, match) => this.handleSelect(msg, match));
    this.bot.onText(/\/inbox/, (msg) => this.handleInbox(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));

    // Handle regular messages (prompts to sessions)
    this.bot.on('message', (msg) => {
      // Skip commands
      if (msg.text?.startsWith('/')) return;
      this.handleMessage(msg);
    });

    // Get bot info
    const me = await this.bot.getMe();
    return { username: me.username };
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
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
    if (!this.bot) return;

    const isSuccess = notification.type === 'prompt.completed';
    const icon = isSuccess ? '✅' : '❌';
    const status = isSuccess ? 'completed' : 'failed';
    const name = notification.sessionName || notification.sessionId;
    const duration = notification.durationMs ? `${(notification.durationMs / 1000).toFixed(1)}s` : '';
    const cost = notification.costUsd ? ` · $${notification.costUsd.toFixed(4)}` : '';

    // Build plain text message (safe for any content)
    const lines: string[] = [];
    lines.push(`${icon} ${name} ${status}${duration ? ` (${duration}${cost})` : ''}`);

    if (notification.goal) {
      lines.push(`Goal: ${notification.goal}`);
    }

    if (notification.resultPreview) {
      lines.push('');
      // Telegram message limit is 4096 chars; leave room for header/footer
      lines.push(notification.resultPreview.slice(0, 3000));
    }

    lines.push('');
    lines.push(`Reply to follow up, or /select ${notification.sessionId.slice(0, 8)}`);

    const text = lines.join('\n');

    try {
      const sent = await this.bot.sendMessage(chatId, text);

      // Map this message to the session for reply routing
      await this.configManager.mapMessage(String(sent.message_id), notification.sessionId);

      return sent.message_id;
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

  // Safe send: try Markdown, fall back to plain text on parse error
  private async safeSend(chatId: string, text: string, markdown = false): Promise<void> {
    if (!this.bot) return;
    try {
      await this.bot.sendMessage(chatId, text, markdown ? { parse_mode: 'Markdown' } : {});
    } catch {
      // If Markdown fails, retry as plain text
      if (markdown) {
        try { await this.bot.sendMessage(chatId, text); } catch { /* give up */ }
      }
    }
  }

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = String(msg.chat.id);
    await this.configManager.addChatId(chatId);

    const text = [
      '🤖 Claude-B Telegram Integration',
      '',
      'You are now registered for notifications.',
      '',
      'Commands:',
      '/sessions - List active sessions',
      '/select <id> - Select session for replies',
      '/inbox - Show notification inbox',
      '/help - Show this help',
      '',
      'Send any text to prompt the selected session.',
    ].join('\n');

    await this.safeSend(chatId, text);
  }

  private async handleSessions(msg: TelegramBot.Message): Promise<void> {
    const chatId = String(msg.chat.id);

    if (!this.options.getSessions) {
      await this.safeSend(chatId, 'Session listing not available');
      return;
    }

    const sessions = this.options.getSessions();
    if (sessions.length === 0) {
      await this.safeSend(chatId, 'No active sessions');
      return;
    }

    const selected = this.selectedSession.get(chatId);
    const lines = sessions.map(s => {
      const marker = s.id === selected ? '▸ ' : '  ';
      const name = s.name ? ` (${s.name})` : '';
      return `${marker}${s.id.slice(0, 8)}${name} [${s.status}]`;
    });

    const text = `Sessions:\n\n${lines.join('\n')}\n\nUse /select <id> to choose one.`;
    await this.safeSend(chatId, text);
  }

  private async handleSelect(msg: TelegramBot.Message, match: RegExpMatchArray | null): Promise<void> {
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

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const chatId = String(msg.chat.id);
    const text = [
      '🤖 Claude-B Commands',
      '',
      '/sessions - List active sessions',
      '/select <id> - Select session for replies',
      '/inbox - Show notification inbox summary',
      '/help - Show this help',
      '',
      'Send any text to prompt the selected session.',
      'Reply to a notification to follow up on that session.',
    ].join('\n');

    await this.safeSend(chatId, text);
  }

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = String(msg.chat.id);
    const text = msg.text?.trim();
    if (!text) return;

    // Check if authorized
    const config = this.configManager.get();
    if (!config.chatIds.includes(chatId)) {
      await this.safeSend(chatId, 'Not authorized. Send /start first.');
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
      targetSession = this.configManager.getSessionForMessage(replyMsgId);
    }

    // Otherwise use the selected session
    if (!targetSession) {
      targetSession = this.selectedSession.get(chatId);
    }

    if (!targetSession) {
      await this.safeSend(chatId, 'No session selected. Use /select <id> or reply to a notification.');
      return;
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
