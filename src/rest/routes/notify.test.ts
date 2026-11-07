import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestServer } from '../server.js';
import { SessionManager } from '../../daemon/session-manager.js';
import { HookEngine, type HookExecutionResult } from '../../hooks/engine.js';
import { createEvent } from '../../hooks/events.js';
import { NotificationInbox } from '../../notifications/inbox.js';
import type { ClaudeBTelegramBot } from '../../telegram/bot.js';

describe('external notifications', () => {
  let dir: string;
  let server: RestServer;
  let engine: HookEngine;
  let inbox: NotificationInbox;
  const transcript = vi.fn();
  const context = vi.fn();
  const session = vi.fn();
  const broadcast = vi.fn();

  beforeEach(async () => {
    vi.clearAllMocks();
    broadcast.mockResolvedValue(undefined);
    dir = await mkdtemp(join(tmpdir(), 'cb-notify-'));
    engine = new HookEngine(dir);
    await engine.load();
    inbox = new NotificationInbox(dir);
  });

  afterEach(async () => {
    await server?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function initialize(online?: boolean) {
    server = new RestServer({
      host: '127.0.0.1', port: 0, configDir: dir,
      sessionManager: new SessionManager(dir), hookEngine: engine,
      notificationInbox: inbox, onTmuxTranscript: transcript, onTmuxSession: session, onTmuxContext: context,
      telegramBot: online === undefined ? undefined : {
        isRunning: () => online,
        broadcastNotification: broadcast,
      } as unknown as ClaudeBTelegramBot,
    });
    await server.initialize();
  }

  async function notify(payload: Record<string, unknown>, key?: string, ip = '127.0.0.1', flush = true) {
    const response = await server.getApp().inject({
      method: 'POST', url: '/api/notify', payload,
      remoteAddress: ip,
      headers: { 'x-claude-b-key': key ?? server.getAuthManager().getApiKey()! },
    });
    if (flush) await server.getNotificationOutbox().drain();
    return response;
  }

  it.each([undefined, false, true])('dispatches and persists when Telegram running=%s', async online => {
    await initialize(online);
    const response = await notify({ sessionId: 'tmux:1.0', resultPreview: 'done', agent: 'codex', transcriptPath: '/fixture/transcript', goal: 'goal', sessionName: 'pane', durationMs: 40, costUsd: 0.01 });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    const [event] = engine.getEventHistory();
    expect(engine.getEventHistory()).toHaveLength(1);
    expect(event).toMatchObject({ type: 'prompt.completed', id: expect.any(String), payload: { sessionId: 'tmux:1.0', status: 'success', output: 'done', agent: 'codex', sessionName: 'pane', durationMs: 40 } });
    expect((await inbox.getAll())[0]).toMatchObject({ type: 'prompt.completed', resultFull: 'done', exitCode: 0 });
    expect(transcript).toHaveBeenCalledWith('tmux:1.0', '/fixture/transcript');
    expect(session).toHaveBeenCalledWith('tmux:1.0', 'pane', 'codex', 'goal');
    expect(broadcast).toHaveBeenCalledTimes(online ? 1 : 0);
  });

  it('dispatches errors with a failure exit code', async () => {
    await initialize(false);
    expect((await notify({ sessionId: 'external', type: 'prompt.error', resultPreview: 'failed' })).statusCode).toBe(200);
    expect(engine.getEventHistory()[0]).toMatchObject({ type: 'prompt.error', payload: { error: 'failed', exitCode: 1 } });
    expect((await inbox.getAll())[0].exitCode).toBe(1);
  });

  it('delivers an offline notification to the matching webhook once', async () => {
    await initialize(false);
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { secret: 'fixture-secret', sessionFilter: 'external' });
    await engine.addWebhook('prompt.error', 'https://wrong.invalid');
    const receiver = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    try {
      expect((await notify({ sessionId: 'external', resultPreview: 'result' })).statusCode).toBe(200);
      await vi.waitFor(() => expect(receiver).toHaveBeenCalledTimes(1));
      const [url, options] = receiver.mock.calls[0];
      expect(url).toBe('https://receiver.invalid');
      expect(JSON.parse(options!.body as string)).toMatchObject({ event: 'prompt.completed', output: 'result', eventId: engine.getEventHistory()[0].id });
      expect(new Headers(options!.headers).get('x-claude-b-signature')).toMatch(/^sha256=[a-f0-9]{64}$/);
    } finally {
      receiver.mockRestore();
    }
  });

  it('isolates Telegram and callback failures from hooks and inbox', async () => {
    await initialize(true);
    broadcast.mockRejectedValueOnce(new Error('offline'));
    transcript.mockImplementationOnce(() => { throw new Error('callback failure'); });
    session.mockImplementationOnce(() => { throw new Error('callback failure'); });
    expect((await notify({ sessionId: 'tmux:1.0', agent: 'codex', transcriptPath: '/fixture' })).statusCode).toBe(200);
    expect(engine.getEventHistory()).toHaveLength(1);
    expect(await inbox.getAll()).toHaveLength(1);
  });

  it('persists and delivers Telegram even if hook dispatch fails', async () => {
    await initialize(true);
    vi.spyOn(engine, 'dispatch').mockRejectedValueOnce(new Error('hook failure'));
    expect((await notify({ sessionId: 'external' })).statusCode).toBe(200);
    expect(await inbox.getAll()).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])('accepts authenticated loopback %s', async ip => {
    await initialize();
    expect((await notify({ sessionId: 'external' }, undefined, ip)).statusCode).toBe(200);
  });

  it('rejects remote, unauthenticated and malformed requests without dispatch', async () => {
    await initialize();
    expect((await notify({ sessionId: 'external' }, undefined, '192.0.2.1')).statusCode).toBe(403);
    expect((await notify({ sessionId: 'external' }, 'wrong')).statusCode).toBe(401);
    expect((await server.getApp().inject({ method: 'POST', url: '/api/notify', payload: { sessionId: 'external' } })).statusCode).toBe(401);
    expect((await notify({ sessionId: '' })).statusCode).toBe(400);
    expect((await notify({ sessionId: 'external', type: 'invalid' })).statusCode).toBe(400);
    expect(engine.getEventHistory()).toHaveLength(0);
    expect(await inbox.getAll()).toHaveLength(0);
  });
  it('acknowledges durable ingestion while hooks are stalled, including a second notification', async () => {
    await initialize();
    let release!: (result: HookExecutionResult) => void;
    const stalled = new Promise<HookExecutionResult>(resolve => { release = resolve; });
    const dispatch = vi.spyOn(engine, 'dispatch').mockImplementationOnce(() => stalled);
    const first = await notify({ sessionId: 'external', eventId: 'first-stalled' }, undefined, '127.0.0.1', false);
    expect(first.statusCode).toBe(200);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
    const second = await notify({ sessionId: 'external', eventId: 'second-stalled' }, undefined, '127.0.0.1', false);
    expect(second.statusCode).toBe(200);
    expect(await inbox.getAll()).toHaveLength(2);
    release({ event: createEvent('prompt.completed', { sessionId: 'external', promptId: 'first', status: 'success' }), shellResults: [], webhookResults: [] });
    await server.getNotificationOutbox().drain(true);
  });

  it('retains a durable event after inbox storage failure and deduplicates an explicit retry', async () => {
    await initialize();
    vi.spyOn(inbox, 'addNotification').mockRejectedValueOnce(new Error('storage unavailable'));
    const payload = { sessionId: 'external', eventId: 'inbox-retry', resultPreview: 'exact' };
    expect((await notify(payload, undefined, '127.0.0.1', false)).statusCode).toBe(503);
    expect(await server.getNotificationOutbox().list()).toHaveLength(1);
    expect((await notify(payload)).statusCode).toBe(200);
    expect(await server.getNotificationOutbox().list()).toHaveLength(1);
    expect(await inbox.getAll()).toHaveLength(1);
  });

  it('retries failed webhook subscribers with the same signed event metadata', async () => {
    await initialize();
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { retries: 1, secret: 'test-secret' });
    const receiver = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => new Response('busy', { status: 503 }))
      .mockImplementation(async () => new Response('ok'));
    try {
      expect((await notify({ sessionId: 'external', eventId: 'signed-retry', resultPreview: 'done' })).statusCode).toBe(200);
      const before = (await server.getNotificationOutbox().list())[0];
      expect(before.delivered).toContain('inbox');
      expect(before.delivered).not.toContain('hooks');
      await server.getNotificationOutbox().drain(true);
      expect(receiver).toHaveBeenCalledTimes(2);
      expect(receiver.mock.calls[0][1]?.body).toBe(receiver.mock.calls[1][1]?.body);
      expect(new Headers(receiver.mock.calls[0][1]?.headers).get('x-claude-b-signature'))
        .toBe(new Headers(receiver.mock.calls[1][1]?.headers).get('x-claude-b-signature'));
      expect(new Set(engine.getEventHistory().map(event => event.id)).size).toBe(1);
      expect(await inbox.getAll()).toHaveLength(1);
    } finally { receiver.mockRestore(); }
  });

  it('rejects conflicting stable event IDs and negative duration/cost fields', async () => {
    await initialize();
    expect((await notify({ sessionId: 'external', eventId: 'conflict', resultPreview: 'first' })).statusCode).toBe(200);
    expect((await notify({ sessionId: 'external', eventId: 'conflict', resultPreview: 'changed' })).statusCode).toBe(409);
    expect((await notify({ sessionId: 'external', durationMs: -1 })).statusCode).toBe(400);
    expect((await notify({ sessionId: 'external', costUsd: -1 })).statusCode).toBe(400);
    expect(await inbox.getAll()).toHaveLength(1);
  });

  it('normalizes recorded tmux identity before transcript caching and durable delivery', async () => {
    await initialize();
    session.mockResolvedValueOnce('tmux:%42@1234');
    expect((await notify({ sessionId: 'tmux:project:1.0', transcriptPath: '/fixture/transcript', resultPreview: 'done' })).statusCode).toBe(200);
    expect(session).toHaveBeenCalledWith('tmux:project:1.0', undefined, 'claude', undefined);
    expect(transcript).toHaveBeenCalledWith('tmux:%42@1234', '/fixture/transcript');
    expect((await inbox.getAll())[0].sessionId).toBe('tmux:%42@1234');
    expect(engine.getEventHistory()[0].payload).toMatchObject({ sessionId: 'tmux:%42@1234' });
  });

  it('accepts bounded visible context only after authentication and pane identity normalization', async () => {
    await initialize();
    session.mockResolvedValueOnce('tmux:%42@1234');
    const turns = [{ role: 'user', text: 'Question' }, { role: 'assistant', text: 'Answer' }];
    expect((await notify({ sessionId: 'tmux:project:1.0', agent: 'opencode', contextTurns: turns })).statusCode).toBe(200);
    expect(context).toHaveBeenCalledWith('tmux:%42@1234', turns);
    context.mockClear();
    expect((await notify({ sessionId: 'tmux:project:1.0', contextTurns: turns }, 'wrong')).statusCode).toBe(401);
    expect(context).not.toHaveBeenCalled();
    for (const contextTurns of [Array.from({ length: 7 }, () => turns[0]), [{ role: 'tool', text: 'hidden' }], [{ role: 'assistant', text: 'x'.repeat(601) }]]) {
      expect((await notify({ sessionId: 'tmux:project:1.0', contextTurns })).statusCode).toBe(400);
    }
    expect(context).not.toHaveBeenCalled();
  });

  it('deadletters a terminal HTTP 400 subscriber without retrying it through the outer outbox', async () => {
    await initialize();
    await engine.addWebhook('prompt.completed', 'https://reject.invalid', { retries: 0 });
    const receiver = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('bad payload', { status: 400 }));
    try {
      expect((await notify({ sessionId: 'external', eventId: 'permanent-rejection' })).statusCode).toBe(200);
      await server.getNotificationOutbox().drain(true);
      expect(receiver).toHaveBeenCalledOnce();
      expect((await server.getNotificationOutbox().list())[0]).toMatchObject({ failed: ['hooks'] });
      expect(await inbox.getAll()).toHaveLength(1);
    } finally { receiver.mockRestore(); }
  });

});
