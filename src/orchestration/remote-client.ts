// Remote client for connecting to other Claude-B instances

import { EventEmitter } from 'events';

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

export interface RemoteHostStatus extends RemoteHost {
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
  status: 'completed' | 'error' | 'timeout';
  output?: string;
  error?: string;
  host: string;
  latency: number;
}

interface TokenCache {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class RemoteClient extends EventEmitter {
  private host: RemoteHost;
  private tokenCache: TokenCache | null = null;
  private status: RemoteHostStatus;

  constructor(host: RemoteHost) {
    super();
    this.host = host;
    this.status = {
      ...host,
      healthy: true,
      consecutiveFailures: 0
    };
  }

  getStatus(): RemoteHostStatus {
    return { ...this.status };
  }

  private async getToken(): Promise<string> {
    // Check if we have a valid cached token
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60000) {
      return this.tokenCache.accessToken;
    }

    // Try to refresh if we have a refresh token
    if (this.tokenCache?.refreshToken) {
      try {
        const refreshed = await this.refreshToken(this.tokenCache.refreshToken);
        if (refreshed) {
          return this.tokenCache.accessToken;
        }
      } catch {
        // Fall through to get new token
      }
    }

    // Get new token
    const response = await fetch(`${this.host.url}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: this.host.apiKey })
    });

    if (!response.ok) {
      throw new Error(`Authentication failed: ${response.status}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokenCache = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };

    return this.tokenCache.accessToken;
  }

  private async refreshToken(refreshToken: string): Promise<boolean> {
    const response = await fetch(`${this.host.url}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });

    if (!response.ok) {
      return false;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    this.tokenCache = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in * 1000)
    };

    return true;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: { timeout?: number }
  ): Promise<T> {
    const token = await this.getToken();
    const timeout = options?.timeout || 30000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const start = Date.now();
      const response = await fetch(`${this.host.url}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const latency = Date.now() - start;
      this.status.latency = latency;
      this.status.healthy = true;
      this.status.consecutiveFailures = 0;
      this.status.lastCheck = new Date().toISOString();

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`HTTP ${response.status}: ${error}`);
      }

      return await response.json() as T;
    } catch (error) {
      this.status.consecutiveFailures++;
      this.status.lastError = error instanceof Error ? error.message : String(error);
      this.status.lastCheck = new Date().toISOString();

      const threshold = this.host.healthCheck?.unhealthyThreshold || 3;
      if (this.status.consecutiveFailures >= threshold) {
        this.status.healthy = false;
        this.emit('unhealthy', this.status);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Health check
  async healthCheck(): Promise<{ status: string; sessions: number; latency: number }> {
    const start = Date.now();
    const result = await this.request<{ status: string; sessions: number }>('GET', '/api/health');
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

  async createSession(name?: string): Promise<RemoteSession> {
    const result = await this.request<{ session: RemoteSession }>(
      'POST',
      '/api/sessions',
      name ? { name } : undefined
    );
    return { ...result.session, host: this.host.id };
  }

  async getSession(sessionId: string): Promise<RemoteSession | null> {
    try {
      const result = await this.request<{ session: RemoteSession }>(
        'GET',
        `/api/sessions/${sessionId}`
      );
      return { ...result.session, host: this.host.id };
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

  // Prompt operations
  async sendPrompt(
    sessionId: string,
    prompt: string,
    options?: { timeout?: number }
  ): Promise<RemotePromptResult> {
    const start = Date.now();
    try {
      const result = await this.request<{
        promptId: string;
        status: string;
        output?: string;
      }>(
        'POST',
        `/api/sessions/${sessionId}/prompt`,
        { prompt },
        { timeout: options?.timeout || 300000 }
      );

      return {
        sessionId,
        promptId: result.promptId,
        status: result.status === 'completed' ? 'completed' : 'error',
        output: result.output,
        host: this.host.id,
        latency: Date.now() - start
      };
    } catch (error) {
      return {
        sessionId,
        promptId: '',
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        host: this.host.id,
        latency: Date.now() - start
      };
    }
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

  addHost(host: RemoteHost): RemoteClient {
    const client = new RemoteClient(host);

    client.on('unhealthy', (status: RemoteHostStatus) => {
      this.emit('host.unhealthy', status);
    });

    this.clients.set(host.id, client);

    // Start health checks if configured
    if (host.healthCheck?.interval) {
      this.startHealthCheck(host.id, host.healthCheck.interval);
    }

    return client;
  }

  removeHost(hostId: string): boolean {
    this.stopHealthCheck(hostId);
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
}
