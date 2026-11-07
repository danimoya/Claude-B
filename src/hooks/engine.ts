// Hook engine - manages hooks and dispatches events

import { EventEmitter } from 'events';
import { readFile, mkdir, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { nanoid } from 'nanoid';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { atomicWriteJson } from '../storage/atomic-json.js';
import { HookEvent, HookEventType, createEvent, HookEventPayload } from './events.js';
import { ShellHook, ShellHookResult, executeShellHook } from './shell-hooks.js';
import { Webhook, WebhookResult, executeWebhook } from './webhooks.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
const eventLocks = new Map<string, Promise<unknown>>();
const subscriberFlights = new Map<string, { fingerprint: string; operation: Promise<unknown> }>();

interface HookConfig {
  shellHooks: ShellHook[];
  webhooks: Webhook[];
}

export interface HookExecutionResult {
  event: HookEvent;
  shellResults: ShellHookResult[];
  webhookResults: WebhookResult[];
}

export class HookEngine extends EventEmitter {
  private configDir: string;
  private configPath: string;
  private shellHooks: Map<string, ShellHook> = new Map();
  private webhooks: Map<string, Webhook> = new Map();
  private eventHistory: HookEvent[] = [];
  private maxHistorySize = 1000;

  constructor(configDir: string) {
    super();
    this.configDir = configDir;
    this.configPath = `${configDir}/hooks.json`;
  }

  async load(): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });

    if (!existsSync(this.configPath)) {
      await this.save();
      return;
    }

    try {
      await chmod(this.configPath, 0o600);
      const data = await readFile(this.configPath, 'utf-8');
      const config: HookConfig = JSON.parse(data);

      for (const hook of config.shellHooks || []) {
        this.shellHooks.set(hook.id, hook);
      }

      for (const webhook of config.webhooks || []) {
        this.webhooks.set(webhook.id, webhook);
      }
    } catch {
      throw new Error('Hook configuration is invalid or unreadable; existing file was preserved');
    }
  }

  async save(): Promise<void> {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });

    const config: HookConfig = {
      shellHooks: Array.from(this.shellHooks.values()),
      webhooks: Array.from(this.webhooks.values())
    };

    await atomicWriteJson(this.configPath, config);
  }

  // Shell hook management
  async addShellHook(
    event: HookEventType | '*',
    command: string,
    options?: { timeout?: number; sessionFilter?: string }
  ): Promise<ShellHook> {
    const hook: ShellHook = {
      id: nanoid(8),
      event,
      command,
      timeout: options?.timeout,
      sessionFilter: options?.sessionFilter,
      enabled: true,
      createdAt: new Date().toISOString()
    };

    this.shellHooks.set(hook.id, hook);
    await this.save();
    return hook;
  }

  async removeShellHook(id: string): Promise<boolean> {
    const deleted = this.shellHooks.delete(id);
    if (deleted) {
      await this.save();
    }
    return deleted;
  }

  async toggleShellHook(id: string, enabled: boolean): Promise<ShellHook | null> {
    const hook = this.shellHooks.get(id);
    if (!hook) return null;

    hook.enabled = enabled;
    await this.save();
    return hook;
  }

  listShellHooks(): ShellHook[] {
    return Array.from(this.shellHooks.values());
  }

  getShellHook(id: string): ShellHook | undefined {
    return this.shellHooks.get(id);
  }

  // Webhook management
  async addWebhook(
    event: HookEventType | '*',
    url: string,
    options?: {
      method?: 'POST' | 'PUT';
      headers?: Record<string, string>;
      timeout?: number;
      retries?: number;
      secret?: string;
      transform?: string;
      sessionFilter?: string;
    }
  ): Promise<Webhook> {
    const webhook: Webhook = {
      id: nanoid(8),
      event,
      url,
      method: options?.method,
      headers: options?.headers,
      timeout: options?.timeout,
      retries: options?.retries,
      secret: options?.secret,
      transform: options?.transform,
      sessionFilter: options?.sessionFilter,
      enabled: true,
      createdAt: new Date().toISOString()
    };

    this.webhooks.set(webhook.id, webhook);
    await this.save();
    return webhook;
  }

  async removeWebhook(id: string): Promise<boolean> {
    const deleted = this.webhooks.delete(id);
    if (deleted) {
      await this.save();
    }
    return deleted;
  }

  async toggleWebhook(id: string, enabled: boolean): Promise<Webhook | null> {
    const webhook = this.webhooks.get(id);
    if (!webhook) return null;

    webhook.enabled = enabled;
    await this.save();
    return webhook;
  }

  listWebhooks(): Webhook[] {
    return Array.from(this.webhooks.values());
  }

  getWebhook(id: string): Webhook | undefined {
    return this.webhooks.get(id);
  }

  private emitSafely(name: string, data: unknown): void {
    for (const listener of this.rawListeners(name)) {
      try { Promise.resolve(listener.call(this, data)).catch(() => {}); }
      catch { /* observer errors cannot suppress durable delivery */ }
    }
  }

  private async ensureEventReceipt(event: HookEvent, fingerprint: string): Promise<void> {
    const path = join(resolve(this.configDir), 'hook-deliveries', `${digest(event.id)}.event.json`);
    const previous = eventLocks.get(path) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      try {
        const prior = JSON.parse(await readFile(path, 'utf8')) as { version?: number; id?: string; fingerprint?: string };
        if (prior.version !== 1 || prior.id !== event.id || prior.fingerprint !== fingerprint) throw new Error('Hook event ID conflicts with a stored event');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await atomicWriteJson(path, { version: 1, id: event.id, fingerprint });
      }
    });
    eventLocks.set(path, operation);
    try { await operation; }
    finally { if (eventLocks.get(path) === operation) eventLocks.delete(path); }
  }

  private async deliverSubscriber<T extends { success: boolean; retryable?: boolean; retryAfterMs?: number }>(kind: 'shell' | 'webhook', id: string,
    event: HookEvent, fingerprint: string, execute: () => Promise<T>, acknowledged: T,
    maxAttempts?: number, signal?: AbortSignal): Promise<T> {
    const path = join(resolve(this.configDir), 'hook-deliveries', `${digest([event.id, kind, id])}.subscriber.json`);
    const current = subscriberFlights.get(path);
    if (current) {
      if (current.fingerprint !== fingerprint) throw new Error('Hook delivery ID conflicts with a stored event');
      return await current.operation as T;
    }
    const terminalFailure = (statusCode?: number | null, exitCode?: number | null): T => ({
      ...acknowledged, success: false, retryable: false,
      ...(kind === 'webhook' ? { statusCode: statusCode ?? null, response: 'Terminal subscriber failure previously recorded' }
        : { exitCode: exitCode ?? null, stderr: 'Terminal shell failure previously recorded' })
    } as T);
    const operation = (async () => {
      let attempts = 0;
      try {
        const receipt = JSON.parse(await readFile(path, 'utf8')) as { version?: number; eventId?: string; fingerprint?: string;
          kind?: string; subscriberId?: string; success?: boolean; retryable?: boolean; attempts?: number;
          statusCode?: number | null; exitCode?: number | null; completedAt?: string; updatedAt?: string };
        const date = receipt.completedAt || receipt.updatedAt;
        if (receipt.version !== 1 || receipt.eventId !== event.id || receipt.fingerprint !== fingerprint ||
            receipt.kind !== kind || receipt.subscriberId !== id || typeof receipt.success !== 'boolean' ||
            (!receipt.success && typeof receipt.retryable !== 'boolean') ||
            (receipt.statusCode !== undefined && receipt.statusCode !== null && (!Number.isSafeInteger(receipt.statusCode) || receipt.statusCode < 100 || receipt.statusCode > 599)) ||
            (receipt.exitCode !== undefined && receipt.exitCode !== null && !Number.isSafeInteger(receipt.exitCode)) ||
            (receipt.attempts !== undefined && (!Number.isSafeInteger(receipt.attempts) || receipt.attempts < 0 || receipt.attempts > 6)) ||
            typeof date !== 'string' || !Number.isFinite(Date.parse(date))) throw new Error('Invalid hook subscriber receipt');
        if (receipt.success) return acknowledged;
        if (receipt.retryable === false) return terminalFailure(receipt.statusCode, receipt.exitCode);
        if (kind !== 'webhook' || maxAttempts === undefined || receipt.attempts === undefined) throw new Error('Invalid hook retry receipt');
        attempts = receipt.attempts;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const identity = { version: 1, eventId: event.id, fingerprint, kind, subscriberId: id };
      if (maxAttempts !== undefined) {
        signal?.throwIfAborted();
        if (attempts >= maxAttempts) {
          await atomicWriteJson(path, { ...identity, success: false, retryable: false, attempts,
            completedAt: new Date().toISOString() });
          return terminalFailure();
        }
        // Count intent durably before network I/O. A crash can leave an
        // ambiguous attempt; never exceed the configured total after restart.
        attempts++;
        await atomicWriteJson(path, { ...identity, success: false, retryable: true, attempts,
          updatedAt: new Date().toISOString() });
        if (signal?.aborted) {
          // This process knows no request started, so it can restore the budget.
          await atomicWriteJson(path, { ...identity, success: false, retryable: true, attempts: attempts - 1,
            updatedAt: new Date().toISOString() });
          signal.throwIfAborted();
        }
      }
      let result = await execute();
      if (!result.success && maxAttempts !== undefined) {
        result = { ...result, retryable: result.retryable !== false && attempts < maxAttempts,
          retryAfterMs: Math.min(10000, Math.max(result.retryAfterMs || 0, 1000 * 2 ** Math.max(0, attempts - 1))) };
      }
      if (result.success || result.retryable === false || maxAttempts !== undefined) {
        try {
          await atomicWriteJson(path, { ...identity, success: result.success, retryable: result.retryable,
            ...(maxAttempts !== undefined ? { attempts } : {}),
            ...('statusCode' in result ? { statusCode: result.statusCode } : {}),
            ...('exitCode' in result ? { exitCode: result.exitCode } : {}),
            completedAt: new Date().toISOString() });
        } catch (error) {
          if (kind === 'shell') {
            // The script may already have committed non-idempotent effects.
            // A known acknowledgment failure requires operator reconciliation.
            const failure = new Error('Shell delivery outcome could not be recorded') as Error & { retryable: boolean };
            failure.retryable = false;
            throw failure;
          }
          throw error;
        }
      }
      return result;
    })();
    subscriberFlights.set(path, { fingerprint, operation });
    try { return await operation; }
    finally { if (subscriberFlights.get(path)?.operation === operation) subscriberFlights.delete(path); }
  }

  // Event dispatching
  async dispatch<T extends HookEventType>(
    type: T,
    payload: HookEventPayload[T],
    metadata?: { id?: string; timestamp?: string; signal?: AbortSignal }
  ): Promise<HookExecutionResult> {
    const event = createEvent(type, payload);
    if (metadata?.id) event.id = metadata.id;
    if (metadata?.timestamp) event.timestamp = metadata.timestamp;
    metadata?.signal?.throwIfAborted();
    const fingerprint = digest(event);
    if (metadata?.id) {
      if (metadata.id.length > 512 || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('Invalid hook event metadata');
      await this.ensureEventReceipt(event, fingerprint);
    }

    // Store in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Emit for local listeners
    this.emitSafely('event', event);
    this.emitSafely(type, event);

    // Extract sessionId from payload if present
    const payloadSessionId = (payload as Record<string, unknown>).sessionId as string | undefined;

    // Find matching hooks (check event type and optional sessionFilter)
    const matchingShellHooks = Array.from(this.shellHooks.values()).filter(hook => {
      if (!hook.enabled) return false;
      if (hook.event !== type && hook.event !== '*') return false;
      // If hook has sessionFilter, only match if sessionId matches
      if (hook.sessionFilter && hook.sessionFilter !== payloadSessionId) return false;
      return true;
    });

    const matchingWebhooks = Array.from(this.webhooks.values()).filter(webhook => {
      if (!webhook.enabled) return false;
      if (webhook.event !== type && webhook.event !== '*') return false;
      // If webhook has sessionFilter, only match if sessionId matches
      if (webhook.sessionFilter && webhook.sessionFilter !== payloadSessionId) return false;
      return true;
    });

    // Execute hooks in parallel
    const [shellResults, webhookResults] = await Promise.all([
      Promise.all(matchingShellHooks.map(async hook => {
        const acknowledged: ShellHookResult = { hookId: hook.id, success: true, exitCode: 0, stdout: '', stderr: '', duration: 0 };
        const execute = () => executeShellHook(hook, event, metadata?.signal);
        try { return metadata?.id ? await this.deliverSubscriber('shell', hook.id, event, fingerprint, execute, acknowledged) : await execute(); }
        catch (error) { return { ...acknowledged, success: false,
          retryable: error && typeof error === 'object' && 'retryable' in error && error.retryable === false ? false : undefined,
          exitCode: null, stderr: 'Hook execution or receipt persistence failed' }; }
      })),
      Promise.all(matchingWebhooks.map(async webhook => {
        const acknowledged: WebhookResult = { webhookId: webhook.id, success: true, statusCode: 200, response: 'Previously acknowledged', duration: 0, retryCount: 0 };
        const requested = webhook.retries ?? 2;
        const maxAttempts = (Number.isFinite(requested) ? Math.max(0, Math.min(5, Math.floor(requested))) : 2) + 1;
        const execute = () => executeWebhook(metadata?.id ? { ...webhook, retries: 0 } : webhook, event, metadata?.signal);
        try { return metadata?.id ? await this.deliverSubscriber('webhook', webhook.id, event, fingerprint, execute, acknowledged, maxAttempts, metadata.signal) : await execute(); }
        catch { return { ...acknowledged, success: false, statusCode: null, response: 'Webhook execution or receipt persistence failed' }; }
      }))
    ]);

    const result: HookExecutionResult = {
      event,
      shellResults,
      webhookResults
    };

    // Emit execution result
    this.emitSafely('execution', result);

    // Log any failures
    for (const sr of shellResults) {
      if (!sr.success) {
        this.emitSafely('hook.error', { type: 'shell', hookId: sr.hookId, error: sr.stderr });
      }
    }

    for (const wr of webhookResults) {
      if (!wr.success) {
        this.emitSafely('hook.error', { type: 'webhook', hookId: wr.webhookId, error: wr.response });
      }
    }

    return result;
  }

  // Event history
  getEventHistory(limit?: number): HookEvent[] {
    const history = [...this.eventHistory].reverse();
    return limit ? history.slice(0, limit) : history;
  }

  getEventsByType(type: HookEventType, limit?: number): HookEvent[] {
    const events = this.eventHistory.filter(e => e.type === type).reverse();
    return limit ? events.slice(0, limit) : events;
  }

  clearHistory(): void {
    this.eventHistory = [];
  }

  // Statistics
  getStats(): {
    shellHooks: number;
    webhooks: number;
    enabledShellHooks: number;
    enabledWebhooks: number;
    eventCount: number;
  } {
    return {
      shellHooks: this.shellHooks.size,
      webhooks: this.webhooks.size,
      enabledShellHooks: Array.from(this.shellHooks.values()).filter(h => h.enabled).length,
      enabledWebhooks: Array.from(this.webhooks.values()).filter(w => w.enabled).length,
      eventCount: this.eventHistory.length
    };
  }
}
