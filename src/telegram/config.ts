import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

export interface TelegramConfig {
  token: string;
  enabled: boolean;
  chatIds: string[];
  sessionMap: Record<string, string>; // telegramMessageId -> claudeSessionId
}

const DEFAULT_CONFIG: TelegramConfig = {
  token: '',
  enabled: false,
  chatIds: [],
  sessionMap: {},
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
}
