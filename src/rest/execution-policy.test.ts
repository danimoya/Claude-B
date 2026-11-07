import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestServer } from './server.js';
import { SessionManager } from '../daemon/session-manager.js';

describe('explicit REST execution policy', () => {
  let dir: string; let server: RestServer; let manager: SessionManager; let headers: Record<string, string>;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-rest-policy-'));
    manager = new SessionManager(dir); await manager.load();
    server = new RestServer({ host: '127.0.0.1', port: 0, configDir: dir, sessionManager: manager });
    await server.initialize();
    const token = await server.getApp().inject({ method: 'POST', url: '/api/auth/token', payload: { api_key: server.getAuthManager().getApiKey() } });
    headers = { authorization: `Bearer ${token.json().access_token}` };
  });
  afterEach(async () => { await server.stop(); await manager.stopAll(); await rm(dir, { recursive: true, force: true }); });
  it('defaults new sessions to permissions and persists an explicit opt-in', async () => {
    const created = await server.getApp().inject({ method: 'POST', url: '/api/sessions', headers, payload: {} });
    expect(created.json().executionPolicy).toBe('default');
    const id = created.json().id;
    const updated = await server.getApp().inject({ method: 'POST', url: `/api/sessions/${id}/policy`, headers, payload: { executionPolicy: 'bypass' } });
    expect(updated.json()).toEqual({ sessionId: id, executionPolicy: 'bypass' });
    const restored = new SessionManager(dir); await restored.load();
    expect(restored.get(id)?.executionPolicy).toBe('bypass');
  });
  it('requires auth, validates policies, and refuses in-flight changes', async () => {
    const session = await manager.create();
    const url = `/api/sessions/${session.id}/policy`;
    expect((await server.getApp().inject({ method: 'POST', url, payload: { executionPolicy: 'bypass' } })).statusCode).toBe(401);
    expect((await server.getApp().inject({ method: 'POST', url, headers, payload: { executionPolicy: 'anything' } })).statusCode).toBe(400);
    session.status = 'busy';
    expect((await server.getApp().inject({ method: 'POST', url, headers, payload: { executionPolicy: 'bypass' } })).statusCode).toBe(409);
    session.status = 'idle';
    expect(session.executionPolicy).toBe('default');
  });
});
