// Remote client for connecting to other Claude-B instances

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { RemoteReceiptStore, RemoteRequestError, type RemoteReceipt, type RemoteFailureKind } from './receipts.js';
import { validateTaskRecord } from '../jobs/validation.js';
import { isTerminalTask } from '../jobs/store.js';
import type { TaskRecord, TaskStatus } from '../jobs/types.js';
import { TaskConflictError } from '../jobs/types.js';

export interface RemoteHost {
  id: string;
  name: string;
  url: string;
  apiKey: string;
  enabled: boolean;
  priority: number;
  healthCheck?: {
    interval: number;
    timeout: number;
    unhealthyThreshold: number;
  };
}

export type PublicRemoteHost = Omit<RemoteHost, 'apiKey'>;

function publicUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return '[invalid remote URL]';
  }
}

/** Serialize host metadata without credentials, including legacy URL secrets. */
export function redactRemoteHost(host: RemoteHost): PublicRemoteHost {
  return {
    id: host.id, name: host.name, url: publicUrl(host.url), enabled: host.enabled,
    priority: host.priority, healthCheck: host.healthCheck ? { ...host.healthCheck } : undefined
  };
}

export interface RemoteHostStatus extends PublicRemoteHost {
  healthy: boolean;
  lastCheck?: string;
  lastError?: string;
  latency?: number;
  consecutiveFailures: number;
}

export interface RemoteSession {
  id: string;
  name?: string;
  status: string;
  host: string;
}

export interface RemotePromptResult {
  sessionId: string;
  promptId: string;
  status: 'completed' | 'error' | 'timeout' | 'accepted' | 'uncertain';
  taskId?: string;
  receiptId?: string;
  taskStatus?: TaskStatus;
  failureKind?: RemoteFailureKind;
  retrySafe?: boolean;
  output?: string;
  error?: string;
  host: string;
  latency: number;
}

export interface RemoteRequestOptions { timeout?: number; deadline?: number }
export interface RemoteSendOptions extends RemoteRequestOptions {
  taskId?: string;
  idempotencyKey?: string;
  waitForCompletion?: boolean;
  pollInterval?: number;
  strictTaskId?: boolean;
}

function requestBudget(options: RemoteRequestOptions = {}, lifetime?: AbortSignal) {
  const timeout = options.timeout ?? 30000;
  const deadline = options.deadline ?? Date.now() + timeout;
  const controller = new AbortController();
  const expired = new Error(`Remote request timed out after ${timeout}ms`);
  const remaining = deadline - Date.now();
  if (remaining <= 0) controller.abort(expired);
  const timer = remaining > 0 ? setTimeout(() => controller.abort(expired), remaining) : undefined;
  return { signal: lifetime ? AbortSignal.any([controller.signal, lifetime]) : controller.signal, deadline, dispose: () => clearTimeout(timer) };
}

async function pollDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); resolve(); };
    const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export type PublicRemoteHostStatus = RemoteHostStatus;

interface TokenCache {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class RemoteClient extends EventEmitter {
  private host: RemoteHost;
  private tokenCache: TokenCache | null = null;
  private status: RemoteHostStatus;
  private closed = false;
  private lifetime = new AbortController();

  constructor(host: RemoteHost, private readonly receipts = new RemoteReceiptStore()) {
    super();
    this.host = host;
    this.status = {
      ...redactRemoteHost(host),
      healthy: true,
      consecutiveFailures: 0
    };
  }

  getStatus(): RemoteHostStatus {
    let lastError = this.status.lastError;
    for (const secret of [this.host.apiKey, this.tokenCache?.accessToken, this.tokenCache?.refreshToken]) {
      if (secret && lastError) lastError = lastError.split(secret).join('[redacted]');
    }
    if (lastError) lastError = lastError.replace(/https?:\/\/[^\s]+/g, value => publicUrl(value));
    return { ...this.status, lastError, healthCheck: this.status.healthCheck ? { ...this.status.healthCheck } : undefined };
  }

  abortPendingRequests(): void {
    this.lifetime.abort(new RemoteRequestError('Remote client is closed', 'unavailable'));
    if (!this.closed) this.lifetime = new AbortController();
  }

  get abortSignal(): AbortSignal { return this.lifetime.signal; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.host.enabled = false;
    this.status.enabled = false;
    this.abortPendingRequests();
  }

  private async getToken(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    // Check if we have a valid cached token
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60000) {
      return this.tokenCache.accessToken;
    }

