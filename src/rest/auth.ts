import { readFile, writeFile, mkdir, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';

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
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });

    if (existsSync(this.apiKeyPath)) {
      try {
        await chmod(this.apiKeyPath, 0o600);
        this.apiKey = (await readFile(this.apiKeyPath, 'utf-8')).trim() || null;
      } catch {
        // Will generate new key
      }
    }
  }

  async generateApiKey(): Promise<string> {
    this.apiKey = 'cb_' + randomBytes(32).toString('hex');
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await writeFile(this.apiKeyPath, this.apiKey, { mode: 0o600 });
    // writeFile's mode only applies when creating a file.
    await chmod(this.apiKeyPath, 0o600);
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

  validateApiKey(key: unknown): boolean {
    if (!this.apiKey || typeof key !== 'string') return false;
    const expected = Buffer.from(this.apiKey);
    const provided = Buffer.from(key);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
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

  validateTokenPayload(payload: unknown, expectedType: 'access' | 'refresh'): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (!this.apiKey || !payload || typeof payload !== 'object') return false;
    const claims = payload as Partial<TokenPayload>;
    if (claims.type !== expectedType) return false;
    if (typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > now) return false;
    if (typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp <= claims.iat) return false;
    if (claims.sub !== this.hashApiKey()) return false;

    return true;
  }
}
