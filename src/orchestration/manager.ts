// Orchestration manager - coordinates multi-host AI workflows

import { EventEmitter } from 'events';
import { readFile, mkdir, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { nanoid } from 'nanoid';
import { randomUUID } from 'crypto';
import { atomicWriteJson } from '../storage/atomic-json.js';
import { RemoteRequestError, type RemoteReceipt } from './receipts.js';
import type { RemoteSendOptions } from './remote-client.js';
import { TaskConflictError } from '../jobs/types.js';
import { RemoteHost, PublicRemoteHost, redactRemoteHost, RemoteClient, RemoteClientManager, RemotePromptResult } from './remote-client.js';
import { PipelineExecutor, PipelineDefinition, PipelineResult } from './pipeline.js';
import { HealthMonitor, AggregateHealthMonitor, HealthMetrics } from './health.js';
import { FailoverHandler, LoadBalancer, CircuitBreaker, CircuitState, FailoverConfig } from './failover.js';

export interface OrchestrationConfig {
  hosts: RemoteHost[];
  failover: Partial<FailoverConfig>;
  loadBalancing: 'round-robin' | 'least-connections' | 'least-latency' | 'random' | 'weighted';
  healthCheck: {
    enabled: boolean;
    interval: number;
    timeout: number;
  };
  circuitBreaker: {
    enabled: boolean;
    failureThreshold: number;
    timeout: number;
  };
}

const DEFAULT_CONFIG: OrchestrationConfig = {
  hosts: [],
  failover: {
    strategy: 'priority',
    maxAttempts: 3
  },
  loadBalancing: 'round-robin',
  healthCheck: {
    enabled: true,
    interval: 30000,
    timeout: 5000
  },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,
    timeout: 30000
  }
};

export interface OrchestrationStats {
  hosts: {
    total: number;
    healthy: number;
    unhealthy: number;
  };
  requests: {
    total: number;
    successful: number;
    failed: number;
    failovers: number;
  };
  pipelines: {
    total: number;
    completed: number;
    failed: number;
    partial: number;
  };
  circuitBreakers: Map<string, { state: CircuitState; failures: number }>;
}

export class OrchestrationManager extends EventEmitter {
  private configDir: string;
  private configPath: string;
  private config: OrchestrationConfig;
  private clientManager: RemoteClientManager;
  private healthMonitor: AggregateHealthMonitor;
  private failoverHandler: FailoverHandler;
  private loadBalancer: LoadBalancer;
  private pipelineExecutor: PipelineExecutor;
  private loadFailure: Error | null = null;
  private closing = false;
  private shutdownOperation: Promise<void> | null = null;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private stats = {
    requests: { total: 0, successful: 0, failed: 0, failovers: 0 },
    pipelines: { total: 0, completed: 0, failed: 0, partial: 0 }
  };

  constructor(configDir: string) {
    super();
    this.configDir = configDir;
    this.configPath = `${configDir}/orchestration.json`;
    this.config = structuredClone(DEFAULT_CONFIG);
    this.clientManager = new RemoteClientManager(configDir);
    this.healthMonitor = new AggregateHealthMonitor();
    this.failoverHandler = new FailoverHandler(this.clientManager);
    this.loadBalancer = new LoadBalancer(this.clientManager);
    this.pipelineExecutor = new PipelineExecutor(this.clientManager);

    this.setupEventForwarding();
  }

