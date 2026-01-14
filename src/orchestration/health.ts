// Health monitoring for remote Claude-B instances

import { EventEmitter } from 'events';
import { RemoteClient, RemoteHostStatus } from './remote-client.js';

export interface HealthCheckConfig {
  interval: number;        // Check interval in ms
  timeout: number;         // Request timeout in ms
  unhealthyThreshold: number;  // Failures before marking unhealthy
  healthyThreshold: number;    // Successes before marking healthy again
}

export interface HealthMetrics {
  hostId: string;
  healthy: boolean;
  uptime: number;           // Percentage uptime
  avgLatency: number;       // Average latency in ms
  p99Latency: number;       // 99th percentile latency
  successRate: number;      // Percentage of successful checks
  totalChecks: number;
  successfulChecks: number;
  failedChecks: number;
  lastCheck?: string;
  lastError?: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

interface HealthHistory {
  timestamp: string;
  success: boolean;
  latency?: number;
  error?: string;
}

const DEFAULT_CONFIG: HealthCheckConfig = {
  interval: 30000,        // 30 seconds
  timeout: 5000,          // 5 seconds
  unhealthyThreshold: 3,  // 3 failures = unhealthy
  healthyThreshold: 2     // 2 successes = healthy again
};

export class HealthMonitor extends EventEmitter {
  private client: RemoteClient;
  private config: HealthCheckConfig;
  private history: HealthHistory[] = [];
  private maxHistorySize = 1000;
  private intervalId?: NodeJS.Timeout;
  private isHealthy = true;
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private startTime: number;

  constructor(client: RemoteClient, config?: Partial<HealthCheckConfig>) {
    super();
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.startTime = Date.now();
  }

  start(): void {
    if (this.intervalId) return;

    // Initial check
    this.check();

    // Schedule recurring checks
    this.intervalId = setInterval(() => this.check(), this.config.interval);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async check(): Promise<boolean> {
    const timestamp = new Date().toISOString();

    try {
      const result = await this.client.healthCheck();

      this.consecutiveSuccesses++;
      this.consecutiveFailures = 0;

      const entry: HealthHistory = {
        timestamp,
        success: true,
        latency: result.latency
      };
      this.addHistory(entry);

      // Check if we should transition to healthy
      if (!this.isHealthy && this.consecutiveSuccesses >= this.config.healthyThreshold) {
        this.isHealthy = true;
        this.emit('healthy', this.getMetrics());
      }

      this.emit('check.success', {
        hostId: this.client.getStatus().id,
        latency: result.latency,
        sessions: result.sessions
      });

      return true;
    } catch (error) {
      this.consecutiveFailures++;
      this.consecutiveSuccesses = 0;

      const errorMessage = error instanceof Error ? error.message : String(error);
      const entry: HealthHistory = {
        timestamp,
        success: false,
        error: errorMessage
      };
      this.addHistory(entry);

      // Check if we should transition to unhealthy
      if (this.isHealthy && this.consecutiveFailures >= this.config.unhealthyThreshold) {
        this.isHealthy = false;
        this.emit('unhealthy', this.getMetrics());
      }

      this.emit('check.failed', {
        hostId: this.client.getStatus().id,
        error: errorMessage,
        consecutiveFailures: this.consecutiveFailures
      });

      return false;
    }
  }

  private addHistory(entry: HealthHistory): void {
    this.history.push(entry);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }
  }

