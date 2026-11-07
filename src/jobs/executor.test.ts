import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureTaskExecutor, inspectExecutorProcess, recoverTaskExecutor, type ExecutorProcess } from './executor.js';
import { TaskStore } from './store.js';
import { Session } from '../session/session.js';

vi.mock('../utils/claude-detector.js', () => ({ getClaudePath: () => process.env.CLAUDE_PATH! }));

describe('owned executor recovery', () => {
  let dir: string;
  const children: ChildProcess[] = [];
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cb-owned-executor-')); });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const child of children.splice(0)) {
      if (!child.pid) continue;
      try { await recoverTaskExecutor(captureTaskExecutor(child.pid), { graceMs: 100 }); }
      catch { child.kill('SIGKILL'); }
    }
    await rm(dir, { recursive: true, force: true });
  });

  it('terminates only the verified detached fixture before recording interrupted recovery', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    children.push(child); await once(child, 'spawn');
    const executor = captureTaskExecutor(child.pid!);
    const store = new TaskStore(dir);
    const { task } = await store.accept({ sessionId: 'fixture-session', prompt: 'private fixture only', workingDir: dir, executionPolicy: 'default' });
    await store.update(task.id, { status: 'running', executor, output: 'partial', rawOutput: 'partial' });
    const exited = once(child, 'exit');
    await store.recoverInterrupted();
    await exited;
    const actual = inspectExecutorProcess(child.pid!);
    expect(!actual || actual.state.startsWith('Z')).toBe(true);
    expect(await store.get(task.id)).toMatchObject({ status: 'interrupted', output: 'partial', rawOutput: 'partial', error: expect.stringContaining('Verified owned executor group was terminated') });
  });

  it('refuses mismatched birth, UID, group, own-daemon groups and legacy unknown metadata without sending signals', async () => {
    const recorded = { pid: 200, processGroup: 200, uid: 1000, startedAt: 'linux:100' };
    const signal = vi.fn();
    const base: ExecutorProcess = { ...recorded, state: 'S' };
    for (const actual of [{ ...base, startedAt: 'linux:101' }, { ...base, uid: 1001 }, { ...base, processGroup: 201 }]) {
      const result = await recoverTaskExecutor(recorded, { inspect: () => actual, groupMembers: () => [actual], signal, uid: 1000, ownPid: 1, ownGroup: 1 });
      expect(result.stopped).toBe(false);
    }
    await recoverTaskExecutor(recorded, { inspect: () => base, groupMembers: () => [base], signal, uid: 1000, ownPid: 1, ownGroup: 200 });
    expect((await recoverTaskExecutor(undefined, { signal })).explanation).toContain('unknown');
    expect(signal).not.toHaveBeenCalled();
  });

  it('uses bounded TERM/KILL only while the group remains proven owned', async () => {
    const recorded = { pid: 200, processGroup: 200, uid: 1000, startedAt: 'linux:100' };
    const actual: ExecutorProcess = { ...recorded, state: 'S' };
    let live = true;
    const signal = vi.fn((_group: number, kind: NodeJS.Signals) => { if (kind === 'SIGKILL') live = false; });
    const result = await recoverTaskExecutor(recorded, { inspect: () => actual, groupMembers: () => live ? [actual] : [], signal, uid: 1000, ownPid: 1, ownGroup: 1, graceMs: 0 });
    expect(result.stopped).toBe(true);
    expect(signal.mock.calls.map(([, kind]) => kind)).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('durably records executor ownership before the real private fixture receives its prompt', async () => {
    const fixture = join(dir, 'claude-fixture.cjs');
    await writeFile(fixture, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
let prompt=''; process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
 const records = fs.readdirSync(process.env.CB_EXECUTOR_FIXTURE_TASKS).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(process.env.CB_EXECUTOR_FIXTURE_TASKS,name),'utf8')));
 const owned = records.find(task=>task.executor?.pid===process.pid && task.executor.processGroup===process.pid && task.status==='running');
 console.log(JSON.stringify({result: owned ? 'proof before input: '+prompt : 'missing ownership proof', is_error:!owned}));
});
`, { mode: 0o700 });
    vi.stubEnv('CLAUDE_PATH', fixture);
    vi.stubEnv('CB_EXECUTOR_FIXTURE_TASKS', join(dir, 'tasks'));
    const session = Session.create('owned', dir, undefined, undefined, false, dir);
    const done = new Promise<void>((resolve) => session.once('notification', () => resolve()));
    const id = await session.sendPrompt('private prompt');
    await done;
    expect(await session.getTask(id)).toMatchObject({ status: 'completed', output: 'proof before input: private prompt', executor: { uid: process.getuid?.(), processGroup: expect.any(Number), startedAt: expect.any(String) } });
    await session.stop();
  });

  it('preserves malformed ownership evidence and prevents replacing executor metadata', async () => {
    const store = new TaskStore(dir);
    const { task } = await store.accept({ sessionId: 'fixture-session', prompt: 'not executed', workingDir: dir, executionPolicy: 'default' });
    const executor = { pid: 200, processGroup: 200, uid: 1000, startedAt: 'linux:100' };
    await store.update(task.id, { status: 'running', executor });
    await expect(store.update(task.id, { executor: { ...executor, pid: 201, processGroup: 201 } })).rejects.toThrow('immutable');
    await expect(store.update(task.id, { executor: undefined })).rejects.toThrow('immutable');
    const path = join(dir, 'tasks', `${task.id}.json`);
    const bytes = JSON.stringify({ ...(await store.get(task.id)), executor: { ...executor, startedAt: 'not a valid process birth' } });
    await writeFile(path, bytes);
    await expect(store.recoverInterrupted()).rejects.toThrow('Invalid executor');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  });
});
