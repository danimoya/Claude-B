import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HookEngine } from './engine.js';
import { rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('HookEngine', () => {
  let testDir: string;
  let engine: HookEngine;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-b-hooks-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    engine = new HookEngine(testDir);
    await engine.load();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('Shell Hooks', () => {
    it('should add a shell hook', async () => {
      const hook = await engine.addShellHook('session.created', 'echo "Hello"');

      expect(hook.id).toBeDefined();
      expect(hook.event).toBe('session.created');
      expect(hook.command).toBe('echo "Hello"');
      expect(hook.enabled).toBe(true);
    });

    it('should add a shell hook with options', async () => {
      const hook = await engine.addShellHook('prompt.completed', 'notify-send', {
        timeout: 5000,
        sessionFilter: 'test-session'
      });

      expect(hook.timeout).toBe(5000);
      expect(hook.sessionFilter).toBe('test-session');
    });

    it('should list shell hooks', async () => {
      await engine.addShellHook('session.created', 'echo 1');
      await engine.addShellHook('session.destroyed', 'echo 2');

      const hooks = engine.listShellHooks();

      expect(hooks.length).toBe(2);
    });

    it('should get shell hook by id', async () => {
      const hook = await engine.addShellHook('session.created', 'echo test');

      expect(engine.getShellHook(hook.id)).toEqual(hook);
    });

    it('should remove shell hook', async () => {
      const hook = await engine.addShellHook('session.created', 'echo test');

      const deleted = await engine.removeShellHook(hook.id);

      expect(deleted).toBe(true);
      expect(engine.getShellHook(hook.id)).toBeUndefined();
    });

    it('should toggle shell hook', async () => {
      const hook = await engine.addShellHook('session.created', 'echo test');
      expect(hook.enabled).toBe(true);

      const disabled = await engine.toggleShellHook(hook.id, false);
      expect(disabled?.enabled).toBe(false);

      const enabled = await engine.toggleShellHook(hook.id, true);
      expect(enabled?.enabled).toBe(true);
    });
  });

  describe('Webhooks', () => {
    it('should add a webhook', async () => {
      const webhook = await engine.addWebhook('session.created', 'https://example.com/hook');

      expect(webhook.id).toBeDefined();
      expect(webhook.event).toBe('session.created');
      expect(webhook.url).toBe('https://example.com/hook');
      expect(webhook.enabled).toBe(true);
    });

    it('should add a webhook with options', async () => {
      const webhook = await engine.addWebhook('prompt.completed', 'https://example.com/hook', {
        method: 'PUT',
        headers: { 'X-Custom': 'value' },
        timeout: 10000,
        retries: 3,
        sessionFilter: 'my-session'
      });

      expect(webhook.method).toBe('PUT');
      expect(webhook.headers).toEqual({ 'X-Custom': 'value' });
      expect(webhook.timeout).toBe(10000);
      expect(webhook.retries).toBe(3);
      expect(webhook.sessionFilter).toBe('my-session');
    });

    it('should list webhooks', async () => {
      await engine.addWebhook('session.created', 'https://example.com/1');
      await engine.addWebhook('session.destroyed', 'https://example.com/2');

      const webhooks = engine.listWebhooks();

      expect(webhooks.length).toBe(2);
    });

    it('should remove webhook', async () => {
      const webhook = await engine.addWebhook('session.created', 'https://example.com');

      const deleted = await engine.removeWebhook(webhook.id);

      expect(deleted).toBe(true);
      expect(engine.getWebhook(webhook.id)).toBeUndefined();
    });

    it('should toggle webhook', async () => {
      const webhook = await engine.addWebhook('session.created', 'https://example.com');

      const disabled = await engine.toggleWebhook(webhook.id, false);
      expect(disabled?.enabled).toBe(false);

      const enabled = await engine.toggleWebhook(webhook.id, true);
      expect(enabled?.enabled).toBe(true);
    });
  });

  describe('Event Dispatching', () => {
    it('should dispatch events', async () => {
      const eventHandler = vi.fn();
      engine.on('session.created', eventHandler);

      await engine.dispatch('session.created', { sessionId: 'test-123', name: 'test' });

      expect(eventHandler).toHaveBeenCalledTimes(1);
      expect(eventHandler.mock.calls[0][0].type).toBe('session.created');
    });

    it('should store events in history', async () => {
      await engine.dispatch('session.created', { sessionId: 'test-1' });
      await engine.dispatch('session.destroyed', { sessionId: 'test-1' });

      const history = engine.getEventHistory();

      expect(history.length).toBe(2);
      expect(history[0].type).toBe('session.destroyed');
      expect(history[1].type).toBe('session.created');
    });

    it('should filter events by type', async () => {
      await engine.dispatch('session.created', { sessionId: 'test-1' });
      await engine.dispatch('session.destroyed', { sessionId: 'test-1' });
      await engine.dispatch('session.created', { sessionId: 'test-2' });

      const created = engine.getEventsByType('session.created');

      expect(created.length).toBe(2);
    });

    it('should execute matching shell hooks', async () => {
      await engine.addShellHook('session.created', 'echo "session created"');

      const result = await engine.dispatch('session.created', { sessionId: 'test-123' });

      expect(result.shellResults.length).toBe(1);
    });

    it('should filter hooks by session', async () => {
      await engine.addShellHook('session.created', 'echo "all sessions"');
      await engine.addShellHook('session.created', 'echo "specific"', { sessionFilter: 'target-session' });

      // Dispatch for different session
      const result1 = await engine.dispatch('session.created', { sessionId: 'other-session' });
      expect(result1.shellResults.length).toBe(1);

      // Dispatch for target session
      const result2 = await engine.dispatch('session.created', { sessionId: 'target-session' });
      expect(result2.shellResults.length).toBe(2);
    });

    it('should match wildcard hooks', async () => {
      await engine.addShellHook('*', 'echo "catch all"');

      const result = await engine.dispatch('prompt.completed', { sessionId: 'test', promptId: 'p1' });

      expect(result.shellResults.length).toBe(1);
    });
  });

  describe('Statistics', () => {
    it('should return correct stats', async () => {
      await engine.addShellHook('session.created', 'echo 1');
      await engine.addShellHook('session.destroyed', 'echo 2');
      const hook3 = await engine.addShellHook('prompt.completed', 'echo 3');
      await engine.toggleShellHook(hook3.id, false);

      await engine.addWebhook('session.created', 'https://example.com');

      await engine.dispatch('session.created', { sessionId: 'test' });

      const stats = engine.getStats();

      expect(stats.shellHooks).toBe(3);
      expect(stats.enabledShellHooks).toBe(2);
      expect(stats.webhooks).toBe(1);
      expect(stats.enabledWebhooks).toBe(1);
      expect(stats.eventCount).toBe(1);
    });
  });

  describe('Persistence', () => {
    it('should persist and restore hooks', async () => {
      await engine.addShellHook('session.created', 'echo test');
      await engine.addWebhook('prompt.completed', 'https://example.com');

      // Create new engine instance
      const newEngine = new HookEngine(testDir);
      await newEngine.load();

      expect(newEngine.listShellHooks().length).toBe(1);
      expect(newEngine.listWebhooks().length).toBe(1);
    });
  });
});
