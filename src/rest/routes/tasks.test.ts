import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../../daemon/session-manager.js';
import { HookEngine } from '../../hooks/engine.js';
import { NotificationInbox } from '../../notifications/inbox.js';
import { NotificationOutbox } from '../../notifications/outbox.js';
import { createDeliveryOutbox } from '../../notifications/delivery.js';
import { RestServer } from '../server.js';
import type { ClaudeBTelegramBot } from '../../telegram/bot.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../utils/claude-detector.js', () => ({ getClaudePath: () => 'fixture-agent' }));
function fakeChild() {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn() });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null)); return true; });
  return child;
}

describe('durable REST task acceptance and delivery', () => {
  let dir: string;
  let manager: SessionManager;
  let server: RestServer;
  let hooks: HookEngine;
  let inbox: NotificationInbox;
  let outbox: NotificationOutbox;
  let children: ReturnType<typeof fakeChild>[];
  let headers: { authorization: string };
  let online: boolean;
  let telegram: ClaudeBTelegramBot;
  const broadcast = vi.fn().mockResolvedValue(undefined);

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'cb-rest-tasks-'));
    children = [];
    vi.mocked(spawn).mockImplementation((() => { const child = fakeChild(); children.push(child); return child; }) as unknown as typeof spawn);
    manager = new SessionManager(dir);
    await manager.load();
    hooks = new HookEngine(dir); await hooks.load();
    inbox = new NotificationInbox(dir);
    online = true;
    telegram = { getConfig: () => ({ enabled: true, chatIds: ['123'] }), isRunning: () => online, broadcastNotification: broadcast } as unknown as ClaudeBTelegramBot;
    await initialize();
  });
  afterEach(async () => {
    await server.stop();
    await manager.stopAll();
    await outbox.stop();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function initialize() {
    outbox = createDeliveryOutbox(dir, { inbox, hooks, telegram });
    server = new RestServer({ host: '127.0.0.1', port: 0, configDir: dir,
      sessionManager: manager, hookEngine: hooks, notificationInbox: inbox, notificationOutbox: outbox, telegramBot: telegram });
    await server.initialize();
    headers = { authorization: `Bearer ${server.getApp().jwt.sign(server.getAuthManager().createAccessTokenPayload())}` };
  }
  const post = (payload: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => server.getApp().inject({ method: 'POST', url: '/api/tasks', headers: { ...headers, ...extraHeaders }, payload });
  async function complete(index: number, output = 'done', code: number | null = 0) {
    await vi.waitFor(() => expect(children.length).toBeGreaterThan(index));
    children[index].stdout.write(JSON.stringify({ result: output, is_error: code !== 0 }));
    children[index].emit('close', code);
  }
  async function terminal(id: string) {
    await vi.waitFor(async () => expect((await manager.getTask(id))?.completedAt).toBeDefined());
    await vi.waitFor(async () => expect((await outbox.list()).some(record => record.notification.promptId === id)).toBe(true));
  }

  it('returns durable accepted receipts, queues independent prompts and delivers terminal results once', async () => {
    const session = await manager.create('fixture', undefined, undefined, false, dir);
    const first = await post({ sessionId: session.id, prompt: 'first', idempotencyKey: 'first-key' });
    expect(first.statusCode).toBe(202);
    const receipt = first.json();
    expect(receipt).toMatchObject({ taskId: expect.any(String), promptId: receipt.taskId, sessionId: session.id, status: 'accepted' });
    expect(await manager.getTask(receipt.taskId)).toMatchObject({ prompt: 'first', output: '' });
    const second = await server.getApp().inject({ method: 'POST', url: `/api/sessions/${session.id}/prompt`, headers: { ...headers, 'idempotency-key': 'second-key' }, payload: { prompt: 'second' } });
    expect(second.statusCode).toBe(202);
    expect(second.json().taskId).not.toBe(receipt.taskId);
    await complete(0, 'first result'); await terminal(receipt.taskId);
    await complete(1, 'second result'); await terminal(second.json().taskId);
    await outbox.drain(true);
    expect((await inbox.getAll()).map(record => record.resultFull)).toEqual(['first result', 'second result']);
    expect(hooks.getEventsByType('prompt.completed')).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledTimes(2);
    await outbox.enqueue((await outbox.list())[0].notification);
    await outbox.drain(true);
    expect(await inbox.getAll()).toHaveLength(2);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('reuses the canonical receipt without creating sessions or rerunning work and rejects conflicts', async () => {
    const first = await post({ prompt: 'exact', workingDir: dir }, { 'idempotency-key': 'request-key' });
    expect(first.statusCode).toBe(202);
    const id = first.json().taskId;
    const again = await post({ prompt: 'exact', workingDir: dir, idempotencyKey: 'request-key' });
    expect(again.statusCode).toBe(202);
    expect(again.json().taskId).toBe(id);
    expect(again.json().sessionId).toBe(first.json().sessionId);
    expect(manager.count()).toBe(1);
    expect((await post({ prompt: 'changed', idempotencyKey: 'request-key' })).statusCode).toBe(409);
    expect((await post({ prompt: 'exact', idempotencyKey: 'different' }, { 'idempotency-key': 'header' })).statusCode).toBe(409);
    expect((await post({ prompt: '   ' })).statusCode).toBe(400);
    expect((await post({ prompt: 'invalid', taskId: '../bad-path' })).statusCode).toBe(400);
    await complete(0); await terminal(id);
    expect(children).toHaveLength(1);
  });

  it('supports queued/active cancellation with durable error delivery and exact result lookup after session cleanup', async () => {
    const session = await manager.create('fixture', undefined, undefined, false, dir);
    const active = (await post({ sessionId: session.id, prompt: 'active' })).json().taskId;
    await vi.waitFor(() => expect(children).toHaveLength(1));
    const queued = (await post({ sessionId: session.id, prompt: 'queued' })).json().taskId;
    for (const id of [queued, active]) {
      const result = await server.getApp().inject({ method: 'POST', url: `/api/tasks/${id}/cancel`, headers });
      expect(result.statusCode).toBe(200);
      expect(result.json().task.status).toBe('cancelled');
      await terminal(id);
    }
    expect(children).toHaveLength(1);
    await outbox.drain(true);
    expect(hooks.getEventsByType('prompt.error')).toHaveLength(2);
    expect((await inbox.getAll()).every(value => value.type === 'prompt.error')).toBe(true);
    await manager.kill(session.id);
    expect((await server.getApp().inject({ method: 'GET', url: `/api/tasks/${active}`, headers })).json().task.status).toBe('cancelled');
  });

  it('returns the complete stored result rather than notification preview limits', async () => {
    const accepted = await post({ prompt: 'large output', workingDir: dir });
    const id = accepted.json().taskId;
    const exact = 'x'.repeat(72000);
    await complete(0, exact); await terminal(id);
    await manager.kill(accepted.json().sessionId);
    const result = await server.getApp().inject({ method: 'GET', url: `/api/tasks/${id}`, headers });
    expect(result.json().task.output).toBe(exact);
    const listed = await server.getApp().inject({ method: 'GET', url: '/api/tasks', headers });
    expect(listed.json().tasks.map((task: { id: string }) => task.id)).toContain(id);
  });

  it('reconciles interrupted work and pending notification channels after restart without replay', async () => {
    online = false;
    const accepted = await post({ prompt: 'interrupted', workingDir: dir });
    const id = accepted.json().taskId;
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await server.stop();
    await outbox.stop();
    manager = new SessionManager(dir);
    await manager.load();
    await initialize();
    const task = await manager.getTask(id);
    expect(task?.status).toBe('interrupted');
    expect(children).toHaveLength(1);
    await outbox.drain(true);
    expect((await outbox.list())[0].delivered).toEqual(['inbox', 'hooks']);
    expect(broadcast).not.toHaveBeenCalled();
    const stableEventId = hooks.getEventHistory()[0].id;
    online = true;
    await outbox.drain(true);
    expect(broadcast).toHaveBeenCalledOnce();
    expect(hooks.getEventHistory()).toHaveLength(1);
    expect(hooks.getEventHistory()[0].id).toBe(stableEventId);
    expect(await inbox.getAll()).toHaveLength(1);
  });

  it('requires authentication for submission, lookup, listing and cancellation', async () => {
    for (const [method, url] of [['POST', '/api/tasks'], ['GET', '/api/tasks'], ['GET', '/api/tasks/fixture-task'], ['POST', '/api/tasks/fixture-task/cancel']] as const) {
      const result = await server.getApp().inject({ method, url, ...(method === 'POST' && url === '/api/tasks' ? { payload: { prompt: 'forbidden' } } : {}) });
      expect(result.statusCode).toBe(401);
    }
    expect(children).toHaveLength(0);
  });
  it('rejects a concurrent explicit target mismatch after global idempotency lookup wins', async () => {
    const first = await manager.create('first', undefined, undefined, false, dir);
    const second = await manager.create('second', undefined, undefined, false, dir);
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    for (const session of [first, second]) {
      const accept = session.taskStore.accept.bind(session.taskStore);
      vi.spyOn(session.taskStore, 'accept').mockImplementation(async input => {
        arrived++;
        if (arrived === 2) release();
        await gate;
        return accept(input);
      });
    }
    const responses = await Promise.all([first, second].map(session => post({
      sessionId: session.id, prompt: 'one canonical task', idempotencyKey: 'concurrent-owner-key'
    })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([202, 409]);
    const accepted = responses.find(response => response.statusCode === 202)!.json();
    await complete(0); await terminal(accepted.taskId);
    expect(children).toHaveLength(1);
    expect(await manager.listTasks()).toHaveLength(1);
  });

});
