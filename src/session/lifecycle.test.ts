import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Session } from './session.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../utils/claude-detector.js', () => ({ getClaudePath: () => 'fake-claude' }));

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    unref: vi.fn(), kill: vi.fn(),
  });
}

describe('print-mode prompt terminal results', () => {
  let dir: string;
  let session: Session;
  let children: ReturnType<typeof fakeChild>[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-lifecycle-'));
    children = [];
    vi.mocked(spawn).mockImplementation(((command: string) => {
      const child = fakeChild();
      if (command === 'fake-claude') children.push(child);
      return child;
    }) as unknown as typeof spawn);
    session = Session.create('test', dir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function start() {
    const count = children.length;
    const id = await session.sendPrompt('work');
    await vi.waitFor(() => expect(children).toHaveLength(count + 1));
    return { child: children[count], id };
  }

  async function finish(child: ReturnType<typeof fakeChild>, output = '', code: number | null = 0) {
    const received = new Promise<any>((resolve) => session.once('notification', resolve));
    if (output) child.stdout.write(output);
    child.emit('close', code);
    return received;
  }

  it('waits for close and drained stdout instead of prompt-like output or process exit', async () => {
    const completed = vi.fn();
    session.on('prompt.completed', completed);
    const { child, id } = await start();
    child.stdout.write('a >\n───── x ─────');
    child.emit('exit', 0);
    expect(completed).not.toHaveBeenCalled();
    expect(session.status).toBe('busy');
    const notification = await finish(child, '\nlast chunk');
    expect(notification.type).toBe('prompt.completed');
    expect(notification.promptId).toBe(id);
    expect(notification.resultFull).toContain('last chunk');
    expect(completed).toHaveBeenCalledOnce();
  });

  it('persists output and terminal history before emitting completion', async () => {
    const { child, id } = await start();
    let outputAtNotification = '';
    let historyAtNotification = '';
    // Start reads immediately when the notification is emitted. Writes must
    // already be complete when downstream consumers receive this event.
    session.once('notification', () => {
      outputAtNotification = requireRead('last-output.txt');
      historyAtNotification = requireRead('history.jsonl');
    });
    await finish(child, 'complete output');
    expect(outputAtNotification).toBe('complete output');
    const terminal = historyAtNotification.trim().split('\n').map((line) => JSON.parse(line)).at(-1);
    expect(terminal).toMatchObject({ id, status: 'completed', output: 'complete output' });
  });

  function requireRead(file: string): string {
    // Synchronous reads prove that persistence precedes notification dispatch.
    return readFileSync(join(dir, 'sessions', session.id, file), 'utf8');
  }

  it('clears structured results when a later prompt produces no output, including after restart', async () => {
    const first = await start();
    await finish(first.child, JSON.stringify({ result: 'old result', is_error: false }));
    expect(session.getLastOutput()).toBe('old result');
    const second = await start();
    expect(session.getStructuredResult()).toBeUndefined();
    const notification = await finish(second.child);
    expect(notification.resultFull).toBe('');
    expect(session.getLastOutput()).toBe('');
    expect(session.getLastRawOutput()).toBe('');
    const restored = new Session(session.getState(), dir);
    await restored.loadPersistedOutput();
    expect(restored.getStructuredResult()).toBeUndefined();
    expect(restored.getLastOutput()).toBe('');
    expect(await readFile(join(dir, 'sessions', session.id, 'last-output.txt'), 'utf8')).toBe('');
  });

  it.each([1, null])('emits an error terminal event for exit %s', async (code) => {
    const completed = vi.fn();
    const errors = vi.fn();
    session.on('prompt.completed', completed);
    session.on('prompt.error', errors);
    const { child } = await start();
    const notification = await finish(child, 'failed work', code);
    expect(notification.type).toBe('prompt.error');
    expect(completed).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    expect(JSON.parse(requireRead('history.jsonl').trim().split('\n').at(-1)!)).toMatchObject({ status: 'error' });
  });

  it('treats a structured provider error as failure even with exit code zero', async () => {
    const { child } = await start();
    const notification = await finish(child, JSON.stringify({ result: 'permission denied', is_error: true }), 0);
    expect(notification.type).toBe('prompt.error');
    expect(notification.resultFull).toContain('permission denied');
  });

  it('reports a persistence failure instead of announcing successful completion', async () => {
    const { child } = await start();
    const path = join(dir, 'sessions', session.id);
    await rm(path, { recursive: true });
    await writeFile(path, 'blocks directory creation');
    const notification = await finish(child, 'provider succeeded');
    expect(notification.type).toBe('prompt.error');
    expect(notification.resultFull).toContain('Failed to persist result');
  });

  it('ignores a stale close after a spawn error when a new prompt is active', async () => {
    const first = await start();
    first.child.emit('error', new Error('spawn failed'));
    const second = await start();
    first.child.emit('close', 1);
    expect(session.status).toBe('busy');
    expect((await finish(second.child, 'new result')).resultFull).toBe('new result');
  });

  it('reports initial history failure and returns to idle without launching a provider', async () => {
    await writeFile(join(dir, 'sessions'), 'blocks state directory');
    const received = new Promise<any>((resolve) => session.once('notification', resolve));
    const id = await session.sendPrompt('cannot persist');
    const notification = await received;
    expect(notification).toMatchObject({ type: 'prompt.error', promptId: id });
    expect(session.status).toBe('idle');
    expect(children).toHaveLength(0);
    await rm(join(dir, 'sessions'));
    const next = await start();
    expect((await finish(next.child, 'recovered')).type).toBe('prompt.completed');
  });

  it('keeps notification delivery and subsequent prompts working after a terminal observer throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    session.once('prompt.completed', () => { throw new Error('observer failed'); });
    const first = await start();
    expect((await finish(first.child, 'first')).type).toBe('prompt.completed');
    const next = await start();
    expect((await finish(next.child, 'next')).resultFull).toBe('next');
  });

  it('preserves structured and raw UTF-8 results when pipe chunks split multibyte characters', async () => {
    const { child, id } = await start();
    const result = '€ κόσμος 😺 café';
    const json = JSON.stringify({ result, is_error: false });
    const bytes = Buffer.from(json);
    const euro = bytes.indexOf(Buffer.from('€')) + 1;
    const cat = bytes.indexOf(Buffer.from('😺')) + 2;
    child.stdout.write(bytes.subarray(0, euro));
    child.stdout.write(bytes.subarray(euro, cat));
    child.stdout.write(bytes.subarray(cat));
    const warning = '\nstderr: é 🚀';
    const stderr = Buffer.from(warning);
    const rocket = stderr.indexOf(Buffer.from('🚀')) + 1;
    child.stderr.write(stderr.subarray(0, rocket));
    child.stderr.write(stderr.subarray(rocket));
    const notification = await finish(child);
    expect(notification.resultFull).toBe(result);
    expect(session.getLastOutput()).toBe(result);
    expect(session.getLastRawOutput()).toBe(json + warning);
    expect(await session.getTask(id)).toMatchObject({ status: 'completed', output: result, rawOutput: json + warning, structuredResult: { result } });
    const restored = new Session(session.getState(), dir);
    await restored.loadPersistedOutput();
    expect(restored.getLastOutput()).toBe(result);
    expect(restored.getLastRawOutput()).toBe(json + warning);
  });
});
