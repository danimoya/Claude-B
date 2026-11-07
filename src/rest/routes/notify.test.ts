import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RestServer } from '../server.js';
import { SessionManager } from '../../daemon/session-manager.js';
import { HookEngine } from '../../hooks/engine.js';
import { NotificationInbox } from '../../notifications/inbox.js';
import type { ClaudeBTelegramBot } from '../../telegram/bot.js';

describe('external notifications', () => {
  let dir: string;
  let server: RestServer;
  let engine: HookEngine;
  let inbox: NotificationInbox;
  const transcript = vi.fn();
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
      notificationInbox: inbox, onTmuxTranscript: transcript, onTmuxSession: session,
      telegramBot: online === undefined ? undefined : {
        isRunning: () => online,
        broadcastNotification: broadcast,
      } as unknown as ClaudeBTelegramBot,
    });
    await server.initialize();
  }

  function notify(payload: Record<string, unknown>, key?: string, ip = '127.0.0.1') {
    return server.getApp().inject({
      method: 'POST', url: '/api/notify', payload,
      remoteAddress: ip,
      headers: { 'x-claude-b-key': key ?? server.getAuthManager().getApiKey()! },
    });
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
});
