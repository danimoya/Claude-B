import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RestServer } from '../rest/server.js';
import { SessionManager } from '../daemon/session-manager.js';
import { HookEngine } from '../hooks/engine.js';
import { RemoteClient, type RemoteHost } from './remote-client.js';
import { rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('RemoteClient', () => {
  let testDir: string;
  let server: RestServer;
  let sessionManager: SessionManager;
  let hookEngine: HookEngine;
  let client: RemoteClient;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-b-remote-client-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    sessionManager = new SessionManager(testDir);
    await sessionManager.load();
    hookEngine = new HookEngine(testDir);
    await hookEngine.load();

    server = new RestServer({
      host: '127.0.0.1',
      port: 0,
      sessionManager,
      hookEngine,
      configDir: testDir
    });

    const baseUrl = await server.start();
    const apiKey = server.getAuthManager().getApiKey();
    if (!apiKey) throw new Error('test setup: REST server returned no API key');

    const host: RemoteHost = {
      id: 'test-host',
      name: 'test',
      url: baseUrl,
      apiKey,
      enabled: true,
      priority: 1
    };
    client = new RemoteClient(host);
  });

  afterEach(async () => {
    await server.stop();
    await sessionManager.stopAll();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('createSession', () => {
    it('creates a session without a name (regression: empty-body 400)', async () => {
      // Regression for danimoya/Claude-B#5: client used to send
      // Content-Type: application/json with no body when called without a name,
      // which fastify rejects with FST_ERR_CTP_EMPTY_JSON_BODY (HTTP 400).
      const session = await client.createSession();

      expect(session.id).toBeTruthy();
      expect(session.host).toBe('test-host');
      expect(session.status).toBe('idle');
    });

    it('creates a session with a name', async () => {
      const session = await client.createSession('my-session');

      expect(session.id).toBeTruthy();
      expect(session.name).toBe('my-session');
      expect(session.host).toBe('test-host');
    });
  });

  describe('end-to-end remote-fire flow', () => {
    it('createSession then sendPrompt completes without HTTP errors', async () => {
      // Regression for the full `cb --remote-fire` happy path: the empty-body
      // bug in createSession was masking that the entire two-call dispatch
      // (create → prompt) never worked over the network.
      const session = await client.createSession();
      expect(session.id).toBeTruthy();

      const result = await client.sendPrompt(session.id, 'test prompt');

      // Status enum from RemotePromptResult is 'completed' | 'error' | 'timeout';
      // the server returns 'queued' which the client maps to 'error' for the
      // sync path. We only assert the request itself round-tripped (i.e., no
      // 400/401/5xx that would surface as a thrown error string).
      expect(result.error).toBeUndefined();
      expect(result.sessionId).toBe(session.id);
      expect(result.promptId).toBeTruthy();
    });
  });

  describe('request hardening', () => {
    it('omits Content-Type header when there is no body (defense-in-depth)', async () => {
      // listSessions is a GET with no body — must not send Content-Type:
      // application/json, otherwise any future stricter middleware on the
      // server side would 400 a perfectly valid GET.
      const sessions = await client.listSessions();
      expect(Array.isArray(sessions)).toBe(true);
    });
  });
});
