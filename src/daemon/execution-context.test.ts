import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from './session-manager.js';
import { executionPolicy, selectExecutionSession } from './execution-context.js';

describe('project execution context', () => {
  let dir: string;
  let manager: SessionManager;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-context-'));
    await mkdir(join(dir, 'a')); await mkdir(join(dir, 'b'));
    manager = new SessionManager(dir); await manager.load();
  });
  afterEach(async () => { await manager.stopAll(); await rm(dir, { recursive: true, force: true }); });
  it('creates one project session for concurrent first submissions and separates projects', async () => {
    const [a, same] = await Promise.all([selectExecutionSession(manager, { workingDir: join(dir, 'a') }), selectExecutionSession(manager, { workingDir: join(dir, 'a') })]);
    expect(a.id).toBe(same.id);
    const b = await selectExecutionSession(manager, { workingDir: join(dir, 'b') });
    expect(b.id).not.toBe(a.id);
    expect((await selectExecutionSession(manager, { workingDir: join(dir, 'a') })).id).toBe(a.id);
  });
  it('honors explicit session targeting and persists an explicit policy', async () => {
    const target = await manager.create('target', undefined, undefined, false, join(dir, 'a'));
    const selected = await selectExecutionSession(manager, { sessionId: target.id, workingDir: join(dir, 'b'), executionPolicy: 'bypass' });
    expect(selected.id).toBe(target.id);
    expect(selected.getState().workingDir).toBe(join(dir, 'a'));
    const restored = new SessionManager(dir); await restored.load();
    expect(restored.get(target.id)?.executionPolicy).toBe('bypass');
  });
  it('rejects invalid paths/policies and policy changes on busy sessions', async () => {
    expect(() => executionPolicy('unsafe')).toThrow('Execution policy');
    await expect(selectExecutionSession(manager, { workingDir: join(dir, 'missing') })).rejects.toThrow();
    const target = await manager.create(undefined, undefined, undefined, false, join(dir, 'a'));
    target.status = 'busy';
    await expect(selectExecutionSession(manager, { sessionId: target.id, executionPolicy: 'bypass' })).rejects.toThrow('busy');
    target.status = 'idle';
  });
});
