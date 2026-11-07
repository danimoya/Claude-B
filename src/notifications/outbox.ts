import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { NotificationInput } from './inbox.js';
import { atomicWriteJson } from '../storage/atomic-json.js';

type Channel = 'inbox' | 'hooks' | 'telegram';
export interface DeliveryRecord {
  version: 1;
  id: string;
  eventId: string;
  timestamp: string;
  notification: NotificationInput;
  delivered: Channel[];
  skipped: Channel[];
  failed: Channel[];
  channelAttempts: Record<Channel, number>; // failed operational attempts; shutdown aborts do not consume budget
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
}
export interface DeliveryChannel {
  enabled?: () => boolean;
  deliver: (notification: NotificationInput, eventId: string, timestamp: string, signal: AbortSignal) => Promise<unknown>;
}

export class NotificationConflictError extends Error {
  readonly code = 'NOTIFICATION_CONFLICT';
  constructor() { super('Notification event ID is already used for different content'); this.name = 'NotificationConflictError'; }
}

function validNotification(value: unknown, id: string): value is NotificationInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.deliveryId !== id || typeof input.sessionId !== 'string' || !input.sessionId ||
      !['prompt.completed', 'prompt.error', 'remote.completed'].includes(input.type as string) ||
      (input.exitCode !== null && !Number.isSafeInteger(input.exitCode)) || typeof input.viewCommand !== 'string') return false;
  for (const key of ['promptId', 'sessionName', 'goal', 'resultPreview', 'resultFull', 'claudeSessionId', 'agent', 'transcriptPath']) {
    if (input[key] !== undefined && typeof input[key] !== 'string') return false;
  }
  for (const key of ['durationMs', 'costUsd']) {
    if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || (input[key] as number) < 0)) return false;
  }
  return true;
}

interface InFlightDelivery { controller: AbortController; operation: Promise<unknown> }
interface SharedOutboxState {
  chain: Promise<unknown>;
  draining: Promise<void> | null;
  inFlight: Map<string, InFlightDelivery>;
  stopVersion: number;
}
const sharedDirectories = new Map<string, SharedOutboxState>();

export interface OutboxOptions { channelTimeoutMs?: number; maxAttempts?: number }

class DeliveryTimeoutError extends Error {
  constructor() { super('Notification channel deadline exceeded'); this.name = 'DeliveryTimeoutError'; }
}
class DeliveryStoppedError extends Error {
  constructor() { super('Notification delivery stopped'); this.name = 'DeliveryStoppedError'; }
}

