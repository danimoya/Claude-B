import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskStore } from './store.js';
import { TaskConflictError } from './types.js';

describe('durable task receipts', () => {
  let dir: string;
  let store: TaskStore;
  const input = { sessionId: 'session-a', prompt: 'exact prompt\n', workingDir: '/workspace', model: 'sonnet', executionPolicy: 'default' as const };
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cb-tasks-')); store = new TaskStore(dir); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('atomically persists acceptance and deduplicates concurrent store instances', async () => {
    const other = new TaskStore(dir);
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? store : other).accept({ ...input, idempotencyKey: 'same-request' })));
    expect(new Set(results.map(({ task }) => task.id)).size).toBe(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    const id = results[0].task.id;
    const path = join(dir, 'tasks', `${id}.json`);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ id, taskId: id, promptId: id, status: 'pending', prompt: input.prompt });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects reused keys with a different prompt, cwd, model, policy, or explicit task ID', async () => {
    await store.accept({ ...input, idempotencyKey: 'request' });
    for (const changes of [{ prompt: 'changed' }, { workingDir: '/other' }, { model: 'opus' }, { executionPolicy: 'bypass' as const }, { taskId: 'different-task-id' }]) {
      await expect(store.accept({ ...input, idempotencyKey: 'request', ...changes })).rejects.toBeInstanceOf(TaskConflictError);
    }
    const replay = await new TaskStore(dir).accept({ ...input, idempotencyKey: 'request' });
    expect(replay.created).toBe(false);
    expect(await store.list()).toHaveLength(1);
  });

  it('marks pending/running receipts interrupted on recovery without changing terminal output', async () => {
    const pending = (await store.accept(input)).task;
    const running = (await store.accept({ ...input, prompt: 'running' })).task;
    await store.update(running.id, { status: 'running', rawOutput: 'partial\n', output: 'partial\n' });
    const done = (await store.accept({ ...input, prompt: 'done' })).task;
    await store.update(done.id, { status: 'completed', output: '', rawOutput: '{}' });
    expect(await new TaskStore(dir).recoverInterrupted()).toHaveLength(2);
    expect(await store.get(pending.id)).toMatchObject({ status: 'interrupted', error: expect.stringContaining('not replayed') });
    expect(await store.get(running.id)).toMatchObject({ status: 'interrupted', rawOutput: 'partial\n', output: 'partial\n' });
    expect(await store.get(done.id)).toMatchObject({ status: 'completed', output: '', rawOutput: '{}' });
    expect(await store.recoverInterrupted()).toHaveLength(0);
  });

  it('keeps terminal receipts immutable and refuses unsafe task IDs', async () => {
    const { task } = await store.accept(input);
    await store.update(task.id, { status: 'error', error: 'exact failure', output: 'provider output' });
    await expect(store.update(task.id, { status: 'running' })).rejects.toBeInstanceOf(TaskConflictError);
    expect(await new TaskStore(dir).get(task.id)).toMatchObject({ status: 'error', error: 'exact failure', output: 'provider output' });
    await expect(store.get('../../secret')).rejects.toThrow('Invalid task ID');
  });

  it('never exposes a partially written JSON record while replacing output', async () => {
    const { task } = await store.accept(input);
    await Promise.all([
      ...Array.from({ length: 12 }, (_, index) => store.update(task.id, { output: String(index).repeat(10000) })),
      ...Array.from({ length: 30 }, () => store.get(task.id)),
    ]);
    expect((await store.get(task.id))?.output).toBe('11'.repeat(10000));
  });

  it('fails closed on malformed receipt fields and preserves their original bytes', async () => {
    const { task } = await store.accept(input);
    const path = join(dir, 'tasks', `${task.id}.json`);
    for (const changes of [
      { status: 'unknown' }, { executionPolicy: 'unsafe' }, { workingDir: '../outside' },
      { sessionId: '../outside' }, { prompt: 123 }, { prompt: ' ' }, { output: null },
      { rawOutput: undefined }, { createdAt: 'not-a-date' }, { updatedAt: null },
      { status: 'running' }, { status: 'completed' },
      { status: 'error', completedAt: task.createdAt },
      { structuredResult: { result: 'bad', durationMs: -1, costUsd: 0, numTurns: 1, isError: false } },
    ]) {
      const bytes = JSON.stringify({ ...task, ...changes });
      await writeFile(path, bytes);
      await expect(store.get(task.id)).rejects.toThrow();
      await expect(store.recoverInterrupted()).rejects.toThrow();
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
  });

  it('rejects backwards transitions and all attempts to mutate terminal or submission data', async () => {
    const { task } = await store.accept(input);
    await store.update(task.id, { status: 'running' });
    await expect(store.update(task.id, { status: 'pending' })).rejects.toBeInstanceOf(TaskConflictError);
    await expect(store.update(task.id, { executionPolicy: 'bypass' } as any)).rejects.toBeInstanceOf(TaskConflictError);
    await store.update(task.id, { status: 'completed', output: 'exact' });
    await expect(store.update(task.id, { output: 'changed' })).rejects.toBeInstanceOf(TaskConflictError);
    expect((await store.get(task.id))?.output).toBe('exact');
  });
});
