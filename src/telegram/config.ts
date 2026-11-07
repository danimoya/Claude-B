import { readFile, chmod } from 'fs/promises';
import { atomicWriteJson } from '../storage/atomic-json.js';
import { existsSync } from 'fs';
import { createPairingChallenge, consumePairingChallenge, isPairingChallenge, type PairingChallenge, type PairingMessage } from './pairing.js';

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
  state?: 'pending' | 'submitting' | 'uncertain' | 'submitted';
  idempotencyKey?: string;
  taskId?: string;
  chatId: string;
  sessionId: string;
  transcript: string;
  optimizedPrompt: string;
  timestamp: number;
}

export interface TelegramConfig {
  schemaVersion?: 1;
  selectedSessions?: Record<string, string>;
  editingPrompts?: Record<string, string>;
  pairingChallenge?: PairingChallenge;
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
  return { ...DEFAULT_CONFIG, schemaVersion: 1, chatIds: [], sessionMap: {}, pendingPrompts: {}, resultMap: {}, selectedSessions: {}, editingPrompts: {} };
}

export function telegramMessageKey(chatId: string, messageId: string): string {
  return JSON.stringify([chatId, messageId]);
}

function scopedEntries<T>(map: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(map || {}).filter(([key]) => {
    try {
      const parts: unknown = JSON.parse(key);
      return Array.isArray(parts) && parts.length === 2 && parts.every(part => typeof part === 'string') &&
        /^[1-9]\d*$/.test(parts[0]) && parts[1].length > 0 && parts[1].length <= 100;
    } catch {
      return false;
    }
  }));
}

export class TelegramConfigManager {
  private configPath: string;
  private config: TelegramConfig = defaultConfig();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(configDir: string) {
    this.configPath = `${configDir}/telegram.json`;
  }

