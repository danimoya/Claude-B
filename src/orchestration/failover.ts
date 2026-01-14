// Failover and retry mechanisms for multi-host orchestration

import { EventEmitter } from 'events';
import { RemoteClient, RemoteClientManager, RemoteHostStatus, RemotePromptResult } from './remote-client.js';

export interface RetryConfig {
  maxRetries: number;
  initialDelay: number;    // Initial delay in ms
  maxDelay: number;        // Maximum delay in ms
  backoffMultiplier: number;
  jitter: boolean;         // Add randomness to delay
}

export interface FailoverConfig {
  strategy: 'priority' | 'round-robin' | 'least-latency' | 'random';
  maxAttempts: number;     // Max hosts to try
  timeout: number;         // Per-host timeout
  retry: RetryConfig;
}

const DEFAULT_RETRY: RetryConfig = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 30000,
  backoffMultiplier: 2,
  jitter: true
};

const DEFAULT_FAILOVER: FailoverConfig = {
  strategy: 'priority',
  maxAttempts: 3,
  timeout: 60000,
  retry: DEFAULT_RETRY
};

export class RetryHandler {
  private config: RetryConfig;

  constructor(config?: Partial<RetryConfig>) {
    this.config = { ...DEFAULT_RETRY, ...config };
  }

  async execute<T>(
    operation: () => Promise<T>,
    shouldRetry?: (error: unknown, attempt: number) => boolean
  ): Promise<T> {
    let lastError: unknown;
    let delay = this.config.initialDelay;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        // Check if we should retry
        if (attempt >= this.config.maxRetries) {
          break;
        }

        if (shouldRetry && !shouldRetry(error, attempt)) {
          break;
        }

        // Wait before retrying
        await this.wait(delay);

        // Calculate next delay with exponential backoff
        delay = Math.min(
          delay * this.config.backoffMultiplier,
          this.config.maxDelay
        );
      }
    }

    throw lastError;
  }

  private async wait(ms: number): Promise<void> {
    let delay = ms;
    if (this.config.jitter) {
      // Add 0-25% jitter
      delay = ms * (1 + Math.random() * 0.25);
    }
    return new Promise(resolve => setTimeout(resolve, delay));
  }
}

export class FailoverHandler extends EventEmitter {
  private clientManager: RemoteClientManager;
  private config: FailoverConfig;
  private roundRobinIndex = 0;

  constructor(clientManager: RemoteClientManager, config?: Partial<FailoverConfig>) {
    super();
    this.clientManager = clientManager;
    this.config = { ...DEFAULT_FAILOVER, ...config };
  }

  async executeWithFailover<T>(
    operation: (client: RemoteClient) => Promise<T>,
    options?: {
      preferredHost?: string;
      excludeHosts?: string[];
    }
  ): Promise<{ result: T; host: string; attempts: number }> {
    const hosts = this.selectHosts(options?.preferredHost, options?.excludeHosts);
    const maxAttempts = Math.min(hosts.length, this.config.maxAttempts);

    let lastError: unknown;
    let attempts = 0;

    for (let i = 0; i < maxAttempts; i++) {
      const host = hosts[i];
      const client = this.clientManager.getClient(host.id);

      if (!client) continue;

      attempts++;

      this.emit('attempt', {
        hostId: host.id,
        attempt: i + 1,
        maxAttempts
      });

      try {
        const retryHandler = new RetryHandler(this.config.retry);
        const result = await retryHandler.execute(
          () => operation(client),
          (error, attempt) => {
            this.emit('retry', {
              hostId: host.id,
              attempt: attempt + 1,
              error: error instanceof Error ? error.message : String(error)
            });
            return this.shouldRetry(error);
          }
        );

        this.emit('success', {
          hostId: host.id,
          attempts
        });

        return { result, host: host.id, attempts };
      } catch (error) {
        lastError = error;

        this.emit('host.failed', {
          hostId: host.id,
          error: error instanceof Error ? error.message : String(error),
          willTryNext: i < maxAttempts - 1
        });
      }
    }

    this.emit('all.failed', {
      attempts,
      lastError: lastError instanceof Error ? lastError.message : String(lastError)
    });

    throw lastError;
  }

  private selectHosts(
    preferredHost?: string,
    excludeHosts?: string[]
  ): RemoteHostStatus[] {
    let hosts = this.clientManager.getHealthyHosts()
      .filter(h => !excludeHosts?.includes(h.id));

    // Move preferred host to front if specified
    if (preferredHost) {
      const preferred = hosts.find(h => h.id === preferredHost);
      if (preferred) {
        hosts = [preferred, ...hosts.filter(h => h.id !== preferredHost)];
        return hosts;
      }
    }

    // Apply selection strategy
    switch (this.config.strategy) {
      case 'priority':
        return hosts.sort((a, b) => a.priority - b.priority);

      case 'round-robin':
        return this.rotateArray(hosts, this.roundRobinIndex++);

      case 'least-latency':
        return hosts.sort((a, b) => (a.latency || Infinity) - (b.latency || Infinity));

      case 'random':
        return this.shuffleArray(hosts);

      default:
        return hosts;
    }
  }

  private rotateArray<T>(arr: T[], index: number): T[] {
    if (arr.length === 0) return arr;
    const normalizedIndex = index % arr.length;
    return [...arr.slice(normalizedIndex), ...arr.slice(0, normalizedIndex)];
  }

