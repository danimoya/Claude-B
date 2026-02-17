import TelegramBot from 'node-telegram-bot-api';
import { EventEmitter } from 'events';
import { TelegramConfigManager } from './config.js';
import { VoicePipeline } from './voice.js';
import { SessionContext } from './ai-provider.js';

export interface TelegramBotOptions {
  configDir: string;
  onPrompt?: (sessionId: string, prompt: string) => Promise<void>;
  getSessions?: () => Array<{ id: string; name?: string; status: string }>;
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
  private voicePipeline: VoicePipeline | null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private healthCheckInterval: NodeJS.Timeout | null = null;

  constructor(options: TelegramBotOptions) {
    super();
    this.options = options;
    this.configManager = new TelegramConfigManager(options.configDir);
    this.voicePipeline = options.voicePipeline || null;
  }

  setVoicePipeline(pipeline: VoicePipeline): void {
    this.voicePipeline = pipeline;
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
      console.error(`[Telegram Bot] Polling error: ${error.message}`);
      if (this.shouldReconnect(error)) {
        setTimeout(() => this.attemptReconnect(), 5000);
      }
    });

    // Register command handlers
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/sessions/, (msg) => this.handleSessions(msg));
    this.bot.onText(/\/select (.+)/, (msg, match) => this.handleSelect(msg, match));
    this.bot.onText(/\/inbox/, (msg) => this.handleInbox(msg));
    this.bot.onText(/\/voice/, (msg) => this.handleVoiceStatus(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));

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
      // Build send options with optional Listen button
      const opts: TelegramBot.SendMessageOptions = {};
      const sent = await this.bot.sendMessage(chatId, text, opts);

      // Map this message to the session for reply routing
      await this.configManager.mapMessage(String(sent.message_id), notification.sessionId);

      // Add Listen button if voice pipeline is available and there's a result
      if (this.voicePipeline && notification.resultPreview) {
        this.configManager.storeResult(String(sent.message_id), notification.resultPreview);
        // Edit message to add the button (sendMessage doesn't support reply_markup with plain text easily)
        try {
          await this.bot.editMessageReplyMarkup({
            inline_keyboard: [[
              { text: '🔊 Listen', callback_data: `listen:${sent.message_id}` }
            ]]
          }, { chat_id: chatId, message_id: sent.message_id });
        } catch {
          // Not critical if button fails
        }
      }

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

  getConfigManager(): TelegramConfigManager {
    return this.configManager;
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

  private async handleVoiceStatus(msg: TelegramBot.Message): Promise<void> {
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
    const chatId = String(msg.chat.id);

    // Check authorization
    const config = this.configManager.get();
    if (!config.chatIds.includes(chatId)) {
      await this.safeSend(chatId, 'Not authorized. Send /start first.');
      return;
    }

    if (!this.voicePipeline) {
      await this.safeSend(chatId, '🎤 Voice pipeline not configured.\nUse cb --voice-setup <speechmatics|deepgram|openai> <api-key> on the server.');
      return;
    }

    if (!msg.voice) return;

    // Determine target session
    let targetSession: string | undefined;
    if (msg.reply_to_message) {
      targetSession = this.configManager.getSessionForMessage(String(msg.reply_to_message.message_id));
    }
    if (!targetSession) {
      targetSession = this.selectedSession.get(chatId);
    }
    if (!targetSession) {
      await this.safeSend(chatId, 'No session selected. Use /select <id> first.');
      return;
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
      this.configManager.addPendingPrompt(String(statusMsg.message_id), {
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
    }
  }

  private async handleConfirmPrompt(chatId: string, pendingId: string, messageId: number): Promise<void> {
    const pending = this.configManager.getPendingPrompt(pendingId);
    if (!pending) {
      await this.safeSend(chatId, '⏰ Prompt expired. Send another voice message.');
      return;
    }

    if (!this.options.onPrompt) {
      await this.safeSend(chatId, 'Prompt routing not available');
      return;
    }

    try {
      await this.options.onPrompt(pending.sessionId, pending.optimizedPrompt);
      this.configManager.removePendingPrompt(pendingId);

      // Update the message to show it was sent
      await this.bot!.editMessageText(
        `⏳ Prompt sent to session ${pending.sessionId.slice(0, 8)}\n\n${pending.optimizedPrompt}`,
        { chat_id: chatId, message_id: messageId }
      ).catch(() => {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.safeSend(chatId, `❌ Error: ${errMsg}`);
    }
  }

  private async handleEditPrompt(chatId: string, pendingId: string, _messageId: number): Promise<void> {
    const pending = this.configManager.getPendingPrompt(pendingId);
    if (!pending) {
      await this.safeSend(chatId, '⏰ Prompt expired. Send another voice message.');
      return;
    }

    // Set edit state — next text message from this chat replaces the prompt
    this.editState.set(chatId, pendingId);
    await this.safeSend(chatId, '✏️ Send your edited prompt (or /cancel to abort):');
  }

  private async handleCancelPrompt(chatId: string, pendingId: string, messageId: number): Promise<void> {
    this.configManager.removePendingPrompt(pendingId);
    this.editState.delete(chatId);

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

    const resultText = this.configManager.getResult(resultMsgId);
    if (!resultText) {
      await this.safeSend(chatId, '🔊 Result no longer available for playback');
      return;
    }

    try {
      await this.safeSend(chatId, '🔊 Generating audio...');
      const audioBuffer = await this.voicePipeline.synthesize(resultText);
      await this.bot!.sendVoice(chatId, audioBuffer, {}, { filename: 'result.ogg', contentType: 'audio/ogg' });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.safeSend(chatId, `🔊 TTS error: ${errMsg}`);
    }
  }

  // ─── Connection Stability ──────────────────────────────────────────

  private shouldReconnect(error: Error): boolean {
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

  private async attemptReconnect(): Promise<void> {
    if (!this.bot || this.reconnectAttempts >= this.maxReconnectAttempts) return;

    this.reconnectAttempts++;
    const delay = 5000 * this.reconnectAttempts;

    console.log(`[Telegram Bot] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);

    try {
      await this.bot.stopPolling();
      await new Promise(resolve => setTimeout(resolve, delay));
      await this.bot.startPolling();
      this.reconnectAttempts = 0;
      console.log('[Telegram Bot] Reconnected successfully');
    } catch (error) {
      console.error(`[Telegram Bot] Reconnect failed: ${error instanceof Error ? error.message : error}`);
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        setTimeout(() => this.attemptReconnect(), delay);
      }
    }
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    this.healthCheckInterval = setInterval(async () => {
      if (!this.bot) return;
      try {
        await this.bot.getMe();
      } catch (error) {
        console.error(`[Telegram Bot] Health check failed: ${error instanceof Error ? error.message : error}`);
        this.attemptReconnect();
      }
    }, 5 * 60 * 1000);  // Every 5 minutes
  }

  // ─── Text Message Handler ─────────────────────────────────────────

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

    // Check if user is in edit mode (editing a voice prompt)
    const editPendingId = this.editState.get(chatId);
    if (editPendingId) {
      this.editState.delete(chatId);

      if (text === '/cancel') {
        await this.safeSend(chatId, '✏️ Edit cancelled');
        return;
      }

      const pending = this.configManager.getPendingPrompt(editPendingId);
      if (!pending) {
        await this.safeSend(chatId, '⏰ Prompt expired. Send another voice message.');
        return;
      }

      // Update the pending prompt with user's edit
      this.configManager.updatePendingPrompt(editPendingId, text);

      // Show updated prompt with buttons
      const displayText = [
        `🎤 Original transcript:`,
        `"${pending.transcript}"`,
        '',
        `📝 Edited prompt:`,
        text,
      ].join('\n');

      try {
        // Send a new message with updated prompt and buttons
        const newMsg = await this.bot!.sendMessage(chatId, displayText, {
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ Send', callback_data: `confirm:${editPendingId}` },
              { text: '✏️ Edit', callback_data: `edit:${editPendingId}` },
              { text: '❌ Cancel', callback_data: `cancel:${editPendingId}` },
            ]],
          },
        });

        // Move pending prompt to new message ID
        const updatedPending = { ...pending, optimizedPrompt: text };
        this.configManager.removePendingPrompt(editPendingId);
        this.configManager.addPendingPrompt(String(newMsg.message_id), updatedPending);
      } catch {
        await this.safeSend(chatId, '❌ Failed to update prompt');
      }
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
