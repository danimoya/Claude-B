import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../daemon/session-manager.js';
import { registerSessionRoutes } from './sessions.js';

describe('session WebSocket terminal errors', () => {
  it('sends error events and removes all subscriptions on disconnect', async () => {
    let stream!: (socket: unknown, request: unknown) => void;
    const app = {
      authenticate: vi.fn(),
      get: (path: string, _options: unknown, handler: typeof stream) => { if (path.endsWith('/stream')) stream = handler; },
      post: vi.fn(), delete: vi.fn(),
    };
    const session = Object.assign(new EventEmitter(), { status: 'busy', getLastOutput: () => '' });
    await registerSessionRoutes(app as unknown as FastifyInstance, { get: () => session } as unknown as SessionManager);
    const socket = Object.assign(new EventEmitter(), { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() });
    stream(socket, { params: { id: 'session' } });
    session.emit('prompt.error', { promptId: 'failed', code: 0, error: 'provider failure' });
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'prompt.error', promptId: 'failed', exitCode: 0, error: 'provider failure' }));
    session.emit('prompt.completed', { promptId: 'next', code: 0 });
    expect(socket.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'prompt.completed', promptId: 'next', exitCode: 0 }));
    socket.emit('close');
    for (const event of ['output', 'prompt.completed', 'prompt.error']) expect(session.listenerCount(event)).toBe(0);
  });
});
