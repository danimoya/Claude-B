import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionManager } from './session-manager.js';
import { rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SessionManager', () => {
  let testDir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-b-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    manager = new SessionManager(testDir);
    await manager.load();
  });

  afterEach(async () => {
    await manager.stopAll();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a new session', async () => {
      const session = await manager.create('test-session');

      expect(session.id).toBeDefined();
      expect(session.name).toBe('test-session');
      expect(manager.count()).toBe(1);
    });

    it('should create a session with model', async () => {
      const session = await manager.create('test', 'sonnet');

      expect(session.model).toBe('sonnet');
    });

    it('should auto-select first session', async () => {
      const session = await manager.create('first');

      expect(manager.current()).toBe(session);
    });

    it('should not auto-select subsequent sessions', async () => {
      const first = await manager.create('first');
      await manager.create('second');

      expect(manager.current()).toBe(first);
    });
  });

  describe('get', () => {
    it('should get session by id', async () => {
      const session = await manager.create('test');

      expect(manager.get(session.id)).toBe(session);
    });

    it('should return undefined for unknown id', () => {
      expect(manager.get('nonexistent')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should list all sessions', async () => {
      await manager.create('session1');
      await manager.create('session2', 'opus');

      const list = manager.list();

      expect(list.length).toBe(2);
      expect(list[0].name).toBe('session1');
      expect(list[1].name).toBe('session2');
      expect(list[1].model).toBe('opus');
    });

    it('should mark selected session', async () => {
      const first = await manager.create('first');
      await manager.create('second');

      const list = manager.list();

      expect(list.find(s => s.id === first.id)?.selected).toBe(true);
      expect(list.find(s => s.name === 'second')?.selected).toBe(false);
    });
  });

  describe('select', () => {
    it('should select a session', async () => {
      await manager.create('first');
      const second = await manager.create('second');

      manager.select(second.id);

      expect(manager.current()).toBe(second);
    });

    it('should throw for unknown session', () => {
      expect(() => manager.select('nonexistent')).toThrow('Session not found');
    });
  });

  describe('kill', () => {
    it('should remove a session', async () => {
      const session = await manager.create('test');

      await manager.kill(session.id);

      expect(manager.count()).toBe(0);
      expect(manager.get(session.id)).toBeUndefined();
    });

    it('should select another session when killing selected', async () => {
      const first = await manager.create('first');
      const second = await manager.create('second');

      await manager.kill(first.id);

      expect(manager.current()).toBe(second);
    });

    it('should throw for unknown session', async () => {
      await expect(manager.kill('nonexistent')).rejects.toThrow('Session not found');
    });
  });

  describe('count', () => {
    it('should return correct count', async () => {
      expect(manager.count()).toBe(0);

      await manager.create('one');
      expect(manager.count()).toBe(1);

      await manager.create('two');
      expect(manager.count()).toBe(2);
    });
  });

  describe('persistence', () => {
    it('should persist and restore sessions', async () => {
      await manager.create('persistent-session', 'opus');
      await manager.save();

      // Create new manager instance
      const newManager = new SessionManager(testDir);
      await newManager.load();

      expect(newManager.count()).toBe(1);
      const list = newManager.list();
      expect(list[0].name).toBe('persistent-session');
      expect(list[0].model).toBe('opus');

      await newManager.stopAll();
    });
  });
});
