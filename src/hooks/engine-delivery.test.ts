import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HookEngine } from './engine.js';
import * as storage from '../storage/atomic-json.js';
import { createDeliveryOutbox } from '../notifications/delivery.js';

const metadata = { id: 'stable-delivery-event', timestamp: '2026-11-07T00:00:00.000Z' };
const payload = { sessionId: 'fixture-session', promptId: 'fixture-prompt', status: 'success', output: 'visible result' };

describe('durable hook subscriber receipts', () => {
  let dir: string;
  let engine: HookEngine;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-hook-receipts-'));
    engine = new HookEngine(dir); await engine.load();
  });
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

  it('retries only failed subscribers across restart and keeps owner-only acknowledgments', async () => {
    const counter = join(dir, 'shell-events');
    await engine.addShellHook('prompt.completed', `printf '%s\\n' "$CLAUDE_B_EVENT_ID" >> '${counter}'`);
    await engine.addWebhook('prompt.completed', 'https://good.invalid', { retries: 0 });
    await engine.addWebhook('prompt.completed', 'https://retry.invalid', { retries: 1 });
    let fail = true;
    const receiver = vi.fn().mockImplementation(async url => new Response('fixture', { status: String(url).includes('retry') && fail ? 503 : 200 }));
    vi.stubGlobal('fetch', receiver);
    const first = await engine.dispatch('prompt.completed', payload, metadata);
    expect(first.webhookResults.map(value => value.success)).toEqual([true, false]);
    fail = false;
    const restarted = new HookEngine(dir); await restarted.load();
    const second = await restarted.dispatch('prompt.completed', payload, metadata);
    expect(second.webhookResults.every(value => value.success)).toBe(true);
    expect(await readFile(counter, 'utf8')).toBe(`${metadata.id}\n`);
    expect(receiver.mock.calls.filter(([url]) => url === 'https://good.invalid')).toHaveLength(1);
    expect(receiver.mock.calls.filter(([url]) => url === 'https://retry.invalid')).toHaveLength(2);
    expect(receiver.mock.calls.at(-1)?.[0]).toBe('https://retry.invalid');
    for (const file of await readdir(join(dir, 'hook-deliveries'))) {
      expect((await stat(join(dir, 'hook-deliveries', file))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(dir, 'hook-deliveries', file), 'utf8')).not.toMatch(/visible result|https:\/\//);
    }
  });

  it('deduplicates concurrent attempts from independent engine instances', async () => {
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { retries: 0 });
    const other = new HookEngine(dir); await other.load();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const receiver = vi.fn().mockImplementation(async () => { await gate; return new Response('ok'); });
    vi.stubGlobal('fetch', receiver);
    const first = engine.dispatch('prompt.completed', payload, metadata);
    const second = other.dispatch('prompt.completed', payload, metadata);
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(other.getEventHistory()).toHaveLength(1));
    release();
    await Promise.all([first, second]);
    expect(receiver).toHaveBeenCalledOnce();
  });

  it('rejects event ID reuse for changed content before dispatching subscribers', async () => {
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { retries: 0 });
    const receiver = vi.fn().mockImplementation(async () => new Response('ok'));
    vi.stubGlobal('fetch', receiver);
    await engine.dispatch('prompt.completed', payload, metadata);
    await expect(engine.dispatch('prompt.completed', { ...payload, output: 'changed' }, metadata)).rejects.toThrow('conflicts');
    expect(receiver).toHaveBeenCalledOnce();
  });

  it('isolates synchronous and asynchronous observer failures', async () => {
    const observer = vi.fn();
    engine.on('event', () => { throw new Error('observer failure'); });
    engine.on('event', async () => { throw new Error('async observer failure'); });
    engine.on('event', observer);
    engine.on('execution', () => { throw new Error('execution observer failure'); });
    await expect(engine.dispatch('prompt.completed', payload)).resolves.toMatchObject({ shellResults: [], webhookResults: [] });
    expect(observer).toHaveBeenCalledOnce();
  });

  it('propagates transport abort and leaves no success receipt for retry', async () => {
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { retries: 1 });
    const receiver = vi.fn().mockImplementation((_url, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    vi.stubGlobal('fetch', receiver);
    const controller = new AbortController();
    const pending = engine.dispatch('prompt.completed', payload, { ...metadata, signal: controller.signal });
    await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
    controller.abort();
    expect((await pending).webhookResults[0].success).toBe(false);
    const receiptFile = (await readdir(join(dir, 'hook-deliveries'))).find(file => file.endsWith('.subscriber.json'))!;
    expect(JSON.parse(await readFile(join(dir, 'hook-deliveries', receiptFile), 'utf8')))
      .toMatchObject({ success: false, retryable: true, attempts: 1 });
    receiver.mockImplementation(async () => new Response('ok'));
    expect((await engine.dispatch('prompt.completed', payload, metadata)).webhookResults[0].success).toBe(true);
    expect(receiver).toHaveBeenCalledTimes(2);
  });
  it('records terminal HTTP rejection and non-idempotent shell failure without replay', async () => {
    const counter = join(dir, 'failed-shell-events');
    await engine.addShellHook('prompt.completed', `printf x >> '${counter}'; exit 1`);
    await engine.addWebhook('prompt.completed', 'https://reject.invalid', { retries: 0 });
    const receiver = vi.fn().mockImplementation(async () => new Response('bad input', { status: 400 }));
    vi.stubGlobal('fetch', receiver);
    const first = await engine.dispatch('prompt.completed', payload, metadata);
    expect(first.shellResults[0]).toMatchObject({ success: false, retryable: false });
    expect(first.webhookResults[0]).toMatchObject({ success: false, retryable: false, statusCode: 400 });
    const restarted = new HookEngine(dir); await restarted.load();
    const repeated = await restarted.dispatch('prompt.completed', payload, metadata);
    expect(repeated.shellResults[0]).toMatchObject({ success: false, retryable: false });
    expect(repeated.webhookResults[0]).toMatchObject({ success: false, retryable: false, statusCode: 400 });
    expect(receiver).toHaveBeenCalledOnce();
    expect(await readFile(counter, 'utf8')).toBe('x');
  });

  it.each([
    { retries: 0, status: 500, expected: 1 },
    { retries: 0, status: 'network', expected: 1 },
    { retries: 1, status: 503, expected: 2 },
    { retries: undefined, status: 500, expected: 3 },
    { retries: 5, status: 400, expected: 1 }
  ])('honors one total durable retry budget across restarts: $retries/$status', async ({ retries, status, expected }) => {
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { retries });
    const receiver = vi.fn().mockImplementation(async () => {
      if (status === 'network') throw new Error('connection reset');
      return new Response('rejected', { status: Number(status) });
    });
    vi.stubGlobal('fetch', receiver);
    for (let index = 0; index < 7; index++) {
      const restarted = new HookEngine(dir); await restarted.load();
      const result = await restarted.dispatch('prompt.completed', payload, metadata);
      expect(result.webhookResults[0].success).toBe(false);
      expect(result.webhookResults[0].retryable).toBe(index < expected - 1);
    }
    expect(receiver).toHaveBeenCalledTimes(expected);
  });

  it('records attempt intent before HTTP and carries Retry-After to the durable scheduler', async () => {
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { retries: 1 });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
      const file = (await readdir(join(dir, 'hook-deliveries'))).find(name => name.endsWith('.subscriber.json'))!;
      expect(JSON.parse(await readFile(join(dir, 'hook-deliveries', file), 'utf8'))).toMatchObject({ attempts: 1, success: false, retryable: true });
      return new Response('busy', { status: 429, headers: { 'Retry-After': '7' } });
    }));
    const result = await engine.dispatch('prompt.completed', payload, metadata);
    expect(result.webhookResults[0]).toMatchObject({ success: false, retryable: true, retryAfterMs: 7000 });
  });

  it('restores the budget when stopped after intent persistence but before HTTP starts', async () => {
    await engine.addWebhook('prompt.completed', 'https://receiver.invalid', { retries: 0 });
    const receiver = vi.fn().mockImplementation(async () => new Response('busy', { status: 500 }));
    vi.stubGlobal('fetch', receiver);
    const controller = new AbortController();
    const write = storage.atomicWriteJson;
    const spy = vi.spyOn(storage, 'atomicWriteJson').mockImplementation(async (path, value) => {
      await write(path, value);
      if (path.endsWith('.subscriber.json') && (value as { attempts?: number }).attempts === 1) controller.abort();
    });
    await engine.dispatch('prompt.completed', payload, { ...metadata, signal: controller.signal });
    expect(receiver).not.toHaveBeenCalled();
    const file = (await readdir(join(dir, 'hook-deliveries'))).find(name => name.endsWith('.subscriber.json'))!;
    expect(JSON.parse(await readFile(join(dir, 'hook-deliveries', file), 'utf8')).attempts).toBe(0);
    spy.mockRestore();
    await engine.dispatch('prompt.completed', payload, metadata);
    expect(receiver).toHaveBeenCalledOnce();
  });

  it('deadletters a known completed shell when its acknowledgment cannot be stored', async () => {
    const counter = join(dir, 'completed-shell');
    await engine.addShellHook('prompt.completed', `printf x >> '${counter}'`);
    const write = storage.atomicWriteJson;
    vi.spyOn(storage, 'atomicWriteJson').mockImplementation(async (path, value) => {
      if (path.endsWith('.subscriber.json') && (value as { kind?: string; success?: boolean }).kind === 'shell' &&
          (value as { success?: boolean }).success === true) throw new Error('receipt storage unavailable');
      await write(path, value);
    });
    const outbox = createDeliveryOutbox(dir, { hooks: engine });
    await outbox.enqueue({ sessionId: 'fixture-session', promptId: 'completed-task', type: 'prompt.completed', exitCode: 0, viewCommand: 'cb --task completed-task' });
    await outbox.drain(true);
    expect((await outbox.list())[0]).toMatchObject({ failed: ['hooks'] });
    await outbox.drain(true);
    const restarted = createDeliveryOutbox(dir, { hooks: engine });
    await restarted.drain(true);
    expect(await readFile(counter, 'utf8')).toBe('x');
  });

});