  private setupEventForwarding(): void {
    // Forward health events
    this.healthMonitor.on('host.healthy', (metrics) => this.emit('host.healthy', metrics));
    this.healthMonitor.on('host.unhealthy', (metrics) => this.emit('host.unhealthy', metrics));
    this.healthMonitor.on('alert.low_availability', (data) => this.emit('alert.low_availability', data));

    // Forward failover events
    this.failoverHandler.on('attempt', (data) => this.emit('failover.attempt', data));
    this.failoverHandler.on('host.failed', (data) => {
      if (data.willTryNext) this.stats.requests.failovers++;
      this.emit('failover.host_failed', data);
    });
    this.failoverHandler.on('success', (data) => this.emit('failover.success', data));
    this.failoverHandler.on('all.failed', (data) => this.emit('failover.all_failed', data));

    // Forward pipeline events
    this.pipelineExecutor.on('pipeline.start', (data) => this.emit('pipeline.start', data));
    this.pipelineExecutor.on('pipeline.complete', (data) => this.emit('pipeline.complete', data));
    this.pipelineExecutor.on('step.complete', (data) => this.emit('pipeline.step_complete', data));
    this.pipelineExecutor.on('step.error', (data) => this.emit('pipeline.step_error', data));

    // Forward load balancer events
    this.loadBalancer.on('host.selected', (data) => this.emit('lb.host_selected', data));
  }