/** Durable at-least-once delivery with stable IDs and per-channel acknowledgments. */
export class NotificationOutbox {
  private directory: string;
  private shared: SharedOutboxState;
  private stopping = false;
  private readonly channelTimeoutMs: number;
  private readonly maxAttempts: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(configDir: string, private channels: Partial<Record<Channel, DeliveryChannel>>, options: OutboxOptions = {}) {
    this.directory = resolve(configDir, 'outbox');
    this.channelTimeoutMs = options.channelTimeoutMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 8;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 32) throw new Error('Invalid notification attempt budget');
    if (!Number.isSafeInteger(this.channelTimeoutMs) || this.channelTimeoutMs < 1 || this.channelTimeoutMs > 300_000) throw new Error('Invalid notification channel timeout');
    let shared = sharedDirectories.get(this.directory);
    if (!shared) {
      shared = { chain: Promise.resolve(), draining: null, inFlight: new Map(), stopVersion: 0 };
      sharedDirectories.set(this.directory, shared);
    }
    this.shared = shared;
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const next = this.shared.chain.then(action, action);
    this.shared.chain = next.catch(() => {});
    return next;
  }

  private path(id: string): string {
    return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`);
  }

  async enqueue(notification: NotificationInput, id = notification.deliveryId ?? `task:${notification.promptId}`): Promise<DeliveryRecord> {
    if (!id || id === 'task:undefined' || id.length > 512) throw new Error('Durable notification requires a stable delivery ID');
    const input = { ...notification, deliveryId: id };
    if (!validNotification(input, id)) throw new Error('Invalid notification content');
    return this.serialized(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      try {
        const existing = await this.read(this.path(id));
        const keys = new Set([...Object.keys(existing.notification), ...Object.keys(input)]);
        const prior = existing.notification as unknown as Record<string, unknown>;
        const next = input as unknown as Record<string, unknown>;
        if ([...keys].some(key => prior[key] !== next[key])) throw new NotificationConflictError();
        return existing;
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const record: DeliveryRecord = {
        version: 1, id, eventId: id, timestamp: new Date().toISOString(),
        notification: input,
        delivered: [], skipped: [], failed: [], channelAttempts: { inbox: 0, hooks: 0, telegram: 0 }, attempts: 0, nextAttemptAt: 0,
      };
      await atomicWriteJson(this.path(id), record);
      return record;
    });
  }

  private async read(path: string): Promise<DeliveryRecord> {
    const bytes = await readFile(path, 'utf8');
    let record: DeliveryRecord;
    try { record = JSON.parse(bytes) as DeliveryRecord; }
    catch { throw new Error('Invalid notification delivery receipt'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Invalid notification delivery receipt');
    if (record.version !== 1 || typeof record.id !== 'string' || !record.id || record.id.length > 512 ||
        this.path(record.id) !== path || record.eventId !== record.id || !validNotification(record.notification, record.id) ||
        !Array.isArray(record.delivered) || !Array.isArray(record.skipped) || !Array.isArray(record.failed) ||
        [...record.delivered, ...record.skipped, ...record.failed].some(value => !['inbox', 'hooks', 'telegram'].includes(value)) ||
        new Set([...record.delivered, ...record.skipped, ...record.failed]).size !== record.delivered.length + record.skipped.length + record.failed.length ||
        !record.channelAttempts || typeof record.channelAttempts !== 'object' || Array.isArray(record.channelAttempts) ||
        Object.keys(record.channelAttempts).length !== 3 ||
        Object.entries(record.channelAttempts).some(([name, count]) => !['inbox', 'hooks', 'telegram'].includes(name) || !Number.isSafeInteger(count) || count < 0) ||
        !Number.isSafeInteger(record.attempts) || record.attempts < 0 ||
        typeof record.timestamp !== 'string' || !Number.isFinite(Date.parse(record.timestamp)) ||
        (record.lastError !== undefined && (typeof record.lastError !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(record.lastError))) ||
        !Number.isSafeInteger(record.nextAttemptAt) || record.nextAttemptAt < 0) {
      throw new Error('Invalid notification delivery receipt');
    }
    return record;
  }

  async list(): Promise<DeliveryRecord[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: DeliveryRecord[] = [];
    for (const name of files) if (/^[a-f0-9]{64}\.json$/.test(name)) records.push(await this.read(join(this.directory, name)));
    return records.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
  }

  private async deliver(record: DeliveryRecord, name: Channel, channel: DeliveryChannel): Promise<void> {
    const key = `${record.id}\0${name}`;
    // A transport may ignore abort. Keep its guard until the actual operation
    // settles, even after the deadline made the drain/shutdown return.
    if (this.shared.inFlight.has(key)) throw new DeliveryTimeoutError();
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return channel.deliver(record.notification, record.eventId, record.timestamp, controller.signal);
    });
    const current = { controller, operation };
    this.shared.inFlight.set(key, current);
    const cleanup = () => {
      if (this.shared.inFlight.get(key) === current) this.shared.inFlight.delete(key);
    };
    void operation.then(cleanup, cleanup);
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(controller.signal.reason || new DeliveryStoppedError());
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DeliveryTimeoutError()), this.channelTimeoutMs);
    try {
      await Promise.race([operation, aborted]);
      controller.signal.throwIfAborted();
    } catch (error) {
      throw controller.signal.aborted ? controller.signal.reason : error;
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  private complete(record: DeliveryRecord): boolean {
    return record.delivered.length + record.skipped.length + record.failed.length === 3;
  }

  private normalizeCompletion(record: DeliveryRecord): boolean {
    if (!this.complete(record)) return false;
    let changed = false;
    if (record.nextAttemptAt !== 0) { record.nextAttemptAt = 0; changed = true; }
    if (record.failed.length === 0 && record.lastError !== undefined) { delete record.lastError; changed = true; }
    return changed;
  }

  private async acknowledge(id: string, name: Channel, outcome: 'delivered' | 'skipped' | 'failed'): Promise<void> {
    await this.serialized(async () => {
      const latest = await this.read(this.path(id));
      let changed = false;
      if (!latest.delivered.includes(name) && !latest.skipped.includes(name) && !latest.failed.includes(name)) {
        latest[outcome].push(name);
        if (outcome === 'failed') latest.lastError ||= 'DeliveryAttemptsExhausted';
        changed = true;
      }
      changed = this.normalizeCompletion(latest) || changed;
      if (changed) await atomicWriteJson(this.path(id), latest);
    });
  }

  async drain(force = false): Promise<void> {
    if (this.stopping) return;
    if (this.shared.draining) return this.shared.draining;
    const stopVersion = this.shared.stopVersion;
    const stopped = () => this.stopping || this.shared.stopVersion !== stopVersion;
    const operation = (async () => {
      // Network callbacks never hold the short, directory-shared disk chain.
      await this.shared.chain;
      for (const record of await this.list()) {
        if (stopped()) break;
        if (this.complete(record)) {
          if (record.nextAttemptAt !== 0 || (record.failed.length === 0 && record.lastError !== undefined)) await this.acknowledge(record.id, 'inbox', record.skipped.includes('inbox') ? 'skipped' : record.failed.includes('inbox') ? 'failed' : 'delivered');
          continue;
        }
        if (!force && record.nextAttemptAt > Date.now()) continue;
        const failures: Array<{ name: Channel; error: unknown }> = [];
        for (const name of ['inbox', 'hooks', 'telegram'] as const) {
          if (stopped()) break;
          if (record.delivered.includes(name) || record.skipped.includes(name) || record.failed.includes(name)) continue;
          if (this.shared.inFlight.has(`${record.id}\0${name}`)) continue;
          try {
            const channel = this.channels[name];
            if (!channel || (channel.enabled && !channel.enabled())) {
              await this.acknowledge(record.id, name, 'skipped');
              continue;
            }
            if (record.channelAttempts[name] >= this.maxAttempts) {
              await this.acknowledge(record.id, name, 'failed');
              continue;
            }
            await this.deliver(record, name, channel);
            await this.acknowledge(record.id, name, 'delivered');
          } catch (error) {
            if (!(error instanceof DeliveryStoppedError)) failures.push({ name, error });
          }
        }
        if (failures.length) {
          await this.serialized(async () => {
            const latest = await this.read(this.path(record.id));
            let counted = false;
            for (const { name, error } of failures) {
              // An ack rename may have succeeded before its directory fsync
              // failed. Reflush that receipt instead of also failing the same
              // channel and creating an inconsistent/overlapping ledger.
              if (latest.delivered.includes(name) || latest.skipped.includes(name) || latest.failed.includes(name)) continue;
              counted = true;
              latest.channelAttempts[name]++;
              const permanent = !!error && typeof error === 'object' && (error as { retryable?: unknown }).retryable === false;
              if ((permanent || latest.channelAttempts[name] >= this.maxAttempts) && !latest.failed.includes(name)) latest.failed.push(name);
              latest.lastError = error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(error.name) ? error.name : 'DeliveryError';
            }
            if (counted) latest.attempts++;
            const pending = (['inbox', 'hooks', 'telegram'] as const).filter(name => !latest.delivered.includes(name) && !latest.skipped.includes(name) && !latest.failed.includes(name));
            const count = Math.max(1, ...pending.map(name => latest.channelAttempts[name]));
            const hints = failures.flatMap(({ name, error }) => {
              if (!pending.includes(name) || !error || typeof error !== 'object') return [];
              const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
              return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? [Math.min(10_000, Math.ceil(value))] : [];
            });
            const backoff = Math.min(60_000, 1000 * 2 ** Math.min(count - 1, 6));
            latest.nextAttemptAt = pending.length ? Date.now() + Math.max(backoff, ...hints) : 0;
            this.normalizeCompletion(latest);
            await atomicWriteJson(this.path(record.id), latest);
          });
        }
      }
    })();
    const completed = operation.finally(() => {
      if (this.shared.draining === completed) this.shared.draining = null;
    });
    this.shared.draining = completed;
    return completed;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => { void this.drain().catch(() => {}); }, 1000);
    this.timer.unref();
    void this.drain().catch(() => {});
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    this.shared.stopVersion++;
    for (const current of this.shared.inFlight.values()) current.controller.abort(new DeliveryStoppedError());
    await this.shared.draining;
    await this.shared.chain;
  }
}
