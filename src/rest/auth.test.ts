import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { AuthManager } from './auth.js';

describe('AuthManager credentials and token claims', () => {
  let dir: string;
  let auth: AuthManager;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-auth-'));
    auth = new AuthManager(dir);
    await auth.ensureApiKey();
  });

  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('requires complete, finite, current claims of the expected type', () => {
    const valid = auth.createAccessTokenPayload();
    expect(auth.validateTokenPayload(valid, 'access')).toBe(true);
    for (const payload of [null, {}, { ...valid, type: 'refresh' }, { ...valid, sub: 'other' },
      { ...valid, exp: undefined }, { ...valid, exp: NaN }, { ...valid, exp: Infinity },
      { ...valid, exp: String(valid.exp) }, { ...valid, iat: undefined },
      { ...valid, iat: valid.exp + 1 }, { ...valid, exp: Math.floor(Date.now() / 1000) }]) {
      expect(auth.validateTokenPayload(payload, 'access')).toBe(false);
    }
  });

  it('invalidates both token types after API key rotation', async () => {
    const access = auth.createAccessTokenPayload();
    const refresh = auth.createRefreshTokenPayload();
    await auth.generateApiKey();
    expect(auth.validateTokenPayload(access, 'access')).toBe(false);
    expect(auth.validateTokenPayload(refresh, 'refresh')).toBe(false);
    expect(auth.validateTokenPayload(auth.createAccessTokenPayload(), 'access')).toBe(true);
  });

  it('protects an existing credential file on load and rotation', async () => {
    const path = join(dir, 'api.key');
    await writeFile(path, 'test-key');
    const { chmod } = await import('fs/promises');
    await chmod(path, 0o644);
    await auth.load();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await chmod(path, 0o644);
    await auth.generateApiKey();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('does not accept missing, malformed, or empty API keys', () => {
    for (const value of [undefined, null, [], {}, '', 'wrong']) expect(auth.validateApiKey(value)).toBe(false);
    expect(auth.validateApiKey(auth.getApiKey())).toBe(true);
  });
});