    // Try to refresh if we have a refresh token
    if (this.tokenCache?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(this.tokenCache.refreshToken, signal);
        if (refreshed) {
          return this.tokenCache.accessToken;
        }
      } catch {
        // A failed refresh may fall back to authentication only within the
        // same request budget. An expired deadline must not start more I/O.
        signal.throwIfAborted();
      }
    }

    // Get new token
    const response = await fetch(`${this.host.url}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.host.apiKey }),
      signal
    });

    if (!response.ok) {
      await response.body?.cancel();
      throw new RemoteRequestError(`Authentication failed: ${response.status}`, response.status === 401 || response.status === 403 ? 'auth' : 'unavailable');
    }

    const data = await response.json().catch(() => { throw new RemoteRequestError('Invalid authentication response', 'auth'); }) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in < 0) throw new RemoteRequestError('Invalid authentication response', 'auth');

    signal.throwIfAborted();
    this.tokenCache = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };

    return this.tokenCache.accessToken;
  }

  private async refreshToken(refreshToken: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const response = await fetch(`${this.host.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal
    });

    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }

    const data = await response.json().catch(() => { throw new RemoteRequestError('Invalid refresh response', 'auth'); }) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in < 0) throw new RemoteRequestError('Invalid refresh response', 'auth');

    signal.throwIfAborted();
    this.tokenCache = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };

    return true;
  }

  private sanitizeError(error: unknown): string {
    let message = error instanceof Error ? error.message : 'Remote request failed';
    for (const secret of [this.host.apiKey, this.tokenCache?.accessToken, this.tokenCache?.refreshToken]) {
      if (secret) message = message.split(secret).join('[redacted]');
    }
    return message.replace(/https?:\/\/[^\s]+/g, value => publicUrl(value));
  }

  private async request<T>(method: string, path: string, body?: unknown,
    options: RemoteRequestOptions & { signal?: AbortSignal; beforeDispatch?: () => Promise<void> } = {}): Promise<T> {
    if (this.closed) throw new RemoteRequestError('Remote client is closed', 'rejected');
    const budget = options.signal ? undefined : requestBudget(options);
    const signal = AbortSignal.any([options.signal || budget!.signal, this.lifetime.signal]);
    const start = Date.now();
    let dispatched = false;
    try {
      const token = await this.getToken(signal);
      signal.throwIfAborted();
      if (options.beforeDispatch) await options.beforeDispatch();
      signal.throwIfAborted();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      dispatched = true;
      const response = await fetch(`${this.host.url}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        const kind: RemoteFailureKind = response.status === 401 || response.status === 403 ? 'auth'
          : method === 'POST' && response.status >= 500 ? 'uncertain' : 'rejected';
        throw new RemoteRequestError(`HTTP ${response.status}`, kind, false);
      }
      const result = await response.json().catch(() => { throw new RemoteRequestError('Remote response was not valid JSON', method === 'POST' ? 'uncertain' : 'unavailable'); }) as T;
      signal.throwIfAborted();
      this.status.latency = Date.now() - start;
      this.status.healthy = true;
      this.status.consecutiveFailures = 0;
      this.status.lastError = undefined;
      this.status.lastCheck = new Date().toISOString();
      return result;
    } catch (error) {
      const actual = signal.aborted ? signal.reason : error;
      const causeCode = (error as { cause?: { code?: string } })?.cause?.code;
      const retrySafe = !dispatched && !signal.aborted && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(causeCode || '');
      const failure = error instanceof RemoteRequestError && !signal.aborted ? error : new RemoteRequestError(
        this.sanitizeError(actual), dispatched && method === 'POST' ? 'uncertain' : 'unavailable', retrySafe);
      this.status.consecutiveFailures++;
      this.status.lastError = this.sanitizeError(failure);
      this.status.lastCheck = new Date().toISOString();
      if (this.status.consecutiveFailures >= (this.host.healthCheck?.unhealthyThreshold || 3)) {
        this.status.healthy = false;
        this.emit('unhealthy', this.getStatus());
      }
      throw failure;
    } finally { budget?.dispose(); }
  }

  setEnabled(enabled: boolean): void { this.host.enabled = enabled; this.status.enabled = enabled; }

  // Health check
  async healthCheck(): Promise<{ status: string; sessions: number; latency: number }> {
    const start = Date.now();
    if (!this.host.enabled) throw new RemoteRequestError('Remote host is disabled', 'rejected');
    const result = await this.request<{ status: string; sessions: number }>(
      'GET', '/api/health', undefined, { timeout: this.host.healthCheck?.timeout }
    );
    return {
      ...result,
      latency: Date.now() - start
    };
  }

  // Session operations
  async listSessions(): Promise<RemoteSession[]> {
    const result = await this.request<{ sessions: RemoteSession[] }>('GET', '/api/sessions');
    return result.sessions.map(s => ({ ...s, host: this.host.id }));
  }

  async createSession(name?: string, options?: RemoteRequestOptions): Promise<RemoteSession> {
    if (!this.host.enabled) throw new RemoteRequestError('Remote host is disabled', 'rejected');
    const result = await this.request<RemoteSession>(
      'POST',
      '/api/sessions',
      name ? { name } : {}, options
    );
    return { ...result, host: this.host.id };
  }

  async getSession(sessionId: string): Promise<RemoteSession | null> {
    try {
      const result = await this.request<RemoteSession>(
        'GET',
        `/api/sessions/${sessionId}`
      );
      return { ...result, host: this.host.id };
    } catch {
      return null;
    }
  }

  async killSession(sessionId: string): Promise<boolean> {
    try {
      await this.request('DELETE', `/api/sessions/${sessionId}`);
      return true;
    } catch {
      return false;
    }
  }

  private resultFor(receipt: RemoteReceipt, start: number): RemotePromptResult {
    return {
      sessionId: receipt.sessionId, promptId: receipt.remoteTaskId || receipt.taskId,
      taskId: receipt.remoteTaskId || receipt.taskId, receiptId: receipt.id,
      status: receipt.status === 'completed' ? 'completed' : receipt.status === 'accepted' ? 'accepted'
        : receipt.status === 'uncertain' || receipt.status === 'submitting' ? 'uncertain' : 'error',
      taskStatus: receipt.taskStatus, output: receipt.output, error: receipt.error,
      failureKind: receipt.failureKind, retrySafe: receipt.retrySafe ?? false,
      host: receipt.hostId, latency: Date.now() - start,
    };
  }

  private async pollTask(receipt: RemoteReceipt, signal: AbortSignal, interval = 100, waitForCompletion = true): Promise<RemoteReceipt> {
    while (true) {
      signal.throwIfAborted();
      const id = receipt.remoteTaskId || receipt.taskId;
      const result = await this.request<{ task: TaskRecord }>('GET', `/api/tasks/${encodeURIComponent(id)}`, undefined, { signal });
      try { validateTaskRecord(result.task, id); }
      catch { throw new RemoteRequestError('Remote task response is invalid', 'unavailable'); }
      const task = result.task;
      if (isTerminalTask(task.status)) {
        return this.receipts.update(receipt.id, { status: task.status as 'completed' | 'error' | 'cancelled' | 'interrupted', taskStatus: task.status,
          submittedAt: receipt.submittedAt ?? task.createdAt,
          output: task.output, error: task.error ? this.sanitizeError(new Error(task.error)) : undefined,
          failureKind: task.status === 'completed' ? undefined : 'rejected', retrySafe: false });
      }
      receipt = await this.receipts.update(receipt.id, { status: 'accepted', taskStatus: task.status, submittedAt: receipt.submittedAt ?? task.createdAt, error: undefined, failureKind: undefined, retrySafe: false });
      if (!waitForCompletion) return receipt;
      await pollDelay(interval, signal);
    }
  }

  async sendPrompt(sessionId: string, prompt: string, options: RemoteSendOptions = {}): Promise<RemotePromptResult> {
    if (this.closed) throw new RemoteRequestError('Remote client is closed', 'rejected');
    const start = Date.now();
    const budget = requestBudget({ ...options, timeout: options.timeout ?? 300000 }, this.lifetime.signal);
    let taskId = options.taskId || randomUUID();
    let receipt: RemoteReceipt | undefined;
    let submitted = false;
    let accepted = false;
    try {
      const previous = options.idempotencyKey ? (await this.receipts.list()).find((receipt) => receipt.hostId === this.host.id && receipt.idempotencyKey === options.idempotencyKey) : undefined;
      if (!options.taskId && previous) taskId = previous.taskId;
      if (!this.host.enabled) throw new RemoteRequestError('Remote host is disabled', 'rejected');
      const prepared = await this.receipts.prepare({ taskId, hostId: this.host.id, sessionId, prompt, idempotencyKey: options.idempotencyKey || taskId, strictTaskId: options.strictTaskId ?? !!options.taskId });
      receipt = prepared.receipt;
      taskId = receipt.taskId;
      if (!prepared.created && receipt.submittedAt && receipt.status !== 'rejected') {
        if (options.waitForCompletion === false) return this.resultFor(receipt, start);
        return await this.resumeRemoteTask(receipt.id, { ...options, deadline: budget.deadline });
      }
      const result = await this.request<{ taskId?: string; promptId?: string; sessionId?: string; status: string; taskStatus?: TaskStatus; output?: string }>(
        'POST', `/api/sessions/${encodeURIComponent(sessionId)}/prompt`,
        { prompt, taskId, idempotencyKey: receipt.idempotencyKey },
        { signal: budget.signal, beforeDispatch: async () => {
          const claim = await this.receipts.claimSubmission(receipt!.id);
          receipt = claim.receipt;
          submitted = true;
          if (!claim.claimed) throw new RemoteRequestError('Submission is already in progress; resume the saved receipt', 'uncertain');
        } });
      if (result.status === 'completed') {
        receipt = await this.receipts.update(receipt.id, { status: 'completed', taskStatus: 'completed', remoteTaskId: result.taskId || result.promptId || taskId, output: result.output || '', error: undefined, retrySafe: false });
        return this.resultFor(receipt, start);
      }
      if (!['accepted', 'queued', 'pending', 'running'].includes(result.status)) throw new RemoteRequestError('Remote submission returned an unrecognized result', 'uncertain');
      accepted = true;
      receipt = await this.receipts.update(receipt.id, { status: 'accepted', taskStatus: result.taskStatus || 'pending', remoteTaskId: result.taskId || result.promptId || taskId, error: undefined, failureKind: undefined, retrySafe: false });
      if (options.waitForCompletion === false) return this.resultFor(receipt, start);
      receipt = await this.pollTask(receipt, budget.signal, options.pollInterval);
      return this.resultFor(receipt, start);
    } catch (error) {
      const actual = budget.signal.aborted ? budget.signal.reason : error;
      const failure = error instanceof RemoteRequestError && !budget.signal.aborted ? error : new RemoteRequestError(this.sanitizeError(actual), error instanceof TaskConflictError ? 'rejected' : submitted ? 'uncertain' : 'unavailable');
      const status = accepted ? 'accepted' : submitted && failure.failureKind !== 'auth' && failure.failureKind !== 'rejected' ? 'uncertain' : 'rejected';
      if (receipt) {
        if (!submitted) {
          const current = await this.receipts.get(receipt.id);
          if (current?.submittedAt && current.status !== 'rejected') return this.resultFor(current, start);
        }
        try { receipt = await this.receipts.update(receipt.id, { status, error: this.sanitizeError(failure), failureKind: failure.failureKind, retrySafe: failure.retrySafe }); }
        catch { receipt = { ...receipt, status, error: this.sanitizeError(failure), failureKind: failure.failureKind, retrySafe: false }; }
        return this.resultFor(receipt, start);
      }
      return { sessionId, promptId: taskId, taskId, status: 'error', error: this.sanitizeError(failure), host: this.host.id, latency: Date.now() - start, failureKind: failure.failureKind, retrySafe: failure.retrySafe };
    } finally { budget.dispose(); }
  }

  async resumeRemoteTask(receiptId: string, options: RemoteSendOptions = {}): Promise<RemotePromptResult> {
    if (this.closed) throw new RemoteRequestError('Remote client is closed', 'rejected');
    const start = Date.now();
    let receipt = await this.receipts.get(receiptId);
    if (!receipt || receipt.hostId !== this.host.id) throw new Error('Remote receipt not found on this host');
    if (['completed', 'error', 'cancelled', 'interrupted', 'rejected'].includes(receipt.status)) return this.resultFor(receipt, start);
    const budget = requestBudget({ ...options, timeout: options.timeout ?? 300000 }, this.lifetime.signal);
    try { receipt = await this.pollTask(receipt, budget.signal, options.pollInterval, options.waitForCompletion !== false); }
    catch (error) {
      const failure = budget.signal.aborted ? budget.signal.reason : error;
      receipt = await this.receipts.get(receipt.id) || receipt;
      const status = receipt.status === 'prepared' ? 'prepared' : receipt.status === 'accepted' ? 'accepted' : 'uncertain';
      receipt = await this.receipts.update(receipt.id, { status, error: this.sanitizeError(failure), failureKind: status === 'prepared' ? 'unavailable' : 'uncertain', retrySafe: false });
    } finally { budget.dispose(); }
    return this.resultFor(receipt, start);
  }

  async getLastOutput(sessionId: string): Promise<string | null> {
    try {
      const result = await this.request<{ output: string }>(
        'GET',
        `/api/sessions/${sessionId}/last`
      );
      return result.output;
    } catch {
      return null;
    }
  }

  // Hook operations
  async listHookEvents(): Promise<string[]> {
    const result = await this.request<{ events: string[] }>('GET', '/api/hooks/events');
    return result.events;
  }

  async getHookStats(): Promise<{
    shellHooks: number;
    webhooks: number;
    enabledShellHooks: number;
    enabledWebhooks: number;
    eventCount: number;
  }> {
    return this.request('GET', '/api/hooks/stats');
  }
}

// Remote client manager for multiple hosts
export class RemoteClientManager extends EventEmitter {
  private clients: Map<string, RemoteClient> = new Map();
  private healthCheckIntervals: Map<string, NodeJS.Timeout> = new Map();
  readonly receipts: RemoteReceiptStore;
  private closed = false;

  constructor(configDir?: string) { super(); this.receipts = new RemoteReceiptStore(configDir); }

  async listRemoteTasks(): Promise<RemoteReceipt[]> { return this.receipts.list(); }
  async getRemoteTask(id: string): Promise<RemoteReceipt | null> { return this.receipts.get(id); }
  async resumeRemoteTask(id: string, options?: RemoteSendOptions): Promise<RemotePromptResult> {
    if (this.closed) throw new RemoteRequestError('Remote client manager is closed', 'rejected');
    const receipt = await this.receipts.get(id);
    if (!receipt) throw new Error('Remote receipt not found');
    const client = this.clients.get(receipt.hostId);
    if (!client) throw new Error('Remote receipt host is not configured');
    return client.resumeRemoteTask(id, options);
  }

  setEnabled(hostId: string, enabled: boolean): boolean {
    if (this.closed) throw new RemoteRequestError('Remote client manager is closed', 'rejected');
    const client = this.clients.get(hostId);
    if (!client) return false;
    client.setEnabled(enabled);
    this.stopHealthCheck(hostId);
    const interval = client.getStatus().healthCheck?.interval;
    if (enabled && interval) this.startHealthCheck(hostId, interval);
    return true;
  }

  addHost(host: RemoteHost): RemoteClient {
    if (this.closed) throw new RemoteRequestError('Remote client manager is closed', 'rejected');
    this.stopHealthCheck(host.id);
    const client = new RemoteClient({ ...host }, this.receipts);

    client.on('unhealthy', (status: RemoteHostStatus) => {
      this.emit('host.unhealthy', status);
    });

    this.clients.set(host.id, client);

    // Start health checks if configured
    if (host.enabled && host.healthCheck?.interval) {
      this.startHealthCheck(host.id, host.healthCheck.interval);
    }

    return client;
  }

  removeHost(hostId: string): boolean {
    this.stopHealthCheck(hostId);
    this.clients.get(hostId)?.close();
    return this.clients.delete(hostId);
  }

  getClient(hostId: string): RemoteClient | undefined {
    return this.clients.get(hostId);
  }

  listHosts(): RemoteHostStatus[] {
    return Array.from(this.clients.values()).map(c => c.getStatus());
  }

  getHealthyHosts(): RemoteHostStatus[] {
    return this.listHosts().filter(h => h.healthy && h.enabled);
  }

  // Get host by priority (for load balancing/failover)
  getNextHealthyHost(): RemoteClient | undefined {
    const healthy = this.getHealthyHosts()
      .sort((a, b) => a.priority - b.priority);

    if (healthy.length === 0) return undefined;
    return this.clients.get(healthy[0].id);
  }

  private startHealthCheck(hostId: string, interval: number): void {
    const check = async () => {
      const client = this.clients.get(hostId);
      if (!client) return;

      try {
        const result = await client.healthCheck();
        this.emit('host.healthy', { hostId, ...result });
      } catch (error) {
        this.emit('host.check.failed', {
          hostId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };

    // Initial check
    check();

    // Schedule recurring checks
    const intervalId = setInterval(check, interval);
    this.healthCheckIntervals.set(hostId, intervalId);
  }

  private stopHealthCheck(hostId: string): void {
    const intervalId = this.healthCheckIntervals.get(hostId);
    if (intervalId) {
      clearInterval(intervalId);
      this.healthCheckIntervals.delete(hostId);
    }
  }

  stopAllHealthChecks(): void {
    for (const hostId of this.healthCheckIntervals.keys()) {
      this.stopHealthCheck(hostId);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopAllHealthChecks();
    for (const client of this.clients.values()) client.close();
  }
}