  getMetrics(): HealthMetrics {
    const status = this.client.getStatus();
    const successfulChecks = this.history.filter(h => h.success).length;
    const totalChecks = this.history.length;
    const latencies = this.history
      .filter(h => h.success && h.latency !== undefined)
      .map(h => h.latency!);

    // Calculate average latency
    const avgLatency = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    // Calculate P99 latency
    const p99Latency = latencies.length > 0
      ? this.calculatePercentile(latencies, 99)
      : 0;

    // Calculate uptime (based on health state transitions)
    const uptime = totalChecks > 0
      ? (successfulChecks / totalChecks) * 100
      : 100;

    // Calculate success rate
    const successRate = totalChecks > 0
      ? (successfulChecks / totalChecks) * 100
      : 100;

    const lastEntry = this.history[this.history.length - 1];

    return {
      hostId: status.id,
      healthy: this.isHealthy,
      uptime,
      avgLatency,
      p99Latency,
      successRate,
      totalChecks,
      successfulChecks,
      failedChecks: totalChecks - successfulChecks,
      lastCheck: lastEntry?.timestamp,
      lastError: lastEntry?.success ? undefined : lastEntry?.error,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses
    };
  }

  private calculatePercentile(values: number[], percentile: number): number {
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  }

  getHistory(limit?: number): HealthHistory[] {
    const history = [...this.history].reverse();
    return limit ? history.slice(0, limit) : history;
  }

  isCurrentlyHealthy(): boolean {
    return this.isHealthy;
  }
}

// Aggregate health monitor for multiple hosts
export class AggregateHealthMonitor extends EventEmitter {
  private monitors: Map<string, HealthMonitor> = new Map();
  private alertThreshold: number;

  constructor(alertThreshold = 50) {
    super();
    this.alertThreshold = alertThreshold; // Alert if less than this % of hosts are healthy
  }

  addMonitor(hostId: string, monitor: HealthMonitor): void {
    monitor.on('healthy', (metrics) => {
      this.emit('host.healthy', metrics);
      this.checkOverallHealth();
    });

    monitor.on('unhealthy', (metrics) => {
      this.emit('host.unhealthy', metrics);
      this.checkOverallHealth();
    });

    monitor.on('check.success', (data) => this.emit('check.success', data));
    monitor.on('check.failed', (data) => this.emit('check.failed', data));

    this.monitors.set(hostId, monitor);
  }

  removeMonitor(hostId: string): void {
    const monitor = this.monitors.get(hostId);
    if (monitor) {
      monitor.stop();
      this.monitors.delete(hostId);
    }
  }

  startAll(): void {
    for (const monitor of this.monitors.values()) {
      monitor.start();
    }
  }

  stopAll(): void {
    for (const monitor of this.monitors.values()) {
      monitor.stop();
    }
  }

  private checkOverallHealth(): void {
    const metrics = this.getAllMetrics();
    const healthyCount = metrics.filter(m => m.healthy).length;
    const totalCount = metrics.length;
    const healthyPercentage = totalCount > 0 ? (healthyCount / totalCount) * 100 : 100;

    if (healthyPercentage < this.alertThreshold) {
      this.emit('alert.low_availability', {
        healthyCount,
        totalCount,
        healthyPercentage,
        unhealthyHosts: metrics.filter(m => !m.healthy).map(m => m.hostId)
      });
    }
  }

  getAllMetrics(): HealthMetrics[] {
    return Array.from(this.monitors.values()).map(m => m.getMetrics());
  }

  getHealthyHosts(): string[] {
    return Array.from(this.monitors.entries())
      .filter(([, m]) => m.isCurrentlyHealthy())
      .map(([id]) => id);
  }

  getUnhealthyHosts(): string[] {
    return Array.from(this.monitors.entries())
      .filter(([, m]) => !m.isCurrentlyHealthy())
      .map(([id]) => id);
  }

  getOverallStatus(): {
    healthy: boolean;
    healthyCount: number;
    totalCount: number;
    healthyPercentage: number;
  } {
    const metrics = this.getAllMetrics();
    const healthyCount = metrics.filter(m => m.healthy).length;
    const totalCount = metrics.length;
    const healthyPercentage = totalCount > 0 ? (healthyCount / totalCount) * 100 : 100;

    return {
      healthy: healthyPercentage >= this.alertThreshold,
      healthyCount,
      totalCount,
      healthyPercentage
    };
  }
}
