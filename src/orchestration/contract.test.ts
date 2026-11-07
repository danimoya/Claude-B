import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { RemoteClientManager, type RemoteHost } from './remote-client.js';
import { RemoteReceiptStore, RemoteRequestError } from './receipts.js';
import { OrchestrationManager } from './manager.js';
import { FailoverHandler, RetryHandler } from './failover.js';
import { PipelineExecutor } from './pipeline.js';
import type { TaskRecord } from '../jobs/types.js';

const token = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600 };
function json(response: ServerResponse, body: unknown, status = 200) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); }
async function body(request: IncomingMessage) { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text) as { taskId: string; idempotencyKey: string; prompt: string }; }
function task(id: string, status: TaskRecord['status'] = 'completed'): TaskRecord {
  const now = new Date().toISOString();
  return { id, taskId: id, promptId: id, sessionId: 'session-test', prompt: 'work', status, workingDir: '/fixture', executionPolicy: 'default', createdAt: now, updatedAt: now,
    startedAt: now, completedAt: ['pending', 'running'].includes(status) ? undefined : now,
    output: status === 'completed' ? 'exact result\n' : 'partial', rawOutput: '{}',
    error: ['error', 'cancelled', 'interrupted'].includes(status) ? 'execution stopped' : undefined };
}

