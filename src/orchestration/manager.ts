// Orchestration manager - coordinates multi-host AI workflows

import { EventEmitter } from 'events';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { nanoid } from 'nanoid';
import { RemoteHost, RemoteClient, RemoteClientManager, RemotePromptResult } from './remote-client.js';
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
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private stats = {
    requests: { total: 0, successful: 0, failed: 0, failovers: 0 },
    pipelines: { total: 0, completed: 0, failed: 0, partial: 0 }
  };

  constructor(configDir: string) {
    super();
    this.configDir = configDir;
    this.configPath = `${configDir}/orchestration.json`;
    this.config = { ...DEFAULT_CONFIG };
    this.clientManager = new RemoteClientManager();
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
      this.stats.requests.failovers++;
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
    await mkdir(this.configDir, { recursive: true });

    if (!existsSync(this.configPath)) {
      await this.save();
      return;
    }

    try {
      const data = await readFile(this.configPath, 'utf-8');
      const loaded = JSON.parse(data) as Partial<OrchestrationConfig>;
      this.config = { ...DEFAULT_CONFIG, ...loaded };

      // Initialize hosts
      for (const host of this.config.hosts) {
        await this.addHost(host, false);
      }
    } catch {
      await this.save();
    }
  }

  async save(): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.configPath, JSON.stringify(this.config, null, 2));
  }

  // Host management
  async addHost(host: RemoteHost, persist = true): Promise<RemoteClient> {
    // Add to client manager
    const client = this.clientManager.addHost(host);

    // Set up health monitoring
    if (this.config.healthCheck.enabled) {
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
    await this.save();
    this.emit('host.toggled', { hostId, enabled });
    return true;
  }

  listHosts(): RemoteHost[] {
    return [...this.config.hosts];
  }

  getHostStatus(hostId: string): HealthMetrics | undefined {
    const metrics = this.healthMonitor.getAllMetrics();
    return metrics.find(m => m.hostId === hostId);
  }

  // Request execution with failover
  async sendPrompt(
    prompt: string,
    options?: {
      hostId?: string;
      sessionId?: string;
      timeout?: number;
      createSession?: boolean;
    }
  ): Promise<RemotePromptResult> {
    this.stats.requests.total++;

    try {
      const result = await this.failoverHandler.executeWithFailover(
        async (client) => {
          // Check circuit breaker
          const hostId = client.getStatus().id;
          const cb = this.circuitBreakers.get(hostId);

          if (cb) {
            return await cb.execute(async () => {
              let sessionId = options?.sessionId;

              if (!sessionId && options?.createSession !== false) {
                const session = await client.createSession();
                sessionId = session.id;
              }

              if (!sessionId) {
                throw new Error('No session available');
              }

              return await client.sendPrompt(sessionId, prompt, {
                timeout: options?.timeout
              });
            });
          }

          let sessionId = options?.sessionId;
          if (!sessionId && options?.createSession !== false) {
            const session = await client.createSession();
            sessionId = session.id;
          }

          if (!sessionId) {
            throw new Error('No session available');
          }

          return await client.sendPrompt(sessionId, prompt, {
            timeout: options?.timeout
          });
        },
        { preferredHost: options?.hostId }
      );

      this.stats.requests.successful++;
      return result.result;
    } catch (error) {
      this.stats.requests.failed++;
      throw error;
    }
  }

  // Pipeline execution
  async executePipeline(pipeline: PipelineDefinition): Promise<PipelineResult> {
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
    options?: { timeout?: number }
  ): Promise<RemotePromptResult> {
    this.stats.requests.total++;

    try {
      const result = await this.loadBalancer.executeBalanced(async (client) => {
        const session = await client.createSession();
        return await client.sendPrompt(session.id, prompt, options);
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
    this.stopHealthChecks();
    this.clientManager.stopAllHealthChecks();
    await this.save();
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
  return {
    id: nanoid(8),
    name: options?.name || new URL(url).hostname,
    url: url.replace(/\/$/, ''), // Remove trailing slash
    apiKey,
    enabled: options?.enabled ?? true,
    priority: options?.priority ?? 1,
    healthCheck: options?.healthCheck
  };
}
