import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RestServer } from './server.js';
import { SessionManager } from '../daemon/session-manager.js';
import { HookEngine } from '../hooks/engine.js';
import { rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RestServer', () => {
  let testDir: string;
  let server: RestServer;
  let sessionManager: SessionManager;
  let hookEngine: HookEngine;
  let baseUrl: string;
  let token: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-b-rest-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    sessionManager = new SessionManager(testDir);
    await sessionManager.load();

    hookEngine = new HookEngine(testDir);
    await hookEngine.load();

    server = new RestServer({
      host: '127.0.0.1',
      port: 0, // Random available port
      sessionManager,
      hookEngine,
      configDir: testDir
    });

    const address = await server.start();
    baseUrl = address;

    // Get API key and authenticate
    const apiKey = server.getAuthManager().getApiKey();
    const authResponse = await fetch(`${baseUrl}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: apiKey })
    });
    const authData = await authResponse.json() as { access_token: string };
    token = authData.access_token;
  });

  afterEach(async () => {
    await server.stop();
    await sessionManager.stopAll();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Health', () => {
    it('should return health status', async () => {
      const response = await fetch(`${baseUrl}/api/health`);
      const data = await response.json() as { status: string; sessions: number };

      expect(response.status).toBe(200);
      expect(data.status).toBe('ok');
      expect(data.sessions).toBe(0);
    });
  });

  describe('Authentication', () => {
    it('should reject requests without token', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`);

      expect(response.status).toBe(401);
    });

    it('should accept requests with valid token', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      expect(response.status).toBe(200);
    });

    it('should reject invalid tokens', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        headers: { 'Authorization': 'Bearer invalid-token' }
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Sessions', () => {
    it('should list sessions', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json() as { sessions: unknown[]; count: number };

      expect(response.status).toBe(200);
      expect(data.sessions).toEqual([]);
      expect(data.count).toBe(0);
    });

    it('should create a session', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'test-session' })
      });
      const data = await response.json() as { id: string; name: string };

      expect(response.status).toBe(200);
      expect(data.id).toBeDefined();
      expect(data.name).toBe('test-session');
    });

    it('should create a session with model', async () => {
      const response = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'model-session', model: 'opus' })
      });
      const data = await response.json() as { model: string };

      expect(response.status).toBe(200);
      expect(data.model).toBe('opus');
    });

    it('should get a session by id', async () => {
      // Create session first
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'get-test' })
      });
      const created = await createRes.json() as { id: string };

      // Get session
      const response = await fetch(`${baseUrl}/api/sessions/${created.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json() as { id: string; name: string };

      expect(response.status).toBe(200);
      expect(data.id).toBe(created.id);
      expect(data.name).toBe('get-test');
    });

    it('should delete a session', async () => {
      // Create session
      const createRes = await fetch(`${baseUrl}/api/sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name: 'delete-test' })
      });
      const created = await createRes.json() as { id: string };

      // Delete session
      const response = await fetch(`${baseUrl}/api/sessions/${created.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      expect(response.status).toBe(200);

      // Verify deleted
      const getRes = await fetch(`${baseUrl}/api/sessions/${created.id}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      expect(getRes.status).toBe(404);
    });
  });

  describe('Shell Hooks', () => {
    it('should list shell hooks', async () => {
      const response = await fetch(`${baseUrl}/api/hooks/shell`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json() as { hooks: unknown[] };

      expect(response.status).toBe(200);
      expect(data.hooks).toEqual([]);
    });

    it('should add a shell hook', async () => {
      const response = await fetch(`${baseUrl}/api/hooks/shell`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: 'session.created',
          command: 'echo "test"'
        })
      });
      const data = await response.json() as { hook: { id: string; event: string; command: string } };

      expect(response.status).toBe(200);
      expect(data.hook.id).toBeDefined();
      expect(data.hook.event).toBe('session.created');
      expect(data.hook.command).toBe('echo "test"');
    });

    it('should delete a shell hook', async () => {
      // Create hook
      const createRes = await fetch(`${baseUrl}/api/hooks/shell`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ event: 'session.created', command: 'echo test' })
      });
      const created = await createRes.json() as { hook: { id: string } };

      // Delete hook
      const response = await fetch(`${baseUrl}/api/hooks/shell/${created.hook.id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      });

      expect(response.status).toBe(200);
    });
  });

  describe('Webhooks', () => {
    it('should list webhooks', async () => {
      const response = await fetch(`${baseUrl}/api/hooks/webhook`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json() as { webhooks: unknown[] };

      expect(response.status).toBe(200);
      expect(data.webhooks).toEqual([]);
    });

    it('should add a webhook', async () => {
      const response = await fetch(`${baseUrl}/api/hooks/webhook`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: 'prompt.completed',
          url: 'https://example.com/webhook'
        })
      });
      const data = await response.json() as { webhook: { id: string; url: string } };

      expect(response.status).toBe(200);
      expect(data.webhook.id).toBeDefined();
      expect(data.webhook.url).toBe('https://example.com/webhook');
    });

    it('should add a webhook with session filter', async () => {
      const response = await fetch(`${baseUrl}/api/hooks/webhook`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          event: 'session.created',
          url: 'https://example.com/webhook',
          sessionFilter: 'my-session'
        })
      });
      const data = await response.json() as { webhook: { sessionFilter: string } };

      expect(response.status).toBe(200);
      expect(data.webhook.sessionFilter).toBe('my-session');
    });
  });
});