describe('durable remote submission/completion contract', () => {
  let dir: string;
  const servers: Server[] = [];
  const managers: OrchestrationManager[] = [];
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cb-remote-contract-')); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
    await Promise.all(servers.splice(0).map(async (server) => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }));
    await rm(dir, { recursive: true, force: true });
  });

  async function host(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, id = 'host-test'): Promise<RemoteHost> {
    const server = createServer((request, response) => { void handler(request, response); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
    return { id, name: id, url: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-secret', enabled: true, priority: 1 };
  }

  async function orchestration(hosts: RemoteHost[]) {
    await writeFile(join(dir, 'orchestration.json'), JSON.stringify({ hosts, healthCheck: { enabled: false, interval: 10000, timeout: 100 }, circuitBreaker: { enabled: false, failureThreshold: 5, timeout: 1000 }, failover: { maxAttempts: 2, retry: { maxRetries: 0, initialDelay: 1, maxDelay: 1, backoffMultiplier: 1, jitter: false } } }));
    const manager = new OrchestrationManager(dir);
    managers.push(manager);
    await manager.load();
    return manager;
  }

  it('persists caller IDs before POST, polls queued work, and returns the exact terminal result', async () => {
    let id = '';
    let polls = 0;
    let submissions = 0;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      if (request.method === 'POST') {
        const data = await body(request); id = data.taskId; submissions++;
        const receipts = await new RemoteReceiptStore(dir).list();
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ taskId: id, idempotencyKey: 'request-key', status: 'submitting' });
        return json(response, { taskId: id, promptId: id, sessionId: 'session-test', status: 'queued' }, 202);
      }
      polls++;
      return json(response, { task: task(id, polls < 2 ? 'running' : 'completed') });
    });
    const manager = new RemoteClientManager(dir);
    const client = manager.addHost(remote);
    const result = await client.sendPrompt('session-test', 'work', { timeout: 1000, idempotencyKey: 'request-key', pollInterval: 5 });
    expect(result).toMatchObject({ status: 'completed', output: 'exact result\n', taskId: id, promptId: id, retrySafe: false });
    expect(submissions).toBe(1);
    expect(polls).toBe(2);
    expect(await manager.getRemoteTask(result.receiptId!)).toMatchObject({ status: 'completed', output: 'exact result\n' });
    expect((await client.sendPrompt('session-test', 'work', { idempotencyKey: 'request-key' })).taskId).toBe(id);
    expect(submissions).toBe(1);
  });

  it('keeps a response-loss receipt and resumes after restart using GET without another submission', async () => {
    let id = '';
    let submissions = 0;
    const paths: string[] = [];
    const remote = await host(async (request, response) => {
      paths.push(`${request.method} ${request.url}`);
      if (request.url === '/api/auth/token') return json(response, token);
      if (request.method === 'POST') { id = (await body(request)).taskId; submissions++; response.destroy(); return; }
      return json(response, { task: task(id) });
    });
    const first = new RemoteClientManager(dir);
    const uncertain = await first.addHost(remote).sendPrompt('session-test', 'work', { timeout: 500 });
    expect(uncertain).toMatchObject({ status: 'uncertain', failureKind: 'uncertain', retrySafe: false, taskId: id });
    expect(await new RemoteReceiptStore(dir).get(uncertain.receiptId!)).toMatchObject({ status: 'uncertain', taskId: id });
    const restarted = new RemoteClientManager(dir);
    restarted.addHost(remote);
    const complete = await restarted.resumeRemoteTask(uncertain.receiptId!, { timeout: 500 });
    expect(complete).toMatchObject({ status: 'completed', taskId: id, output: 'exact result\n' });
    expect(submissions).toBe(1);
    expect(paths.filter((path) => path.startsWith('GET'))).toEqual([`GET /api/tasks/${id}`]);
  });

  it('uses the original absolute deadline for accepted polling and preserves its receipt', async () => {
    let id = '';
    let submissions = 0;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      if (request.method === 'POST') { id = (await body(request)).taskId; submissions++; return json(response, { status: 'accepted', taskId: id }, 202); }
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{');
    });
    const manager = new RemoteClientManager(dir);
    const start = Date.now();
    const result = await manager.addHost(remote).sendPrompt('session-test', 'work', { timeout: 100 });
    expect(Date.now() - start).toBeLessThan(500);
    expect(result).toMatchObject({ status: 'accepted', taskId: id, retrySafe: false, error: 'Remote request timed out after 100ms' });
    expect(submissions).toBe(1);
  });

  it('does not fail over after lost submission responses or authentication rejection', async () => {
    let submissions = 0;
    let otherRequests = 0;
    let rejectAuth = false;
    const first = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, rejectAuth ? { error: 'fixture-secret credential body' } : token, rejectAuth ? 401 : 200);
      submissions++; response.destroy();
    }, 'first-host');
    const second = await host((_request, response) => { otherRequests++; json(response, token); }, 'second-host');
    const manager = await orchestration([first, second]);
    const result = await manager.sendPrompt('work', { sessionId: 'session-test', timeout: 300 });
    expect(result.status).toBe('uncertain');
    expect(submissions).toBe(1);
    expect(otherRequests).toBe(0);
    rejectAuth = true;
    const authManager = new RemoteClientManager(dir);
    const auth = await authManager.addHost({ ...first, id: 'auth-host' }).sendPrompt('session-test', 'work');
    expect(auth).toMatchObject({ status: 'error', failureKind: 'auth', retrySafe: false });
    expect(auth.error).toBe('Authentication failed: 401');
    expect(JSON.stringify(await authManager.listRemoteTasks())).not.toContain('fixture-secret');
  });

  it('bounds authentication during session creation by the caller deadline', async () => {
    const remote = await host(() => {});
    const manager = await orchestration([remote]);
    const start = Date.now();
    await expect(manager.sendPrompt('work', { timeout: 100 })).rejects.toThrow('Remote request timed out after 100ms');
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('immediately removes disabled hosts from routing and restores eligibility when enabled', async () => {
    let requests = 0;
    const remote = await host((_request, response) => { requests++; json(response, token); });
    const manager = await orchestration([remote]);
    expect(await manager.toggleHost(remote.id, false)).toBe(true);
    await expect(manager.sendPrompt('work', { sessionId: 'session-test', timeout: 100 })).rejects.toThrow('No eligible');
    expect(requests).toBe(0);
    expect(manager.listHosts()[0].enabled).toBe(false);
    expect(await manager.toggleHost(remote.id, true)).toBe(true);
    expect(manager.listHosts()[0].enabled).toBe(true);
  });

  it('retries only explicitly safe failures and never unclassified exceptions', async () => {
    const retry = new RetryHandler({ maxRetries: 2, initialDelay: 0, maxDelay: 0, jitter: false });
    const ambiguous = vi.fn(async () => { throw new Error('network timeout after maybe accepting'); });
    await expect(retry.execute(ambiguous)).rejects.toThrow('maybe accepting');
    expect(ambiguous).toHaveBeenCalledOnce();
    const clients = new RemoteClientManager();
    const remote = await host((_request, response) => json(response, token));
    clients.addHost(remote); clients.addHost({ ...remote, id: 'other-host' });
    const failover = new FailoverHandler(clients, { retry: { maxRetries: 0, initialDelay: 0, maxDelay: 0, backoffMultiplier: 1, jitter: false } });
    const safe = vi.fn(async () => { if (safe.mock.calls.length === 1) throw new RemoteRequestError('connection refused before submission', 'unavailable', true); return 'done'; });
    expect((await failover.executeWithFailover(safe)).result).toBe('done');
    expect(safe).toHaveBeenCalledTimes(2);
  });

  it('refuses malformed remote receipts without replacing the original evidence', async () => {
    const store = new RemoteReceiptStore(dir);
    const { receipt } = await store.prepare({ taskId: 'fixture-task-id', hostId: 'host-test', sessionId: 'session-test', prompt: 'work', idempotencyKey: 'request' });
    const path = join(dir, 'remote-tasks', `${receipt.id}.json`);
    const bytes = JSON.stringify({ id: receipt.id, receiptId: receipt.id, status: 'prepared' });
    await writeFile(path, bytes);
    await expect(new RemoteReceiptStore(dir).get(receipt.id)).rejects.toThrow('preserved');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('claims concurrent identical submissions once, retaining the same durable task and receipt IDs', async () => {
    let submissions = 0;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      const data = await body(request);
      submissions++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      json(response, { status: 'accepted', taskId: data.taskId }, 202);
    });
    const client = new RemoteClientManager(dir).addHost(remote);
    const results = await Promise.all(Array.from({ length: 6 }, () => client.sendPrompt('session-test', 'work', { idempotencyKey: 'same-key', waitForCompletion: false, timeout: 1000 })));
    expect(submissions).toBe(1);
    expect(new Set(results.map((result) => result.taskId)).size).toBe(1);
    expect(new Set(results.map((result) => result.receiptId)).size).toBe(1);
    expect(results.every((result) => ['accepted', 'uncertain'].includes(result.status))).toBe(true);
    expect((await new RemoteReceiptStore(dir).list())[0].status).toBe('accepted');
  });

  it('preserves terminal receipts against stale resume failures and hides malformed response bytes', async () => {
    const store = new RemoteReceiptStore(dir);
    const { receipt } = await store.prepare({ taskId: 'fixture-task-id', hostId: 'host-test', sessionId: 'session-test', prompt: 'work', idempotencyKey: 'key' });
    await store.claimSubmission(receipt.id);
    await store.update(receipt.id, { status: 'completed', taskStatus: 'completed', output: 'exact' });
    const completed = await store.update(receipt.id, { status: 'uncertain', error: 'stale poll timeout' });
    expect(completed).toMatchObject({ status: 'completed', output: 'exact' });
    expect(completed.error).toBeUndefined();
    const remote = await host((_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('new-secret-not-configured is not JSON'); });
    const result = await new RemoteClientManager(dir).addHost(remote).sendPrompt('session-test', 'different work');
    expect(result).toMatchObject({ status: 'error', failureKind: 'auth', error: 'Invalid authentication response' });
    expect(JSON.stringify(result)).not.toContain('new-secret-not-configured');
  });

  it('preserves corrupt orchestration configuration even if cleanup calls shutdown/save', async () => {
    const path = join(dir, 'orchestration.json');
    const bytes = '{"hosts": [broken original config';
    await writeFile(path, bytes);
    const manager = new OrchestrationManager(dir);
    await expect(manager.load()).rejects.toThrow('preserved');
    await expect(manager.save()).rejects.toThrow('preserved');
    await expect(manager.shutdown()).rejects.toThrow('preserved');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });

  it('aborts active polling on shutdown, retains acceptance, and resumes with GET from a fresh manager', async () => {
    let id = '';
    let submits = 0;
    let polls = 0;
    let complete = false;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      if (request.method === 'POST') { id = (await body(request)).taskId; submits++; return json(response, { status: 'accepted', taskId: id }, 202); }
      polls++;
      if (complete) return json(response, { task: task(id) });
      response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{');
    });
    const manager = await orchestration([remote]);
    const pending = manager.sendPrompt('work', { sessionId: 'session-test', timeout: 5000 });
    await vi.waitFor(() => expect(polls).toBe(1));
    const start = Date.now();
    await manager.shutdown();
    const result = await pending;
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result).toMatchObject({ status: 'accepted', taskId: id, retrySafe: false });
    await expect(manager.sendPrompt('late')).rejects.toThrow('closed');
    await expect(manager.sendPromptBalanced('late')).rejects.toThrow('closed');
    await expect(manager.resumeRemoteTask(result.receiptId!)).rejects.toThrow('closed');
    complete = true;
    const fresh = new OrchestrationManager(dir); managers.push(fresh); await fresh.load();
    expect(await fresh.resumeRemoteTask(result.receiptId!, { timeout: 500 })).toMatchObject({ status: 'completed', output: 'exact result\n', taskId: id });
    expect(submits).toBe(1);
  });

  it('does not replay an uncertain pipeline task even when retries are configured', async () => {
    let submits = 0;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      await body(request); submits++; response.destroy();
    });
    const clients = new RemoteClientManager(dir); clients.addHost(remote);
    const pipeline = new PipelineExecutor(clients);
    const result = await pipeline.execute({ id: 'pipeline', name: 'safe retry', onError: 'retry', maxRetries: 4,
      steps: [{ id: 'one', name: 'work', type: 'prompt', sessionId: 'session-test', prompt: 'work', timeout: 300, retries: 4 }] });
    expect(submits).toBe(1);
    expect(result.status).toBe('error');
    expect(result.steps[0]).toMatchObject({ remoteStatus: 'uncertain', receiptId: expect.any(String), taskId: expect.any(String), error: expect.stringContaining('resume receipt') });
    clients.close();
  });

  it('shares the balanced operation deadline with session creation and authentication', async () => {
    const remote = await host(() => {});
    const manager = await orchestration([remote]);
    const started = Date.now();
    await expect(manager.sendPromptBalanced('work', { timeout: 100 })).rejects.toThrow('Remote request timed out after 100ms');
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('keeps never-dispatched receipts prepared after GET-only recovery and permits explicit same-ID submission', async () => {
    let submits = 0;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      if (request.method === 'GET') return json(response, { error: 'not found' }, 404);
      const data = await body(request); submits++; return json(response, { status: 'accepted', taskId: data.taskId }, 202);
    });
    const store = new RemoteReceiptStore(dir);
    const { receipt } = await store.prepare({ taskId: 'fixture-task-id', hostId: remote.id, sessionId: 'session-test', prompt: 'work', idempotencyKey: 'prepared-request' });
    const manager = new RemoteClientManager(dir);
    const client = manager.addHost(remote);
    expect(await manager.resumeRemoteTask(receipt.id, { timeout: 500 })).toMatchObject({ receiptId: receipt.id, taskId: receipt.taskId, failureKind: 'unavailable' });
    expect(submits).toBe(0);
    expect((await new RemoteReceiptStore(dir).get(receipt.id))?.status).toBe('prepared');
    expect(await client.sendPrompt('session-test', 'work', { taskId: receipt.taskId, idempotencyKey: receipt.idempotencyKey, waitForCompletion: false })).toMatchObject({ status: 'accepted', receiptId: receipt.id, taskId: receipt.taskId });
    expect(submits).toBe(1);
    manager.close();
  });

  it('performs one status GET when completion waiting is disabled', async () => {
    let id = '';
    let polls = 0;
    let submits = 0;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      if (request.method === 'POST') { id = (await body(request)).taskId; submits++; return json(response, { status: 'accepted', taskId: id }, 202); }
      polls++; return json(response, { task: task(id, 'running') });
    });
    const manager = new RemoteClientManager(dir);
    const accepted = await manager.addHost(remote).sendPrompt('session-test', 'work', { waitForCompletion: false });
    const started = Date.now();
    expect(await manager.resumeRemoteTask(accepted.receiptId!, { timeout: 5000, waitForCompletion: false })).toMatchObject({ status: 'accepted', taskId: id, taskStatus: 'running' });
    expect(Date.now() - started).toBeLessThan(500);
    expect(polls).toBe(1); expect(submits).toBe(1);
    manager.close();
  });

  it('binds cross-entry idempotency replays to canonical task, host and explicit session targets', async () => {
    let id = '';
    let submits = 0;
    const remote = await host(async (request, response) => {
      if (request.url === '/api/auth/token') return json(response, token);
      if (request.method === 'POST') { id = (await body(request)).taskId; submits++; return json(response, { status: 'accepted', taskId: id }, 202); }
      return json(response, { task: task(id) });
    });
    const manager = await orchestration([remote, { ...remote, id: 'other-host', name: 'other' }]);
    const accepted = await manager.sendPrompt('work', { hostId: remote.id, sessionId: 'session-test', idempotencyKey: 'canonical-key', waitForCompletion: false });
    for (const changes of [{ taskId: 'different-task-id' }, { sessionId: 'other-session' }, { hostId: 'other-host' }, { hostId: 'unknown-host' }]) {
      await expect(manager.sendPrompt('work', { idempotencyKey: 'canonical-key', waitForCompletion: false, ...changes })).rejects.toThrow('already used');
    }
    const reused = await manager.sendPrompt('work', { taskId: accepted.taskId, waitForCompletion: false, timeout: 500 });
    expect(reused).toMatchObject({ taskId: id, receiptId: accepted.receiptId, status: 'completed' });
    expect(submits).toBe(1);
  });
});
