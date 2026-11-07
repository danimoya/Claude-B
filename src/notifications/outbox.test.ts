import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationOutbox, NotificationConflictError } from './outbox.js';
import { NotificationInbox, type NotificationInput } from './inbox.js';
import { HookEngine } from '../hooks/engine.js';
import { createDeliveryOutbox } from './delivery.js';

const notification = (promptId = 'task-fixture'): NotificationInput => ({ sessionId: 'session', promptId, type: 'prompt.completed', exitCode: 0, resultFull: 'exact result', viewCommand: `cb --task ${promptId}` });
describe('durable notification channel receipts', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cb-outbox-')); });
  afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });

  it('persists acceptance and channel acknowledgements across restart with stable metadata', async () => {
    const inbox = new NotificationInbox(dir);
    const hooks = vi.fn().mockRejectedValueOnce(new Error('credentials must not persist')).mockResolvedValue(undefined);
    const telegram = vi.fn().mockResolvedValue(undefined);
    const channels = { inbox: { deliver: (input: NotificationInput) => inbox.addNotification(input) }, hooks: { deliver: hooks }, telegram: { deliver: telegram } };
    const first = new NotificationOutbox(dir, channels);
    const accepted = await first.enqueue(notification());
    await first.drain();
    expect((await first.list())[0].delivered).toEqual(['inbox', 'telegram']);
    expect((await first.list())[0].lastError).toBe('Error');
    const restored = new NotificationOutbox(dir, channels);
    await restored.enqueue(notification());
    await restored.drain(true);
    expect(telegram).toHaveBeenCalledTimes(1);
    expect(await inbox.getAll()).toHaveLength(1);
    expect(hooks).toHaveBeenCalledTimes(2);
    expect(hooks.mock.calls[0].slice(1, 3)).toEqual([accepted.eventId, accepted.timestamp]);
    expect(hooks.mock.calls[1].slice(1, 3)).toEqual([accepted.eventId, accepted.timestamp]);
    expect((await restored.list())[0].delivered).toEqual(['inbox', 'telegram', 'hooks']);
    expect((await restored.list())[0].lastError).toBeUndefined();
    expect((await restored.list())[0].nextAttemptAt).toBe(0);
  });

  it('deduplicates concurrent enqueue and recovered inbox delivery after an uncertain ack', async () => {
    const inbox = new NotificationInbox(dir);
    const box = new NotificationOutbox(dir, { inbox: { deliver: input => inbox.addNotification(input) } });
    await Promise.all([box.enqueue(notification()), box.enqueue(notification())]);
    // Simulate the receiver committed a previous attempt before sender ack.
    await inbox.addNotification({ ...notification(), deliveryId: 'task:task-fixture' });
    await box.drain();
    expect(await inbox.getAll()).toHaveLength(1);
    expect(await box.list()).toHaveLength(1);
    const files = await readdir(join(dir, 'outbox'));
    expect(files).toHaveLength(1);
    expect((await stat(join(dir, 'outbox', files[0]))).mode & 0o777).toBe(0o600);
  });

  it('records disabled optional channels without retroactive delivery', async () => {
    let enabled = false;
    const deliver = vi.fn().mockResolvedValue(undefined);
    const box = new NotificationOutbox(dir, { telegram: { enabled: () => enabled, deliver } });
    await box.enqueue(notification()); await box.drain();
    enabled = true; await box.drain(true);
    expect(deliver).not.toHaveBeenCalled();
    expect((await box.list())[0].skipped).toEqual(['inbox', 'hooks', 'telegram']);
  });

  it('isolates failures and observes a persisted retry deadline', async () => {
    const failed = vi.fn().mockRejectedValue(new TypeError('token-secret'));
    const ok = vi.fn().mockResolvedValue(undefined);
    const box = new NotificationOutbox(dir, { hooks: { deliver: failed }, telegram: { deliver: ok } });
    await box.enqueue(notification()); await box.drain(); await box.drain();
    expect(failed).toHaveBeenCalledOnce(); expect(ok).toHaveBeenCalledOnce();
    const record = (await box.list())[0];
    expect(record.attempts).toBe(1); expect(record.lastError).toBe('TypeError');
    expect(JSON.stringify(record)).not.toContain('token-secret');
    await box.drain(true); expect(failed).toHaveBeenCalledTimes(2); expect(ok).toHaveBeenCalledOnce();
  });

  it('fails closed on corrupt receipts rather than forgetting pending work', async () => {
    const box = new NotificationOutbox(dir, {});
    await box.enqueue(notification());
    const [file] = await readdir(join(dir, 'outbox'));
    await writeFile(join(dir, 'outbox', file), '{}');
    await expect(box.list()).rejects.toThrow('Invalid notification');
  });

  it('stops its polling timer and awaits in-flight delivery', async () => {
    const deliver = vi.fn().mockResolvedValue(undefined);
    const box = new NotificationOutbox(dir, { inbox: { deliver } });
    await box.enqueue(notification()); box.start();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await box.stop();
    expect((await box.list())[0].delivered).toEqual(['inbox']);
  });

  it('accepts other notifications while a network channel is stalled', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const deliver = vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue(undefined);
    const box = new NotificationOutbox(dir, { hooks: { deliver } });
    await box.enqueue(notification('first-task'));
    const draining = box.drain();
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    // No release yet: durable acceptance must finish independently of delivery.
    await box.enqueue(notification('second-task'));
    expect(await box.list()).toHaveLength(2);
    release(); await draining; await box.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('shares durable acceptance and drain singleflight across objects in one directory', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const deliver = vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue(undefined);
    const first = new NotificationOutbox(dir, { hooks: { deliver } });
    const second = new NotificationOutbox(join(dir, '.'), { hooks: { deliver } });
    await Promise.all([first.enqueue(notification()), second.enqueue(notification())]);
    const attempts = Promise.all([first.drain(), second.drain()]);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await second.enqueue(notification('other-task'));
    release(); await attempts; await second.drain();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await first.list()).toHaveLength(2);
    expect((await first.list()).every(record => record.delivered.includes('hooks'))).toBe(true);
  });

  it('bounds an uncooperative callback and never overlaps another attempt before it settles', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const deliver = vi.fn().mockImplementationOnce(() => blocked).mockResolvedValue(undefined);
    const first = new NotificationOutbox(dir, { hooks: { deliver } }, { channelTimeoutMs: 20 });
    const second = new NotificationOutbox(dir, { hooks: { deliver } }, { channelTimeoutMs: 20 });
    await first.enqueue(notification());
    const start = Date.now();
    await first.drain();
    expect(Date.now() - start).toBeLessThan(500);
    expect(deliver.mock.calls[0][3].aborted).toBe(true);
    expect((await first.list())[0]).toMatchObject({ attempts: 1, lastError: 'DeliveryTimeoutError' });
    await second.drain(true);
    expect(deliver).toHaveBeenCalledOnce();
    release(); await blocked; await Promise.resolve();
    await second.drain(true);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await first.list())[0].delivered).toContain('hooks');
  });

  it('stop aborts another object’s active drain promptly and starts no later channel', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const hooks = vi.fn().mockImplementation(() => blocked);
    const telegram = vi.fn().mockResolvedValue(undefined);
    const first = new NotificationOutbox(dir, { hooks: { deliver: hooks }, telegram: { deliver: telegram } });
    const second = new NotificationOutbox(dir, {});
    await first.enqueue(notification());
    const draining = first.drain();
    await vi.waitFor(() => expect(hooks).toHaveBeenCalledOnce());
    const start = Date.now();
    await second.stop(); await draining;
    expect(Date.now() - start).toBeLessThan(500);
    expect(hooks.mock.calls[0][3].aborted).toBe(true);
    expect(telegram).not.toHaveBeenCalled();
    expect((await first.list())[0]).toMatchObject({ attempts: 0, channelAttempts: { inbox: 0, hooks: 0, telegram: 0 }, failed: [] });
    release(); await blocked;
  });

  it('rejects a conflicting stable ID without replacing accepted content', async () => {
    const box = new NotificationOutbox(dir, {});
    const accepted = await box.enqueue(notification());
    await expect(box.enqueue({ ...notification(), resultFull: 'different private content' })).rejects.toBeInstanceOf(NotificationConflictError);
    expect((await box.list())[0]).toEqual(accepted);
  });

  it.each([
    (record: any) => { record.delivered = ['unknown']; },
    (record: any) => { record.delivered = ['hooks', 'hooks']; },
    (record: any) => { record.delivered = ['hooks']; record.skipped = ['hooks']; },
    (record: any) => { record.notification.deliveryId = 'another-event'; },
    (record: any) => { record.eventId = 'another-event'; },
    (record: any) => { record.attempts = -1; },
    (record: any) => { record.lastError = { private: 'never accept an object' }; },
    (record: any) => { record.failed = ['hooks']; record.delivered = ['hooks']; },
    (record: any) => { record.failed = ['unknown']; },
    (record: any) => { record.failed = null; },
    (record: any) => { record.channelAttempts = { inbox: 0, hooks: -1, telegram: 0 }; },
    (record: any) => { delete record.version; },
    (record: any) => { record.version = 2; },
    (record: any) => { delete record.failed; },
    (record: any) => { delete record.channelAttempts; },
  ])('preserves and rejects a structurally corrupt JSON channel receipt', async mutate => {
    const box = new NotificationOutbox(dir, {});
    const record = await box.enqueue(notification());
    mutate(record);
    const [file] = await readdir(join(dir, 'outbox'));
    const bytes = JSON.stringify(record);
    await writeFile(join(dir, 'outbox', file), bytes);
    await expect(box.drain()).rejects.toThrow('Invalid notification');
    expect(await (await import('node:fs/promises')).readFile(join(dir, 'outbox', file), 'utf8')).toBe(bytes);
  });

  it('dead-letters ordinary HTTP 400 once without outer or restart retries', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private failure body', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    const hooks = new HookEngine(dir);
    await hooks.addWebhook('prompt.completed', 'https://receiver.example/hook', { retries: 0 });
    const box = createDeliveryOutbox(dir, { hooks });
    await box.enqueue(notification());
    await box.drain(); await box.drain(true);
    const restored = createDeliveryOutbox(dir, { hooks });
    await restored.drain(true);
    expect(fetch).toHaveBeenCalledOnce();
    const [record] = await restored.list();
    expect(record.failed).toEqual(['hooks']);
    expect(record.delivered).not.toContain('hooks');
    expect(record.channelAttempts.hooks).toBe(1);
    expect(record.nextAttemptAt).toBe(0);
    expect(JSON.stringify(record)).not.toContain('private failure body');
  });

  it('exhausts each channel’s bounded attempt budget and retains a durable failure ledger', async () => {
    const hooks = vi.fn().mockRejectedValue(new Error('transient hook error'));
    const telegram = vi.fn().mockResolvedValueOnce(undefined);
    const box = new NotificationOutbox(dir, { hooks: { deliver: hooks }, telegram: { deliver: telegram } }, { maxAttempts: 2 });
    await box.enqueue(notification());
    await box.drain(true); await box.drain(true); await box.drain(true);
    expect(hooks).toHaveBeenCalledTimes(2);
    expect(telegram).toHaveBeenCalledOnce();
    const [record] = await box.list();
    expect(record.failed).toEqual(['hooks']);
    expect(record.delivered).toEqual(['telegram']);
    expect(record.channelAttempts).toEqual({ inbox: 0, hooks: 2, telegram: 0 });
    expect(record.attempts).toBe(2);expect(record.nextAttemptAt).toBe(0);
    expect(record.lastError).toBe('Error');
    const restored = new NotificationOutbox(dir, { hooks: { deliver: hooks } });
    await restored.drain(true);expect(hooks).toHaveBeenCalledTimes(2);
  });

  it('rejects and preserves an unversioned prototype receipt instead of forgetting its failure ledger', async () => {
    const box = new NotificationOutbox(dir, {});
    const record: any = await box.enqueue(notification());
    delete record.version;delete record.failed;delete record.channelAttempts;
    record.attempts = 8;
    const [file] = await readdir(join(dir, 'outbox'));
    await writeFile(join(dir, 'outbox', file), JSON.stringify(record));
    const deliver = vi.fn();
    const restored = new NotificationOutbox(dir, { hooks: { deliver } });
    await expect(restored.drain(true)).rejects.toThrow('Invalid notification');
    expect(deliver).not.toHaveBeenCalled();
    expect(JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'outbox', file), 'utf8'))).toEqual(record);
  });

  it.each([9000, 999999])('honors a bounded channel Retry-After hint of %s ms', async hint => {
    const error = Object.assign(new Error('Transient receiver response'), { retryAfterMs: hint });
    const deliver = vi.fn().mockRejectedValue(error);
    const box = new NotificationOutbox(dir, { hooks: { deliver } });
    await box.enqueue(notification());
    const before = Date.now();
    await box.drain();
    const after = Date.now();
    const [record] = await box.list();
    expect(record.nextAttemptAt).toBeGreaterThanOrEqual(before + Math.min(hint, 10000));
    expect(record.nextAttemptAt).toBeLessThanOrEqual(after + Math.min(hint, 10000));
    await box.drain();expect(deliver).toHaveBeenCalledOnce();
  });
});
