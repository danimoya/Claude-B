import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes, createHash } from 'crypto';

export interface TokenPayload {
  type: 'access' | 'refresh';
  sub: string;  // subject (API key hash)
  iat: number;  // issued at
  exp: number;  // expiration
}

export interface AuthConfig {
  apiKey: string;
  accessTokenExpiry: number;  // seconds
  refreshTokenExpiry: number; // seconds
}

const DEFAULT_ACCESS_EXPIRY = 3600;      // 1 hour
const DEFAULT_REFRESH_EXPIRY = 604800;   // 7 days

export class AuthManager {
  private configDir: string;
  private apiKeyPath: string;
  private apiKey: string | null = null;

  constructor(configDir: string) {
    this.configDir = configDir;
    this.apiKeyPath = `${configDir}/api.key`;
  }

  async load(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });

    if (existsSync(this.apiKeyPath)) {
      try {
        this.apiKey = (await readFile(this.apiKeyPath, 'utf-8')).trim();
      } catch {
        // Will generate new key
      }
    }
  }

  async generateApiKey(): Promise<string> {
    this.apiKey = 'cb_' + randomBytes(32).toString('hex');
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.apiKeyPath, this.apiKey, { mode: 0o600 });
    return this.apiKey;
  }

  getApiKey(): string | null {
    return this.apiKey;
  }

  async ensureApiKey(): Promise<string> {
    if (!this.apiKey) {
      return await this.generateApiKey();
    }
    return this.apiKey;
  }

  validateApiKey(key: string): boolean {
    return this.apiKey !== null && key === this.apiKey;
  }

  hashApiKey(): string {
    if (!this.apiKey) throw new Error('No API key configured');
    return createHash('sha256').update(this.apiKey).digest('hex').slice(0, 16);
  }

  createAccessTokenPayload(): TokenPayload {
    const now = Math.floor(Date.now() / 1000);
    return {
      type: 'access',
      sub: this.hashApiKey(),
      iat: now,
      exp: now + DEFAULT_ACCESS_EXPIRY
    };
  }

  createRefreshTokenPayload(): TokenPayload {
    const now = Math.floor(Date.now() / 1000);
    return {
      type: 'refresh',
      sub: this.hashApiKey(),
      iat: now,
      exp: now + DEFAULT_REFRESH_EXPIRY
    };
  }

  validateTokenPayload(payload: TokenPayload, expectedType: 'access' | 'refresh'): boolean {
    const now = Math.floor(Date.now() / 1000);

    if (payload.type !== expectedType) return false;
    if (payload.exp < now) return false;
    if (payload.sub !== this.hashApiKey()) return false;

    return true;
  }
}