  private shuffleArray<T>(arr: T[]): T[] {
    const result = [...arr];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  private shouldRetry(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Don't retry on auth errors
      if (message.includes('unauthorized') || message.includes('forbidden')) {
        return false;
      }

      // Don't retry on bad requests
      if (message.includes('bad request') || message.includes('invalid')) {
        return false;
      }

      // Retry on network/timeout errors
      if (
        message.includes('timeout') ||
        message.includes('network') ||
        message.includes('connection') ||
        message.includes('econnrefused') ||
        message.includes('enotfound')
      ) {
        return true;
      }

      // Retry on server errors (5xx)
      if (message.includes('500') || message.includes('502') ||
          message.includes('503') || message.includes('504')) {
        return true;
      }
    }

    return true; // Default to retry
  }
}

// Load balancer for distributing requests across hosts
export class LoadBalancer extends EventEmitter {
  private clientManager: RemoteClientManager;
  private strategy: 'round-robin' | 'least-connections' | 'least-latency' | 'random' | 'weighted';
  private roundRobinIndex = 0;
  private connectionCounts: Map<string, number> = new Map();
  private weights: Map<string, number> = new Map();

  constructor(
    clientManager: RemoteClientManager,
    strategy: 'round-robin' | 'least-connections' | 'least-latency' | 'random' | 'weighted' = 'round-robin'
  ) {
    super();
    this.clientManager = clientManager;
    this.strategy = strategy;
  }

  setWeight(hostId: string, weight: number): void {
    this.weights.set(hostId, weight);
  }

  getNextHost(): RemoteClient | undefined {
    const hosts = this.clientManager.getHealthyHosts();
    if (hosts.length === 0) return undefined;

    let selected: RemoteHostStatus | undefined;

    switch (this.strategy) {
      case 'round-robin':
        this.roundRobinIndex = this.roundRobinIndex % hosts.length;
        selected = hosts[this.roundRobinIndex];
        this.roundRobinIndex++;
        break;

      case 'least-connections':
        selected = hosts.reduce((min, host) => {
          const minConn = this.connectionCounts.get(min.id) || 0;
          const hostConn = this.connectionCounts.get(host.id) || 0;
          return hostConn < minConn ? host : min;
        });
        break;

      case 'least-latency':
        selected = hosts.reduce((min, host) => {
          return (host.latency || Infinity) < (min.latency || Infinity) ? host : min;
        });
        break;

      case 'random':
        selected = hosts[Math.floor(Math.random() * hosts.length)];
        break;

      case 'weighted':
        selected = this.selectWeighted(hosts);
        break;
    }

    if (!selected) return undefined;

    this.emit('host.selected', { hostId: selected.id, strategy: this.strategy });
    return this.clientManager.getClient(selected.id);
  }

  private selectWeighted(hosts: RemoteHostStatus[]): RemoteHostStatus | undefined {
    const totalWeight = hosts.reduce(
      (sum, h) => sum + (this.weights.get(h.id) || 1),
      0
    );

    let random = Math.random() * totalWeight;

    for (const host of hosts) {
      const weight = this.weights.get(host.id) || 1;
      random -= weight;
      if (random <= 0) {
        return host;
      }
    }

    return hosts[0];
  }

  incrementConnections(hostId: string): void {
    const current = this.connectionCounts.get(hostId) || 0;
    this.connectionCounts.set(hostId, current + 1);
  }

  decrementConnections(hostId: string): void {
    const current = this.connectionCounts.get(hostId) || 0;
    this.connectionCounts.set(hostId, Math.max(0, current - 1));
  }

  async executeBalanced<T>(operation: (client: RemoteClient) => Promise<T>): Promise<T> {
    const client = this.getNextHost();
    if (!client) {
      throw new Error('No healthy hosts available');
    }

    const hostId = client.getStatus().id;
    this.incrementConnections(hostId);

    try {
      return await operation(client);
    } finally {
      this.decrementConnections(hostId);
    }
  }
}

// Circuit breaker for protecting against cascading failures
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;    // Failures before opening
  successThreshold: number;    // Successes in half-open before closing
  timeout: number;             // Time in open state before half-open
  volumeThreshold: number;     // Minimum requests before evaluating
}

const DEFAULT_CIRCUIT: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  timeout: 30000,
  volumeThreshold: 10
};

export class CircuitBreaker extends EventEmitter {
  private state: CircuitState = 'closed';
  private failures = 0;
  private successes = 0;
  private requests = 0;
  private lastFailure?: Date;
  private config: CircuitBreakerConfig;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this.config = { ...DEFAULT_CIRCUIT, ...config };
  }

  getState(): CircuitState {
    // Check if we should transition from open to half-open
    if (this.state === 'open' && this.lastFailure) {
      const elapsed = Date.now() - this.lastFailure.getTime();
      if (elapsed >= this.config.timeout) {
        this.transitionTo('half-open');
      }
    }
    return this.state;
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.getState();

    if (state === 'open') {
      throw new Error('Circuit breaker is open');
    }

    this.requests++;

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.successes++;

    if (this.state === 'half-open') {
      if (this.successes >= this.config.successThreshold) {
        this.transitionTo('closed');
      }
    }
  }

  private onFailure(): void {
    this.failures++;
    this.successes = 0;
    this.lastFailure = new Date();

    if (this.state === 'half-open') {
      this.transitionTo('open');
    } else if (this.state === 'closed') {
      if (this.requests >= this.config.volumeThreshold &&
          this.failures >= this.config.failureThreshold) {
        this.transitionTo('open');
      }
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === 'closed') {
      this.failures = 0;
      this.successes = 0;
      this.requests = 0;
    }

    this.emit('state.change', { from: oldState, to: newState });
  }

  reset(): void {
    this.transitionTo('closed');
  }

  getStats(): {
    state: CircuitState;
    failures: number;
    successes: number;
    requests: number;
    lastFailure?: string;
  } {
    return {
      state: this.getState(),
      failures: this.failures,
      successes: this.successes,
      requests: this.requests,
      lastFailure: this.lastFailure?.toISOString()
    };
  }
}
