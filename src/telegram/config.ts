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
  sessionMap: Record<string, string>; // telegramMessageId -> claudeSessionId
  forwardAllSessions?: boolean; // Forward all session completions to Telegram (default: true)
  // Voice pipeline
  speechmaticsApiKey?: string;  // Legacy — use sttProvider instead
  sttProvider?: STTProviderConfig;
  aiProvider?: AIProviderConfig;
  pendingPrompts: Record<string, PendingPrompt>; // messageId -> pending
  resultMap: Record<string, string>; // messageId -> result text (for TTS)
}

const DEFAULT_CONFIG: TelegramConfig = {
  token: '',
  enabled: false,
  chatIds: [],
  sessionMap: {},
  pendingPrompts: {},
  resultMap: {},
};

export class TelegramConfigManager {
  private configPath: string;
  private configDir: string;
  private config: TelegramConfig = { ...DEFAULT_CONFIG };

  constructor(configDir: string) {
    this.configDir = configDir;
    this.configPath = `${configDir}/telegram.json`;
  }

  async load(): Promise<TelegramConfig> {
    if (!existsSync(this.configPath)) {
      this.config = { ...DEFAULT_CONFIG };
      return this.config;
    }
    try {
      const content = await readFile(this.configPath, 'utf-8');
      this.config = { ...DEFAULT_CONFIG, ...JSON.parse(content) };
      // Auto-migrate legacy speechmaticsApiKey → sttProvider
      if (this.config.speechmaticsApiKey && !this.config.sttProvider) {
        this.config.sttProvider = { provider: 'speechmatics', apiKey: this.config.speechmaticsApiKey };
        await this.save();
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG };
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

  async disable(): Promise<void> {
    this.config.enabled = false;
    this.config.token = '';
    this.config.chatIds = [];
    this.config.sessionMap = {};
    await this.save();
  }

  async addChatId(chatId: string): Promise<void> {
    if (!this.config.chatIds.includes(chatId)) {
      this.config.chatIds.push(chatId);
      await this.save();
    }
  }

  async mapMessage(telegramMessageId: string, claudeSessionId: string): Promise<void> {
    this.config.sessionMap[telegramMessageId] = claudeSessionId;
    // Keep map size bounded — remove oldest entries beyond 500
    const keys = Object.keys(this.config.sessionMap);
    if (keys.length > 500) {
      for (const key of keys.slice(0, keys.length - 500)) {
        delete this.config.sessionMap[key];
      }
    }
    await this.save();
  }

  getSessionForMessage(telegramMessageId: string): string | undefined {
    return this.config.sessionMap[telegramMessageId];
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
  addPendingPrompt(messageId: string, pending: PendingPrompt): void {
    this.config.pendingPrompts[messageId] = pending;
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

  getPendingPrompt(messageId: string): PendingPrompt | undefined {
    const pending = this.config.pendingPrompts[messageId];
    if (pending && Date.now() - pending.timestamp > 10 * 60 * 1000) {
      delete this.config.pendingPrompts[messageId];
      return undefined;
    }
    return pending;
  }

  removePendingPrompt(messageId: string): void {
    delete this.config.pendingPrompts[messageId];
  }

  updatePendingPrompt(messageId: string, optimizedPrompt: string): void {
    const pending = this.config.pendingPrompts[messageId];
    if (pending) {
      pending.optimizedPrompt = optimizedPrompt;
    }
  }

  // Result map (for TTS playback of notification results)
  storeResult(messageId: string, resultText: string): void {
    this.config.resultMap[messageId] = resultText.slice(0, 5000);
    // Cap at 200 entries
    const keys = Object.keys(this.config.resultMap);
    if (keys.length > 200) {
      for (const key of keys.slice(0, keys.length - 200)) {
        delete this.config.resultMap[key];
      }
    }
  }

  getResult(messageId: string): string | undefined {
    return this.config.resultMap[messageId];
  }
}
