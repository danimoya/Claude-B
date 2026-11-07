import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../../daemon/session-manager.js';
import { OrchestrationManager } from '../../orchestration/manager.js';
import type { RemoteHost } from '../../orchestration/remote-client.js';
import type { TaskRecord } from '../../jobs/types.js';
import { RestServer } from '../server.js';

const authTokens = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 };
function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(data));
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = '';
  for await (const chunk of request) bytes += chunk;
  return JSON.parse(bytes) as Record<string, unknown>;
}
function completedTask(id: string): TaskRecord {
  const now = new Date().toISOString();
  return { id, taskId: id, promptId: id, sessionId: 'fixture-session', prompt: 'work\nliteral',
    workingDir: '/fixture', executionPolicy: 'default', status: 'completed',
    createdAt: now, updatedAt: now, startedAt: now, completedAt: now,
    output: 'exact terminal output\n', rawOutput: '{"result":"exact"}' };
}

describe('authenticated orchestration REST task receipts', () => {
  let dir: string;
  let sessions: SessionManager;
  let orchestration: OrchestrationManager;
  let api: RestServer;
  let headers: { authorization: string };
  const peers: Server[] = [];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-rest-remote-'));
    sessions = new SessionManager(dir);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await api?.stop();
    await orchestration?.shutdown();
    await sessions.stopAll();
    await Promise.all(peers.splice(0).map(async server => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }));
    await rm(dir, { recursive: true, force: true });
  });

  async function peer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<RemoteHost> {
    const server = createServer((request, response) => { void handler(request, response); });
    peers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
    return { id: 'fixture-host', name: 'loopback', url: `http://127.0.0.1:${address.port}`,
      apiKey: 'fixture-remote-key', enabled: true, priority: 1 };
  }
  async function initialize(hosts?: RemoteHost[]) {
    if (hosts) { await writeFile(join(dir, 'orchestration.json'), JSON.stringify({ hosts,
      healthCheck: { enabled: false, interval: 10000, timeout: 100 },
      circuitBreaker: { enabled: false, failureThreshold: 5, timeout: 1000 },
      failover: { maxAttempts: 1, retry: { maxRetries: 0, initialDelay: 1, maxDelay: 1, backoffMultiplier: 1, jitter: false } }
    })); }
    orchestration = new OrchestrationManager(dir); await orchestration.load();
    api = new RestServer({ host: '127.0.0.1', port: 0, configDir: dir, sessionManager: sessions,
      orchestrationManager: orchestration });
    await api.initialize();
    // Exercise the real authentication endpoint rather than bypassing its claims.
    const token = await api.getApp().inject({ method: 'POST', url: '/api/auth/token',
      payload: { api_key: await api.getAuthManager().ensureApiKey() } });
    expect(token.statusCode).toBe(200);
    headers = { authorization: `Bearer ${token.json().access_token}` };
  }
  const post = (payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => api.getApp().inject({
    method: 'POST', url: '/api/orchestration/prompt', headers: { ...headers, ...extraHeaders }, payload
  });

  it('requires access authentication for submission, saved receipt reads and resume', async () => {
    await initialize([]);
    const send = vi.spyOn(orchestration, 'sendPrompt');
    const list = vi.spyOn(orchestration, 'listRemoteTasks');
    const get = vi.spyOn(orchestration, 'getRemoteTask');
    for (const request of [
      { method: 'POST' as const, url: '/api/orchestration/prompt', payload: { prompt: 'work' } },
      { method: 'GET' as const, url: '/api/orchestration/tasks' },
      { method: 'GET' as const, url: '/api/orchestration/tasks/fixture-receipt' },
      { method: 'POST' as const, url: '/api/orchestration/tasks/fixture-receipt/resume', payload: {} }
    ]) expect((await api.getApp().inject(request)).statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled(); expect(list).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });

  it('forwards durable IDs and no-wait mode, exposes receipts and rejects conflicting retries without another POST', async () => {
    const submissions: Record<string, unknown>[] = [];
    let polls = 0;
    const remote = await peer(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, authTokens);
      if (request.method === 'POST') {
        submissions.push(await readBody(request));
        return json(response, { status: 'accepted', taskId: submissions[0].taskId, sessionId: 'fixture-session' }, 202);
      }
      polls++; return json(response, { task: completedTask(String(submissions[0].taskId)) });
    });
    await initialize([remote]);
    const payload = { prompt: 'work\nliteral', hostId: remote.id, sessionId: 'fixture-session',
      taskId: 'fixture-task-001', waitForCompletion: false, timeout: 500 };
    const first = await post(payload, { 'idempotency-key': 'fixture-request-key' });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: 'accepted', taskId: payload.taskId, receiptId: expect.any(String) });
    expect(submissions).toEqual([{ prompt: payload.prompt, taskId: payload.taskId, idempotencyKey: 'fixture-request-key' }]);
    expect(polls).toBe(0);
    const id = first.json().receiptId;
    const listed = await api.getApp().inject({ method: 'GET', url: '/api/orchestration/tasks', headers });
    expect(listed.json().tasks).toHaveLength(1);
    const saved = await api.getApp().inject({ method: 'GET', url: `/api/orchestration/tasks/${id}`, headers });
    expect(saved.json().task).toMatchObject({ id, taskId: payload.taskId, prompt: payload.prompt,
      idempotencyKey: 'fixture-request-key', status: 'accepted' });
    for (const changes of [{ prompt: 'different' }, { sessionId: 'other-session' }, { taskId: 'different-task-id' }]) {
      expect((await post({ ...payload, ...changes, idempotencyKey: 'fixture-request-key' })).statusCode).toBe(409);
    }
    expect((await post({ ...payload, idempotencyKey: 'body-key' }, { 'idempotency-key': 'header-key' })).statusCode).toBe(409);
    expect(submissions).toHaveLength(1);
    expect(JSON.stringify([first.json(), saved.json(), listed.json()])).not.toContain(remote.apiKey);
    const completed = await api.getApp().inject({ method: 'POST', url: `/api/orchestration/tasks/${id}/resume`, headers,
      payload: { timeout: 500, waitForCompletion: true } });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ status: 'completed', taskId: payload.taskId, output: 'exact terminal output\n' });
    expect(polls).toBe(1); expect(submissions).toHaveLength(1);
  });

  it('retains response-loss uncertainty across restart and resumes with GET only', async () => {
    let id = '';
    let posts = 0;
    const methods: string[] = [];
    const remote = await peer(async (request, response) => {
      methods.push(`${request.method} ${request.url}`);
      if (request.url === '/api/auth/token') return json(response, authTokens);
      if (request.method === 'POST') { id = String((await readBody(request)).taskId); posts++; response.destroy(); return; }
      return json(response, { task: completedTask(id) });
    });
    await initialize([remote]);
    const first = await post({ prompt: 'work\nliteral', sessionId: 'fixture-session', timeout: 500, waitForCompletion: false });
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: 'uncertain', retrySafe: false, taskId: id });
    const receiptId = first.json().receiptId;
    await api.stop(); await orchestration.shutdown();
    await initialize();
    const restored = await api.getApp().inject({ method: 'GET', url: `/api/orchestration/tasks/${receiptId}`, headers });
    expect(restored.json().task.status).toBe('uncertain');
    const complete = await api.getApp().inject({ method: 'POST', url: `/api/orchestration/tasks/${receiptId}/resume`, headers });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ taskId: id, status: 'completed', output: 'exact terminal output\n' });
    expect(posts).toBe(1);
    expect(methods.filter(method => method.startsWith('GET'))).toEqual([`GET /api/tasks/${id}`]);
  });

  it('validates bounded budgets and identities before any network operation', async () => {
    await initialize([]);
    const send = vi.spyOn(orchestration, 'sendPrompt');
    for (const payload of [
      { prompt: '   ' }, { prompt: 'work', timeout: 0 }, { prompt: 'work', timeout: -1 },
      { prompt: 'work', timeout: 300001 }, { prompt: 'work', timeout: 1.5 },
      { prompt: 'work', taskId: '../bad-path' }, { prompt: 'work', idempotencyKey: 'x'.repeat(257) }
    ]) expect((await post(payload)).statusCode).toBe(400);
    expect((await post({ prompt: 'work', hostId: 'missing-host' })).statusCode).toBe(404);
    expect((await api.getApp().inject({ method: 'GET', url: '/api/orchestration/tasks/missing-receipt', headers })).statusCode).toBe(404);
    expect((await api.getApp().inject({ method: 'GET', url: '/api/orchestration/tasks/bad', headers })).statusCode).toBe(400);
    expect((await api.getApp().inject({ method: 'POST', url: '/api/orchestration/tasks/missing-receipt/resume', headers, payload: {} })).statusCode).toBe(404);
    expect(send).not.toHaveBeenCalled();
  });

  it('bounds stalled authentication and never echoes credential-bearing errors or invalid URLs', async () => {
    const remote = await peer(() => {});
    await initialize([remote]);
    const start = Date.now();
    const timed = await post({ prompt: 'work', timeout: 50 });
    expect(Date.now() - start).toBeLessThan(500);
    expect(timed.statusCode).toBe(503);
    const secret = 'never-echo-test-secret';
    vi.spyOn(orchestration, 'sendPrompt').mockRejectedValueOnce(new Error(`https://owner:${secret}@fixture/?token=${secret}`));
    const failed = await post({ prompt: 'work', sessionId: 'fixture-session' });
    expect(failed.statusCode).toBe(503);
    expect(failed.body).not.toContain(secret);
    const invalidHost = await api.getApp().inject({ method: 'POST', url: '/api/orchestration/hosts', headers,
      payload: { url: `https://owner:${secret}@fixture/`, apiKey: secret } });
    expect(invalidHost.statusCode).toBe(400);
    expect(invalidHost.body).not.toContain(secret);
  });

  it('keeps orphan-host receipts inspectable and returns a conflict instead of attempting resume', async () => {
    const remote = await peer(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, authTokens);
      const payload = await readBody(request);
      return json(response, { status: 'accepted', taskId: payload.taskId }, 202);
    });
    await initialize([remote]);
    const first = await post({ prompt: 'work', sessionId: 'fixture-session', waitForCompletion: false });
    const id = first.json().receiptId;
    expect(await orchestration.removeHost(remote.id)).toBe(true);
    expect((await api.getApp().inject({ method: 'GET', url: `/api/orchestration/tasks/${id}`, headers })).statusCode).toBe(200);
    const resume = vi.spyOn(orchestration, 'resumeRemoteTask');
    expect((await api.getApp().inject({ method: 'POST', url: `/api/orchestration/tasks/${id}/resume`, headers, payload: {} })).statusCode).toBe(409);
    expect(resume).not.toHaveBeenCalled();
  });

  it('reports remote authentication rejection without echoing the remote credential body', async () => {
    let submissions = 0;
    const secret = 'unconfigured-response-secret';
    const remote = await peer((request, response) => {
      if (request.url === '/api/auth/token') return json(response, { error: `credential=${secret}` }, 401);
      submissions++; return json(response, {}, 500);
    });
    await initialize([remote]);
    const failed = await post({ prompt: 'work', sessionId: 'fixture-session', waitForCompletion: false, timeout: 100 });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({ status: 'error', failureKind: 'auth', retrySafe: false });
    expect(failed.body).not.toContain(secret);
    expect(failed.body).not.toContain(remote.apiKey);
    expect(submissions).toBe(0);
  });
});
