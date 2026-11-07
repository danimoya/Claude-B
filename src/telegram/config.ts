import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

export interface AIProviderConfig {
  provider: 'anthropic' | 'openrouter';
  apiKey: string;
  model?: string;
}

export interface STTProviderConfig {
  provider: 'speechmatics' | 'deepgram' | 'openai';
  apiKey: string;
  // Optional TTS tuning — currently honored by the OpenAI provider.
  // Edit these fields in telegram.json and re-run `cb --voice-setup openai <key>`
  // (or restart the daemon) to apply. Defaults: 'gpt-4o-mini-tts' / 'alloy'.
  ttsModel?: string;
  ttsVoice?: string;
}

export interface PendingPrompt {
  chatId: string;
  sessionId: string;
  transcript: string;
  optimizedPrompt: string;
  timestamp: number;
}

export interface TelegramConfig {
  token: string;
  enabled: boolean;
  chatIds: string[];
  sessionMap: Record<string, string>; // [chatId, messageId] -> claudeSessionId
  forwardAllSessions?: boolean; // Forward all session completions to Telegram (default: true)
  // Voice pipeline
  speechmaticsApiKey?: string;  // Legacy — use sttProvider instead
  sttProvider?: STTProviderConfig;
  aiProvider?: AIProviderConfig;
  pendingPrompts: Record<string, PendingPrompt>; // [chatId, messageId] -> pending
  resultMap: Record<string, string>; // [chatId, messageId] -> result text (for TTS)
}

const DEFAULT_CONFIG: TelegramConfig = {
  token: '',
  enabled: false,
  chatIds: [],
  sessionMap: {},
  pendingPrompts: {},
  resultMap: {},
};

function defaultConfig(): TelegramConfig {
  return { ...DEFAULT_CONFIG, chatIds: [], sessionMap: {}, pendingPrompts: {}, resultMap: {} };
}

export function telegramMessageKey(chatId: string, messageId: string): string {
  return JSON.stringify([chatId, messageId]);
}

function scopedEntries<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map || {}).filter(([key]) => {
    try {
      const parts: unknown = JSON.parse(key);
      return Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string');
    } catch {
      return false;
    }
  }));
}

export class TelegramConfigManager {
  private configPath: string;
  private configDir: string;
  private config: TelegramConfig = defaultConfig();

  constructor(configDir: string) {
    this.configDir = configDir;
    this.configPath = `${configDir}/telegram.json`;
  }

  async load(): Promise<TelegramConfig> {
    if (!existsSync(this.configPath)) {
      this.config = defaultConfig();
      return this.config;
    }
    try {
      const content = await readFile(this.configPath, 'utf-8');
      this.config = { ...defaultConfig(), ...JSON.parse(content) };
      // Telegram message IDs are only unique inside a chat. Legacy bare IDs
      // cannot be assigned to an owner reliably; never reuse them for routing.
      this.config.sessionMap = scopedEntries(this.config.sessionMap);
      this.config.resultMap = scopedEntries(this.config.resultMap);
      this.config.pendingPrompts = scopedEntries(this.config.pendingPrompts);
      // Auto-migrate legacy speechmaticsApiKey → sttProvider
      if (this.config.speechmaticsApiKey && !this.config.sttProvider) {
        this.config.sttProvider = { provider: 'speechmatics', apiKey: this.config.speechmaticsApiKey };
        await this.save();
      }
    } catch {
      this.config = defaultConfig();
    }
    return this.config;
  }