  async load(): Promise<TelegramConfig> {
    if (!existsSync(this.configPath)) {
      this.config = defaultConfig();
      return this.config;
    }
    try {
      await chmod(this.configPath, 0o600);
      const content = await readFile(this.configPath, 'utf-8');
      const loaded: unknown = JSON.parse(content);
      if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) throw new Error('Invalid Telegram state');
      const value = loaded as Partial<TelegramConfig>;
      if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('Unsupported Telegram state version');
      this.config = { ...defaultConfig(),
        token: typeof value.token === 'string' ? value.token : '', enabled: value.enabled === true,
        chatIds: Array.isArray(value.chatIds) ? [...new Set(value.chatIds.filter(id => typeof id === 'string' && /^[1-9]\d*$/.test(id)))] : [],
        sessionMap: value.sessionMap || {}, resultMap: value.resultMap || {}, pendingPrompts: value.pendingPrompts || {},
        pairingChallenge: value.pairingChallenge,
        forwardAllSessions: typeof value.forwardAllSessions === 'boolean' ? value.forwardAllSessions : true,
        selectedSessions: value.selectedSessions || {}, editingPrompts: value.editingPrompts || {}
      };
      const validProvider = (provider: unknown, names: string[]): provider is { provider: string; apiKey: string } =>
        !!provider && typeof provider === 'object' && names.includes((provider as { provider: string }).provider) &&
        typeof (provider as { apiKey: string }).apiKey === 'string';
      if (validProvider(value.sttProvider, ['openai', 'speechmatics', 'deepgram'])) {
        this.config.sttProvider = {
        provider: value.sttProvider!.provider, apiKey: value.sttProvider!.apiKey,
        ttsModel: typeof value.sttProvider!.ttsModel === 'string' ? value.sttProvider!.ttsModel : undefined,
        ttsVoice: typeof value.sttProvider!.ttsVoice === 'string' ? value.sttProvider!.ttsVoice : undefined
        };
      }
      if (validProvider(value.aiProvider, ['anthropic', 'openrouter'])) {
        this.config.aiProvider = {
        provider: value.aiProvider!.provider, apiKey: value.aiProvider!.apiKey,
        model: typeof value.aiProvider!.model === 'string' ? value.aiProvider!.model : undefined
        };
      }
      if (typeof value.speechmaticsApiKey === 'string') this.config.speechmaticsApiKey = value.speechmaticsApiKey;
      // Telegram message IDs are only unique inside a chat. Legacy bare IDs
      // cannot be assigned to an owner reliably; never reuse them for routing.
      this.config.sessionMap = Object.fromEntries(Object.entries(scopedEntries(this.config.sessionMap))
        .filter(([, value]) => typeof value === 'string' && value.length > 0).slice(-500));
      this.config.resultMap = Object.fromEntries(Object.entries(scopedEntries(this.config.resultMap))
        .filter(([, value]) => typeof value === 'string').slice(-200).map(([key, value]) => [key, value.slice(0, 5000)]));
      this.config.pendingPrompts = Object.fromEntries(Object.entries(scopedEntries(this.config.pendingPrompts)).filter(([key, pending]) => {
        const owner = JSON.parse(key)[0];
        return pending && typeof pending === 'object' && pending.chatId === owner &&
          typeof pending.sessionId === 'string' && typeof pending.transcript === 'string' &&
          typeof pending.optimizedPrompt === 'string' && Number.isFinite(pending.timestamp) &&
          pending.timestamp <= Date.now() + 30000 && Date.now() - pending.timestamp < 10 * 60 * 1000 &&
          (pending.state === undefined || ['pending', 'submitting', 'uncertain', 'submitted'].includes(pending.state)) &&
          (pending.taskId === undefined || typeof pending.taskId === 'string') &&
          (pending.idempotencyKey === undefined || typeof pending.idempotencyKey === 'string');
      }).slice(-50).map(([key, pending]) => [key, { ...pending,
        state: pending.state === 'submitting' ? 'uncertain' : pending.state || 'pending',
        idempotencyKey: pending.idempotencyKey || `telegram:${JSON.parse(key)[0]}:${JSON.parse(key)[1]}`
      }]));
      this.config.selectedSessions = Object.fromEntries(Object.entries(this.config.selectedSessions || {})
        .filter(([chatId, value]) => /^[1-9]\d*$/.test(chatId) && typeof value === 'string' && this.config.chatIds.includes(chatId)));
      this.config.editingPrompts = Object.fromEntries(Object.entries(this.config.editingPrompts || {})
        .filter(([chatId, messageId]) => typeof messageId === 'string' &&
          this.config.pendingPrompts[telegramMessageKey(chatId, messageId)]?.state === 'pending'));
      if (!isPairingChallenge(this.config.pairingChallenge) || this.config.pairingChallenge.expiresAt <= Date.now()) {
        delete this.config.pairingChallenge;
      }
      // Auto-migrate legacy speechmaticsApiKey → sttProvider
      if (this.config.speechmaticsApiKey && !this.config.sttProvider) {
        this.config.sttProvider = { provider: 'speechmatics', apiKey: this.config.speechmaticsApiKey };
      }
      // Persist schema normalization and submitting→uncertain reconciliation.
      await this.save();
    } catch {
      this.config = defaultConfig();
    }
    return this.config;
  }

  save(): Promise<void> {
    const snapshot = structuredClone(this.config);
    const write = this.writeChain.then(() => atomicWriteJson(this.configPath, snapshot));
    this.writeChain = write.catch(() => {});
    return write;
  }

  async setSelectedSession(chatId: string, sessionId: string): Promise<void> {
    this.config.selectedSessions ||= {};
    this.config.selectedSessions[chatId] = sessionId;
    await this.save();
  }

  getSelectedSession(chatId: string): string | undefined { return this.config.selectedSessions?.[chatId]; }

  async setEditingPrompt(chatId: string, messageId?: string): Promise<void> {
    this.config.editingPrompts ||= {};
    if (messageId) this.config.editingPrompts[chatId] = messageId;
    else delete this.config.editingPrompts[chatId];
    await this.save();
  }

  getEditingPrompt(chatId: string): string | undefined { return this.config.editingPrompts?.[chatId]; }

  async setPendingState(chatId: string, messageId: string,
    state: NonNullable<PendingPrompt['state']>, taskId?: string): Promise<void> {
    const pending = this.getPendingPrompt(chatId, messageId);
    if (!pending) throw new Error('Pending prompt is unavailable');
    pending.state = state;
    pending.idempotencyKey ||= `telegram:${chatId}:${messageId}`;
    if (taskId) pending.taskId = taskId;
    await this.save();
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
    delete this.config.pairingChallenge;
    this.config.chatIds = [];
    this.config.sessionMap = {};
    this.config.pendingPrompts = {};
    this.config.resultMap = {};
    this.config.selectedSessions = {};
    this.config.editingPrompts = {};
    await this.save();
  }

  async beginPairing(expectedSenderId?: string): Promise<{ code: string; expiresAt: number }> {
    const { code, challenge } = createPairingChallenge({ expectedSenderId });
    this.config.pairingChallenge = challenge;
    await this.save();
    return { code, expiresAt: challenge.expiresAt };
  }

  async consumePairing(message: PairingMessage): Promise<boolean> {
    const challenge = this.config.pairingChallenge;
    if (!challenge) return false;
    const chatId = consumePairingChallenge(challenge, message);
    if (!chatId) return false;
    const alreadyAllowed = this.config.chatIds.includes(chatId);
    if (!alreadyAllowed) this.config.chatIds.push(chatId);
    try {
      await this.save();
      return true;
    } catch (error) {
      if (!alreadyAllowed) this.config.chatIds = this.config.chatIds.filter(id => id !== chatId);
      throw error;
    }
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
    this.config.pendingPrompts[telegramMessageKey(chatId, messageId)] = { ...pending, state: 'pending', idempotencyKey: `telegram:${chatId}:${messageId}` };
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
    if (this.config.editingPrompts?.[chatId] === messageId) delete this.config.editingPrompts[chatId];
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
