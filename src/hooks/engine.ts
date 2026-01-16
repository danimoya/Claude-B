// Hook engine - manages hooks and dispatches events

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { nanoid } from 'nanoid';
import { HookEvent, HookEventType, createEvent, HookEventPayload } from './events.js';
import { ShellHook, ShellHookResult, executeShellHook } from './shell-hooks.js';
import { Webhook, WebhookResult, executeWebhook } from './webhooks.js';

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
    await mkdir(this.configDir, { recursive: true });

    if (!existsSync(this.configPath)) {
      await this.save();
      return;
    }

    try {
      const data = await readFile(this.configPath, 'utf-8');
      const config: HookConfig = JSON.parse(data);

      for (const hook of config.shellHooks || []) {
        this.shellHooks.set(hook.id, hook);
      }

      for (const webhook of config.webhooks || []) {
        this.webhooks.set(webhook.id, webhook);
      }
    } catch {
      // Start fresh if config is corrupted
      await this.save();
    }
  }

  async save(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });

    const config: HookConfig = {
      shellHooks: Array.from(this.shellHooks.values()),
      webhooks: Array.from(this.webhooks.values())
    };

    await writeFile(this.configPath, JSON.stringify(config, null, 2));
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

  // Event dispatching
  async dispatch<T extends HookEventType>(
    type: T,
    payload: HookEventPayload[T]
  ): Promise<HookExecutionResult> {
    const event = createEvent(type, payload);

    // Store in history
    this.eventHistory.push(event);
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Emit for local listeners
    this.emit('event', event);
    this.emit(type, event);

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
      Promise.all(matchingShellHooks.map(hook => executeShellHook(hook, event))),
      Promise.all(matchingWebhooks.map(webhook => executeWebhook(webhook, event)))
    ]);

    const result: HookExecutionResult = {
      event,
      shellResults,
      webhookResults
    };

    // Emit execution result
    this.emit('execution', result);

    // Log any failures
    for (const sr of shellResults) {
      if (!sr.success) {
        this.emit('hook.error', { type: 'shell', hookId: sr.hookId, error: sr.stderr });
      }
    }

    for (const wr of webhookResults) {
      if (!wr.success) {
        this.emit('hook.error', { type: 'webhook', hookId: wr.webhookId, error: wr.response });
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
