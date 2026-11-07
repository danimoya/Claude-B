import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookEngine } from '../../hooks/engine.js';
import { registerHookRoutes } from './hooks.js';

describe('webhook signing configuration', () => {
  let app: FastifyInstance;
  let engine: HookEngine;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-b-webhook-routes-'));
    engine = new HookEngine(dir);
    await engine.load();
    app = Fastify();
    app.decorate('authenticate', async () => {});
    await registerHookRoutes(app, engine);
  });

  afterEach(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts a per-webhook secret through REST and retains it across engine reloads', async () => {
    const result = await app.inject({
      method: 'POST', url: '/api/hooks/webhook', payload: {
        event: 'prompt.completed', url: 'https://receiver.invalid/hooks',
        secret: 'test-only-secret', retries: 0
      }
    });
    expect(result.statusCode).toBe(200);
    const saved = JSON.parse(await readFile(join(dir, 'hooks.json'), 'utf8'));
    expect(saved.webhooks[0]).toMatchObject({ secret: 'test-only-secret', retries: 0 });
    const restored = new HookEngine(dir);
    await restored.load();
    expect(restored.listWebhooks()[0].secret).toBe('test-only-secret');
  });

  it.each([-1, 6, 1.5])('rejects retries outside the bounded integer range: %s', async retries => {
    const result = await app.inject({
      method: 'POST', url: '/api/hooks/webhook', payload: {
        event: 'prompt.completed', url: 'https://receiver.invalid/hooks', retries
      }
    });
    expect(result.statusCode).toBe(400);
    expect(engine.listWebhooks()).toHaveLength(0);
  });
});