  async load(): Promise<void> {
    if (this.closing) throw new Error('Orchestration manager is closed');
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });

    if (!existsSync(this.configPath)) {
      await this.save();
      return;
    }

    try {
      await chmod(this.configPath, 0o600);
      const data = await readFile(this.configPath, 'utf-8');
      const loaded = JSON.parse(data) as Partial<OrchestrationConfig>;
      this.config = { ...structuredClone(DEFAULT_CONFIG), ...loaded };
      if (!Array.isArray(this.config.hosts)) throw new Error('Invalid remote host configuration');
      this.loadFailure = null;

      // Initialize hosts
      for (const host of this.config.hosts) {
        await this.addHost(host, false);
      }
    } catch {
      this.loadFailure = new Error('Cannot load orchestration configuration; existing file was preserved');
      throw this.loadFailure;
    }
  }

  async save(): Promise<void> {
    if (this.loadFailure) throw this.loadFailure;
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await atomicWriteJson(this.configPath, this.config);
  }

  // Host management
  async addHost(host: RemoteHost, persist = true): Promise<RemoteClient> {
    if (this.closing) throw new Error('Orchestration manager is closed');
    // Add to client manager
    const client = this.clientManager.addHost(host);

    // Set up health monitoring
    if (host.enabled && this.config.healthCheck.enabled) {
      const monitor = new HealthMonitor(client, {
        interval: this.config.healthCheck.interval,
        timeout: this.config.healthCheck.timeout
      });
      this.healthMonitor.addMonitor(host.id, monitor);
      monitor.start();
    }

    // Set up circuit breaker
    if (this.config.circuitBreaker.enabled) {
      const cb = new CircuitBreaker({
        failureThreshold: this.config.circuitBreaker.failureThreshold,
        timeout: this.config.circuitBreaker.timeout
      });
      cb.on('state.change', (data) => {
        this.emit('circuit.state_change', { hostId: host.id, ...data });
      });
      this.circuitBreakers.set(host.id, cb);
    }

    // Set load balancer weight
    if (host.priority) {
      this.loadBalancer.setWeight(host.id, 10 - host.priority);
    }

    // Persist config
    if (persist) {
      if (!this.config.hosts.find(h => h.id === host.id)) {
        this.config.hosts.push(host);
      }
      await this.save();
    }

    this.emit('host.added', { hostId: host.id, name: host.name });
    return client;
  }

  async removeHost(hostId: string): Promise<boolean> {
    this.healthMonitor.removeMonitor(hostId);
    this.circuitBreakers.delete(hostId);
    const removed = this.clientManager.removeHost(hostId);

    if (removed) {
      this.config.hosts = this.config.hosts.filter(h => h.id !== hostId);
      await this.save();
      this.emit('host.removed', { hostId });
    }

    return removed;
  }

  async toggleHost(hostId: string, enabled: boolean): Promise<boolean> {
    const host = this.config.hosts.find(h => h.id === hostId);
    if (!host) return false;

    host.enabled = enabled;
    this.clientManager.setEnabled(hostId, enabled);
    this.healthMonitor.removeMonitor(hostId);
    if (enabled && this.config.healthCheck.enabled) {
      const client = this.clientManager.getClient(hostId)!;
      const monitor = new HealthMonitor(client, { interval: this.config.healthCheck.interval, timeout: this.config.healthCheck.timeout });
      this.healthMonitor.addMonitor(hostId, monitor);
      monitor.start();
    }
    await this.save();
    this.emit('host.toggled', { hostId, enabled });
    return true;
  }

  listHosts(): PublicRemoteHost[] {
    return this.config.hosts.map(redactRemoteHost);
  }

  getHostStatus(hostId: string): HealthMetrics | undefined {
    const metrics = this.healthMonitor.getAllMetrics();
    return metrics.find(m => m.hostId === hostId);
  }

  async listRemoteTasks(): Promise<RemoteReceipt[]> { return this.clientManager.listRemoteTasks(); }
  async getRemoteTask(id: string): Promise<RemoteReceipt | null> { return this.clientManager.getRemoteTask(id); }
  async resumeRemoteTask(id: string, options?: RemoteSendOptions): Promise<RemotePromptResult> {
    if (this.closing) throw new Error('Orchestration manager is closed');
    return this.clientManager.resumeRemoteTask(id, options);
  }

  // Retry/failover is authorized only by an explicit pre-submission-safe error.
  async sendPrompt(prompt: string, options: RemoteSendOptions & { hostId?: string; sessionId?: string; createSession?: boolean } = {}): Promise<RemotePromptResult> {
    if (this.closing) throw new Error('Orchestration manager is closed');
    this.stats.requests.total++;
    const timeout = options.timeout ?? 300000;
    const deadline = options.deadline ?? Date.now() + timeout;
    const receipts = options.idempotencyKey || options.taskId ? await this.listRemoteTasks() : [];
    const matches = receipts.filter(receipt => (options.idempotencyKey && receipt.idempotencyKey === options.idempotencyKey) || (options.taskId && receipt.taskId === options.taskId));
    const existing = matches.find(receipt => receipt.submittedAt && receipt.status !== 'rejected') || matches[0];
    if (existing) {
      const requestedHost = options.hostId ? this.config.hosts.find(host => host.id === options.hostId || host.name === options.hostId) : undefined;
      if (existing.prompt !== prompt || (options.taskId && options.taskId !== existing.taskId) ||
          (options.idempotencyKey && options.idempotencyKey !== existing.idempotencyKey) ||
          (options.sessionId && options.sessionId !== existing.sessionId) ||
          (options.hostId && requestedHost?.id !== existing.hostId)) throw new TaskConflictError();
      if (matches.some(receipt => receipt.taskId !== existing.taskId || receipt.idempotencyKey !== existing.idempotencyKey || receipt.prompt !== existing.prompt)) throw new TaskConflictError();
    }
    if (existing?.submittedAt && existing.status !== 'rejected') return this.resumeRemoteTask(existing.id, { ...options, timeout, deadline });
    const taskId = options.taskId || existing?.taskId || randomUUID();
    const sessions = new Map<string, string>();
    try {
      const delivered = await this.failoverHandler.executeWithFailover(async (client) => {
        const hostId = client.getStatus().id;
        const operation = async () => {
          let sessionId = options.sessionId || sessions.get(hostId) || (existing?.hostId === hostId ? existing.sessionId : undefined);
          if (!sessionId && options.createSession !== false) {
            sessionId = (await client.createSession(undefined, { timeout, deadline })).id;
            sessions.set(hostId, sessionId);
          }
          if (!sessionId) throw new RemoteRequestError('No session available', 'rejected');
          const result = await client.sendPrompt(sessionId, prompt, { ...options, timeout, deadline, taskId, strictTaskId: !!options.taskId, idempotencyKey: options.idempotencyKey || taskId });
          if (result.status === 'error' && result.retrySafe) throw new RemoteRequestError(result.error || 'Remote host unavailable', result.failureKind || 'unavailable', true);
          return result;
        };
        const breaker = this.circuitBreakers.get(hostId);
        return breaker ? breaker.execute(operation) : operation();
      }, { preferredHost: options.hostId || existing?.hostId, deadline });
      if (delivered.result.status === 'completed') this.stats.requests.successful++;
      else if (delivered.result.status === 'error') this.stats.requests.failed++;
      return delivered.result;
    } catch (error) { this.stats.requests.failed++; throw error; }
  }

  // Pipeline execution
  async executePipeline(pipeline: PipelineDefinition): Promise<PipelineResult> {
    if (this.closing) throw new Error('Orchestration manager is closed');
    this.stats.pipelines.total++;

    const result = await this.pipelineExecutor.execute(pipeline);

    switch (result.status) {
      case 'completed':
        this.stats.pipelines.completed++;
        break;
      case 'error':
        this.stats.pipelines.failed++;
        break;
      case 'partial':
        this.stats.pipelines.partial++;
        break;
    }

    return result;
  }

  // Load-balanced execution
  async sendPromptBalanced(
    prompt: string,
    options: RemoteSendOptions = {}
  ): Promise<RemotePromptResult> {
    if (this.closing) throw new Error('Orchestration manager is closed');
    this.stats.requests.total++;
    const timeout = options.timeout ?? 300000;
    const deadline = options.deadline ?? Date.now() + timeout;

    try {
      const result = await this.loadBalancer.executeBalanced(async (client) => {
        const session = await client.createSession(undefined, { timeout, deadline });
        return await client.sendPrompt(session.id, prompt, { ...options, timeout, deadline });
      });

      this.stats.requests.successful++;
      return result;
    } catch (error) {
      this.stats.requests.failed++;
      throw error;
    }
  }

  // Health and status
  getHealthStatus(): {
    overall: { healthy: boolean; healthyPercentage: number };
    hosts: HealthMetrics[];
  } {
    const overall = this.healthMonitor.getOverallStatus();
    const hosts = this.healthMonitor.getAllMetrics();

    return {
      overall: {
        healthy: overall.healthy,
        healthyPercentage: overall.healthyPercentage
      },
      hosts
    };
  }

  getStats(): OrchestrationStats {
    const hosts = this.healthMonitor.getOverallStatus();
    const circuitBreakers = new Map<string, { state: CircuitState; failures: number }>();

    for (const [hostId, cb] of this.circuitBreakers) {
      const stats = cb.getStats();
      circuitBreakers.set(hostId, { state: stats.state, failures: stats.failures });
    }

    return {
      hosts: {
        total: hosts.totalCount,
        healthy: hosts.healthyCount,
        unhealthy: hosts.totalCount - hosts.healthyCount
      },
      requests: { ...this.stats.requests },
      pipelines: { ...this.stats.pipelines },
      circuitBreakers
    };
  }

  // Lifecycle
  startHealthChecks(): void {
    this.healthMonitor.startAll();
  }

  stopHealthChecks(): void {
    this.healthMonitor.stopAll();
  }

  async shutdown(): Promise<void> {
    if (this.shutdownOperation) return this.shutdownOperation;
    this.closing = true;
    this.stopHealthChecks();
    this.clientManager.close();
    this.shutdownOperation = this.save();
    return this.shutdownOperation;
  }
}

// Factory function for creating a host configuration
export function createHost(
  url: string,
  apiKey: string,
  options?: {
    name?: string;
    priority?: number;
    enabled?: boolean;
    healthCheck?: {
      interval?: number;
      timeout?: number;
      unhealthyThreshold?: number;
    };
  }
): RemoteHost {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Remote URL must use HTTP(S) without embedded credentials, query or fragment');
  }
  const hc = options?.healthCheck;
  return {
    id: nanoid(8),
    name: options?.name || new URL(url).hostname,
    url: url.replace(/\/$/, ''), // Remove trailing slash
    apiKey,
    enabled: options?.enabled ?? true,
    priority: options?.priority ?? 1,
    healthCheck: hc
      ? {
          interval: hc.interval ?? 30000,
          timeout: hc.timeout ?? 5000,
          unhealthyThreshold: hc.unhealthyThreshold ?? 3,
        }
      : undefined,
  };
}
