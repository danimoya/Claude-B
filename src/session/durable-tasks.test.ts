import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Session } from './session.js';
import { SessionManager } from '../daemon/session-manager.js';
import { TaskStore } from '../jobs/store.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../utils/claude-detector.js', () => ({ getClaudePath: () => 'fake-claude' }));

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    unref: vi.fn(), kill: vi.fn(),
  });
  child.kill.mockImplementation(() => { queueMicrotask(() => child.emit('close', null)); return true; });
  return child;
}

describe('durable task execution and cancellation', () => {
  let dir: string;
  let session: Session;
  let children: ReturnType<typeof fakeChild>[];

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'cb-durable-')));
    children = [];
    vi.mocked(spawn).mockImplementation((() => {
      const child = fakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof spawn);
    session = Session.create('durable', dir, 'sonnet', 'goal', false, dir, 'default');
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function waitForChildren(count: number) { await vi.waitFor(() => expect(children).toHaveLength(count)); }
  async function complete(child: ReturnType<typeof fakeChild>, output = 'done') {
    const done = new Promise<void>((resolve) => session.once('notification', () => resolve()));
    child.stdout.write(output);
    child.emit('close', 0);
    await done;
  }

  it('writes a pending receipt before acceptance returns and a running receipt before spawning', async () => {
    const observed: { tasks?: ReturnType<typeof requireTasks>; error?: unknown } = {};
    vi.mocked(spawn).mockImplementation((() => {
      // Capture the pre-execution state without throwing assertions inside the
      // runtime callback, which would turn a fixture mismatch into a task error.
      try { observed.tasks = requireTasks(); } catch (error) { observed.error = error; }
      const child = fakeChild(); children.push(child); return child;
    }) as unknown as typeof spawn);
    const id = await session.sendPrompt('exact prompt');
    expect(await new TaskStore(dir).get(id)).toMatchObject({ id, taskId: id, promptId: id, sessionId: session.id });
    await waitForChildren(1);
    expect(observed.error).toBeUndefined();
    expect(observed.tasks).toHaveLength(1);
    expect(observed.tasks![0]).toMatchObject({ status: 'running', prompt: 'exact prompt', workingDir: dir, model: 'sonnet', executionPolicy: 'default' });
    await complete(children[0]);
  });

  function requireTasks() {
    return readdirSync(join(dir, 'tasks')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(readFileSync(join(dir, 'tasks', name), 'utf8')));
  }

  it('deduplicates concurrent submissions and persists the exact result before notification', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => session.sendPrompt('same', { idempotencyKey: 'request' })));
    expect(new Set(ids).size).toBe(1);
    await waitForChildren(1);
    const exact = 'result\n' + 'x'.repeat(60000);
    const structured = { result: exact, is_error: false, duration_ms: 12, total_cost_usd: 0.25, num_turns: 2 };
    session.once('notification', () => {
      const receipt = JSON.parse(readFileSync(join(dir, 'tasks', `${ids[0]}.json`), 'utf8'));
      expect(receipt).toMatchObject({ status: 'completed', output: exact, structuredResult: { result: exact, durationMs: 12 } });
    });
    await complete(children[0], JSON.stringify(structured));
    expect(await session.sendPrompt('same', { idempotencyKey: 'request' })).toBe(ids[0]);
    expect(children).toHaveLength(1);
    expect((await session.getTask(ids[0]))?.output).toBe(exact);
  });

  it('cancels queued work without execution and active work with a durable terminal receipt', async () => {
    const active = await session.sendPrompt('active');
    await waitForChildren(1);
    const queued = await session.sendPrompt('queued');
    expect((await session.cancelTask(queued))?.status).toBe('cancelled');
    expect(children).toHaveLength(1);
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    expect((await session.cancelTask(active))?.status).toBe('cancelled');
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(cleared).toHaveBeenCalled();
    expect((await session.listTasks()).map((task) => task.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('stops without starting queued work and rejects later acceptance', async () => {
    const active = await session.sendPrompt('active');
    await waitForChildren(1);
    const queued = await session.sendPrompt('queued');
    await session.stop();
    expect(children).toHaveLength(1);
    expect((await session.getTask(active))?.status).toBe('cancelled');
    expect((await session.getTask(queued))?.status).toBe('cancelled');
    await expect(session.sendPrompt('later')).rejects.toThrow('stopping');
  });

  it('forces an unresponsive child to stop and removes its bounded timer', async () => {
    const id = await session.sendPrompt('active');
    await waitForChildren(1);
    children[0].kill.mockImplementation(() => true);
    vi.useFakeTimers();
    const cancelled = session.cancelTask(id);
    await vi.waitFor(() => expect(children[0].kill).toHaveBeenCalledWith('SIGTERM'));
    await vi.advanceTimersByTimeAsync(2000);
    expect((await cancelled)?.status).toBe('cancelled');
    expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('recovers pending/running work as interrupted without replay and retains task lookup after session cleanup', async () => {
    const manager = new SessionManager(dir);
    await manager.load();
    session = await manager.create('managed', 'sonnet', undefined, true, dir);
    const running = await session.sendPrompt('running');
    await waitForChildren(1);
    children[0].stdout.write('partial output');
    await vi.waitFor(async () => expect((await session.getTask(running))?.rawOutput).toBe('partial output'));
    const queued = await session.sendPrompt('queued');
    await manager.save();
    const restored = new SessionManager(dir);
    await restored.load();
    expect((await restored.getTask(running))).toMatchObject({ status: 'interrupted', rawOutput: 'partial output', error: expect.stringContaining('not replayed') });
    expect((await restored.getTask(queued))?.status).toBe('interrupted');
    expect(children).toHaveLength(1);
    expect(restored.get(session.id)?.getLastOutput()).toContain('not replayed');
    await restored.cleanupFireAndForget();
    expect(restored.get(session.id)).toBeUndefined();
    expect((await restored.getTask(running))?.status).toBe('interrupted');
    expect(JSON.parse(await readFile(join(dir, 'sessions', 'index.json'), 'utf8')).sessions).toHaveLength(0);
  });

  it('rejects acceptance when a durable receipt cannot be written and never launches work', async () => {
    await writeFile(join(dir, 'tasks'), 'blocks receipt directory');
    await expect(session.sendPrompt('unaccepted')).rejects.toThrow();
    expect(children).toHaveLength(0);
    expect(session.status).toBe('idle');
    expect(session.getState().promptCount).toBe(0);
  });

  it('waits for in-flight acceptance during stop and records cancellation without execution', async () => {
    const accept = session.taskStore.accept.bind(session.taskStore);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(session.taskStore, 'accept').mockImplementation(async (input) => { await gate; return accept(input); });
    const submitted = session.sendPrompt('racing stop');
    const stopped = session.stop();
    release();
    const id = await submitted;
    await stopped;
    expect((await session.getTask(id))?.status).toBe('cancelled');
    expect(children).toHaveLength(0);
  });

  it('prevents execution when cancellation races the running-state write', async () => {
    const update = session.taskStore.update.bind(session.taskStore);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let running = false;
    vi.spyOn(session.taskStore, 'update').mockImplementation(async (id, changes) => {
      if (changes.status === 'running') { running = true; await gate; }
      return update(id, changes);
    });
    const id = await session.sendPrompt('race');
    await vi.waitFor(() => expect(running).toBe(true));
    expect((await session.cancelTask(id))?.status).toBe('cancelled');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(children).toHaveLength(0);
  });

  it('restores exact output and failure explanations from the authoritative task receipt', async () => {
    const id = await session.sendPrompt('fails');
    await waitForChildren(1);
    await complete(children[0], JSON.stringify({ result: 'permission denied', is_error: true }));
    const task = await new TaskStore(dir).get(id);
    expect(task).toMatchObject({ status: 'error', output: 'permission denied', error: 'permission denied' });
    // Legacy output files are supplemental; stale ones cannot replace receipts.
    await writeFile(join(dir, 'sessions', session.id, 'last-result.json'), JSON.stringify({ result: 'stale success', isError: false }));
    const restored = new Session(session.getState(), dir);
    await restored.loadPersistedOutput();
    expect(restored.getLastOutput()).toBe('permission denied');
    expect((await restored.getTask(id))?.output).toBe('permission denied');
  });
});
