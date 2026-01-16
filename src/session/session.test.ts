import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Session, SessionState } from './session.js';
import { rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('Session', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `claude-b-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('should create a session with default values', () => {
      const session = Session.create(undefined, testDir);

      expect(session.id).toBeDefined();
      expect(session.id.length).toBe(8);
      expect(session.name).toBeUndefined();
      expect(session.model).toBeUndefined();
      expect(session.status).toBe('idle');
      expect(session.createdAt).toBeDefined();
    });

    it('should create a session with a name', () => {
      const session = Session.create('my-session', testDir);

      expect(session.name).toBe('my-session');
    });

    it('should create a session with a model', () => {
      const session = Session.create('test', testDir, 'sonnet');

      expect(session.name).toBe('test');
      expect(session.model).toBe('sonnet');
    });
  });

  describe('getState', () => {
    it('should return the session state', () => {
      const session = Session.create('test-session', testDir, 'opus');
      const state = session.getState();

      expect(state.id).toBe(session.id);
      expect(state.name).toBe('test-session');
      expect(state.model).toBe('opus');
      expect(state.status).toBe('idle');
      expect(state.createdAt).toBe(session.createdAt);
      expect(state.promptCount).toBe(0);
    });
  });

  describe('constructor', () => {
    it('should restore session from state', () => {
      const state: SessionState = {
        id: 'abc12345',
        name: 'restored-session',
        model: 'haiku',
        status: 'idle',
        createdAt: '2024-01-01T00:00:00.000Z',
        workingDir: '/tmp',
        promptCount: 5,
        lastPromptId: 'xyz789'
      };

      const session = new Session(state, testDir);

      expect(session.id).toBe('abc12345');
      expect(session.name).toBe('restored-session');
      expect(session.model).toBe('haiku');
      expect(session.status).toBe('idle');
      expect(session.createdAt).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('getLastOutput', () => {
    it('should return empty string initially', () => {
      const session = Session.create('test', testDir);
      expect(session.getLastOutput()).toBe('');
    });
  });

  describe('getFullTranscript', () => {
    it('should return empty string initially', () => {
      const session = Session.create('test', testDir);
      expect(session.getFullTranscript()).toBe('');
    });
  });
});