  async save(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2) + '\n');
  }

  get(): TelegramConfig {
    return this.config;
  }

  shouldForwardSession(): boolean {
    return this.config.forwardAllSessions ?? true;
  }

  async setForwardAllSessions(enabled: boolean): Promise<void> {
    this.config.forwardAllSessions = enabled;
    await this.save();
  }

  async setToken(token: string): Promise<void> {
    this.config.token = token;
    this.config.enabled = true;
    await this.save();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.config.enabled = enabled;
    await this.save();
  }

  async disable(): Promise<void> {
    this.config.enabled = false;
    this.config.token = '';
    this.config.chatIds = [];
    this.config.sessionMap = {};
    this.config.pendingPrompts = {};
    this.config.resultMap = {};
    await this.save();
  }

  async addChatId(chatId: string): Promise<void> {
    if (!this.config.chatIds.includes(chatId)) {
      this.config.chatIds.push(chatId);
      await this.save();
    }
  }

  async mapMessage(chatId: string, telegramMessageId: string, claudeSessionId: string): Promise<void> {
    this.config.sessionMap[telegramMessageKey(chatId, telegramMessageId)] = claudeSessionId;
    // Keep map size bounded — remove oldest entries beyond 500
    const keys = Object.keys(this.config.sessionMap);
    if (keys.length > 500) {
      for (const key of keys.slice(0, keys.length - 500)) {
        delete this.config.sessionMap[key];
      }
    }
    await this.save();
  }

  getSessionForMessage(chatId: string, telegramMessageId: string): string | undefined {
    return this.config.sessionMap[telegramMessageKey(chatId, telegramMessageId)];
  }

  // Voice config
  async setSTTProvider(config: STTProviderConfig): Promise<void> {
    this.config.sttProvider = config;
    // Keep legacy field in sync for backward compat
    if (config.provider === 'speechmatics') {
      this.config.speechmaticsApiKey = config.apiKey;
    }
    await this.save();
  }

  /** @deprecated Use setSTTProvider instead */
  async setSpeechmaticsKey(key: string): Promise<void> {
    await this.setSTTProvider({ provider: 'speechmatics', apiKey: key });
  }

  async setAIProvider(config: AIProviderConfig): Promise<void> {
    this.config.aiProvider = config;
    await this.save();
  }

  // Pending prompts (awaiting user confirmation)
  addPendingPrompt(chatId: string, messageId: string, pending: PendingPrompt): void {
    if (pending.chatId !== chatId) throw new Error('Pending prompt owner must match chat');
    this.config.pendingPrompts[telegramMessageKey(chatId, messageId)] = pending;
    // Expire old entries (>10 min) and cap at 50
    const now = Date.now();
    const entries = Object.entries(this.config.pendingPrompts);
    for (const [key, val] of entries) {
      if (now - val.timestamp > 10 * 60 * 1000) {
        delete this.config.pendingPrompts[key];
      }
    }
    const keys = Object.keys(this.config.pendingPrompts);
    if (keys.length > 50) {
      for (const key of keys.slice(0, keys.length - 50)) {
        delete this.config.pendingPrompts[key];
      }
    }
  }

  getPendingPrompt(chatId: string, messageId: string): PendingPrompt | undefined {
    const key = telegramMessageKey(chatId, messageId);
    const pending = this.config.pendingPrompts[key];
    if (pending && (pending.chatId !== chatId || Date.now() - pending.timestamp > 10 * 60 * 1000)) {
      delete this.config.pendingPrompts[key];
      return undefined;
    }
    return pending;
  }

  removePendingPrompt(chatId: string, messageId: string): void {
    delete this.config.pendingPrompts[telegramMessageKey(chatId, messageId)];
  }

  updatePendingPrompt(chatId: string, messageId: string, optimizedPrompt: string): void {
    const pending = this.getPendingPrompt(chatId, messageId);
    if (pending) {
      pending.optimizedPrompt = optimizedPrompt;
    }
  }

  // Result map (for TTS playback of notification results)
  storeResult(chatId: string, messageId: string, resultText: string): void {
    this.config.resultMap[telegramMessageKey(chatId, messageId)] = resultText.slice(0, 5000);
    // Cap at 200 entries
    const keys = Object.keys(this.config.resultMap);
    if (keys.length > 200) {
      for (const key of keys.slice(0, keys.length - 200)) {
        delete this.config.resultMap[key];
      }
    }
  }

  getResult(chatId: string, messageId: string): string | undefined {
    return this.config.resultMap[telegramMessageKey(chatId, messageId)];
  }
}
