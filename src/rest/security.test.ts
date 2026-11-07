import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { RestServer } from './server.js';
import { SessionManager } from '../daemon/session-manager.js';

describe('REST credential boundaries', () => {
  let dir: string;
  let server: RestServer;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-security-'));
    server = new RestServer({ host: '127.0.0.1', port: 0, configDir: dir, sessionManager: new SessionManager(dir) });
    await server.initialize();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function tokens() {
    const response = await server.getApp().inject({ method: 'POST', url: '/api/auth/token', payload: { api_key: server.getAuthManager().getApiKey() } });
    expect(response.statusCode).toBe(200);
    return response.json() as { access_token: string; refresh_token: string };
  }

  it('rejects refresh tokens at access-protected routes', async () => {
    const { refresh_token } = await tokens();
    const response = await server.getApp().inject({ method: 'GET', url: '/api/sessions', headers: { authorization: `Bearer ${refresh_token}` } });
    expect(response.statusCode).toBe(401);
  });

  it('requires existing credentials even on loopback and rejects remote credential access', async () => {
    const app = server.getApp();
    for (const method of ['GET', 'POST'] as const) {
      const url = method === 'GET' ? '/api/auth/key' : '/api/auth/key/regenerate';
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect((await app.inject({ method, url, remoteAddress: '203.0.113.10', headers: { 'x-claude-b-key': server.getAuthManager().getApiKey()! } })).statusCode).toBe(403);
    }
    const { access_token, refresh_token } = await tokens();
    expect((await app.inject({ method: 'GET', url: '/api/auth/key', headers: { authorization: `Bearer ${access_token}` } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/auth/key', headers: { authorization: `Bearer ${refresh_token}` } })).statusCode).toBe(401);
  });

  it('revokes access and refresh tokens immediately after authenticated rotation', async () => {
    const { access_token, refresh_token } = await tokens();
    const headers = { authorization: `Bearer ${access_token}` };
    const rotated = await server.getApp().inject({ method: 'POST', url: '/api/auth/key/regenerate', headers });
    expect(rotated.statusCode).toBe(200);
    expect((await server.getApp().inject({ method: 'GET', url: '/api/sessions', headers })).statusCode).toBe(401);
    expect((await server.getApp().inject({ method: 'POST', url: '/api/auth/refresh', payload: { refresh_token } })).statusCode).toBe(401);
    expect((await server.getApp().inject({ method: 'GET', url: '/api/auth/key', headers: { 'x-claude-b-key': rotated.json().api_key } })).statusCode).toBe(200);
    const next = await tokens();
    expect((await server.getApp().inject({ method: 'GET', url: '/api/sessions', headers: { authorization: `Bearer ${next.access_token}` } })).statusCode).toBe(200);
  });

  it('does not reflect arbitrary browser origins', async () => {
    const response = await server.getApp().inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://untrusted.example' } });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
  it('allows only exact configured origins without ambient credentials', async () => {
    await server.stop();
    server = new RestServer({ host: '127.0.0.1', port: 0, configDir: dir,
      sessionManager: new SessionManager(dir), allowedOrigins: ['https://dashboard.example'] });
    await server.initialize();
    const app = server.getApp();
    for (const origin of ['https://dashboard.example.evil', 'http://dashboard.example', 'null', 'https://other.example']) {
      const result = await app.inject({ method: 'GET', url: '/api/health', headers: { origin } });
      expect(result.headers['access-control-allow-origin']).toBeUndefined();
    }
    const allowed = await app.inject({ method: 'OPTIONS', url: '/api/sessions', headers: {
      origin: 'https://dashboard.example', 'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization'
    } });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://dashboard.example');
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    const protectedRoute = await app.inject({ method: 'GET', url: '/api/sessions', headers: { origin: 'https://dashboard.example' } });
    expect(protectedRoute.statusCode).toBe(401);
  });

  it.each(['*', 'null', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test/'])
  ('rejects non-origin allowlist entries without echoing their contents', origin => {
    expect(() => new RestServer({ host: '127.0.0.1', port: 0, configDir: dir,
      sessionManager: new SessionManager(dir), allowedOrigins: [origin] }))
      .toThrow('Allowed browser origins must be exact HTTP(S) origins');
  });

});
