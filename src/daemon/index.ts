import { createServer, Server, Socket } from 'net';
import { homedir } from 'os';
import { mkdir, writeFile, unlink, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { nanoid } from 'nanoid';
import { SessionManager } from './session-manager.js';
import { RestServer } from '../rest/server.js';
import { HookEngine } from '../hooks/engine.js';
import { HookEventType } from '../hooks/events.js';
import { OrchestrationManager, createHost } from '../orchestration/index.js';
import { NotificationInbox, NotificationInput } from '../notifications/inbox.js';

interface DaemonConfig {
  socketPath: string;
  pidFile: string;
  logFile: string;
  configDir: string;
}

interface RestConfig {
  host: string;
  port: number;
}

class Daemon {
  private server: Server | null = null;
  private config: DaemonConfig;
  private sessionManager: SessionManager;
  private hookEngine: HookEngine;
  private orchestrationManager: OrchestrationManager;
  private notificationInbox: NotificationInbox;
  private clients: Set<Socket> = new Set();
  private startTime: number = Date.now();
  private restServer: RestServer | null = null;
  private restConfig: RestConfig = {
    host: process.env.REST_HOST || '127.0.0.1',
    port: parseInt(process.env.REST_PORT || '3847', 10)
  };

  constructor() {
    const configDir = `${homedir()}/.claude-b`;
    this.config = {
      socketPath: `${configDir}/daemon.sock`,
      pidFile: `${configDir}/daemon.pid`,
      logFile: `${configDir}/daemon.log`,
      configDir
    };
    this.sessionManager = new SessionManager(configDir);
    this.hookEngine = new HookEngine(configDir);
    this.orchestrationManager = new OrchestrationManager(configDir);
    this.notificationInbox = new NotificationInbox(configDir);
  }

  async start(): Promise<void> {
    // Ensure config directory exists
    await mkdir(this.config.configDir, { recursive: true });

    // Check if daemon is already running
    if (existsSync(this.config.pidFile)) {
      const pid = parseInt(await readFile(this.config.pidFile, 'utf-8'), 10);
      try {
        process.kill(pid, 0); // Check if process exists
        console.error(`Daemon already running (PID: ${pid})`);
        process.exit(1);
      } catch {
        // Process doesn't exist, clean up stale files
        await this.cleanup();
      }
    }

    // Clean up old socket
    if (existsSync(this.config.socketPath)) {
      await unlink(this.config.socketPath);
    }

    // Write PID file
    await writeFile(this.config.pidFile, process.pid.toString());

    // Load sessions, hooks, and orchestration
    await this.sessionManager.load();
    await this.hookEngine.load();
    await this.orchestrationManager.load();
    this.orchestrationManager.startHealthChecks();

    // Create server
    this.server = createServer((socket) => this.handleConnection(socket));

    this.server.listen(this.config.socketPath, () => {
      this.log(`Daemon started on ${this.config.socketPath}`);
      // Dispatch daemon.started hook
      this.hookEngine.dispatch('daemon.started', { pid: process.pid }).catch(() => {});
    });

    // Handle shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      this.log(`Uncaught exception: ${error.message}`);
    });
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    this.log(`Client connected (total: ${this.clients.size})`);

    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line);
          const response = await this.handleMessage(message, socket);
          socket.write(JSON.stringify({ ...response, id: message.id }) + '\n');
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          socket.write(JSON.stringify({ error: errorMessage }) + '\n');
        }
      }
    });

    socket.on('close', () => {
      // Detach from session if attached
      const attachedSession = this.sessionManager.getAttachedSession(socket);
      if (attachedSession) {
        attachedSession.detach(socket);
        this.sessionManager.unregisterAttachment(socket);
      }
      this.clients.delete(socket);
      this.log(`Client disconnected (total: ${this.clients.size})`);
    });

    socket.on('error', (error) => {
      this.log(`Socket error: ${error.message}`);
      this.clients.delete(socket);
    });
  }

  private async handleMessage(
    message: { method: string; params?: Record<string, unknown> },
    socket: Socket
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    const { method, params } = message;

    switch (method) {
      case 'daemon.status':
        return this.getStatus();

      case 'session.list':
        return { data: { sessions: this.sessionManager.list() } };

      case 'session.create':
        return this.createSession(params?.name as string | undefined, params?.model as string | undefined);

      case 'session.kill':
        return this.killSession(params?.sessionId as string);

      case 'session.select':
        return this.selectSession(params?.sessionId as string);

      case 'session.current':
        return this.getCurrentSession();

      case 'session.last':
        return this.getLastOutput();

      case 'session.attach':
        return this.attachSession(params?.sessionId as string, socket);

      case 'session.detach':
        return this.detachSession(socket);

      case 'session.watch':
        return this.watchSession(socket);

      case 'session.unwatch':
        return this.unwatchSession(socket);

      case 'prompt.send':
        return this.sendPrompt(params?.prompt as string);

      case 'stdin':
        return this.handleStdin(params?.data as string, socket);

      case 'rest.start':
        return this.startRest(params?.port as number | undefined, params?.host as string | undefined);

      case 'rest.stop':
        return this.stopRest();

      case 'rest.status':
        return this.getRestStatus();

      case 'rest.apikey':
        return this.getRestApiKey();

      // Hook management
      case 'hook.shell.add':
        return this.addShellHook(
          params?.event as HookEventType | '*',
          params?.command as string,
          params?.timeout as number | undefined,
          params?.sessionFilter as string | undefined
        );

      case 'hook.shell.remove':
        return this.removeShellHook(params?.id as string);

      case 'hook.shell.list':
        return { data: { hooks: this.hookEngine.listShellHooks() } };

      case 'hook.shell.toggle':
        return this.toggleShellHook(params?.id as string, params?.enabled as boolean);

      case 'hook.webhook.add':
        return this.addWebhook(
          params?.event as HookEventType | '*',
          params?.url as string,
          params as Record<string, unknown>
        );

      case 'hook.webhook.remove':
        return this.removeWebhook(params?.id as string);

      case 'hook.webhook.list':
        return { data: { webhooks: this.hookEngine.listWebhooks() } };

      case 'hook.webhook.toggle':
        return this.toggleWebhook(params?.id as string, params?.enabled as boolean);

      case 'hook.events':
        return { data: { events: this.hookEngine.getEventHistory(params?.limit as number | undefined) } };

      case 'hook.stats':
        return { data: this.hookEngine.getStats() };

      // Orchestration management
      case 'orchestration.host.add':
        return this.addRemoteHost(params as {
          url: string;
          apiKey: string;
          name?: string;
          priority?: number;
        });

      case 'orchestration.host.remove':
        return this.removeRemoteHost(params?.hostId as string);

      case 'orchestration.host.toggle':
        return this.toggleRemoteHost(params?.hostId as string, params?.enabled as boolean);

      case 'orchestration.host.list':
        return { data: { hosts: this.orchestrationManager.listHosts() } };

      case 'orchestration.health':
        return { data: this.orchestrationManager.getHealthStatus() };

      case 'orchestration.stats':
        return this.getOrchestrationStats();

      case 'orchestration.prompt':
        return this.sendRemotePrompt(
          params?.prompt as string,
          params?.hostId as string | undefined,
          params?.sessionId as string | undefined
        );

      // Notification inbox
      case 'notification.list':
        return this.listNotifications(params?.unreadOnly as boolean | undefined);

      case 'notification.count':
        return this.getNotificationCount();

      case 'notification.clear':
        return this.clearNotifications();

      // Fire-and-forget
      case 'prompt.fire':
        return this.fireAndForget(
          params?.prompt as string,
          params?.name as string | undefined,
          params?.goal as string | undefined,
          params?.model as string | undefined
        );

      case 'orchestration.fire':
        return this.fireRemotePrompt(
          params?.prompt as string,
          params?.hostId as string | undefined,
          params?.goal as string | undefined
        );

      default:
        return { error: `Unknown method: ${method}` };
    }
  }

  private getStatus(): { data: Record<string, unknown> } {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;

    const memUsage = process.memoryUsage();
    const memoryMB = Math.round(memUsage.heapUsed / 1024 / 1024);

    return {
      data: {
        pid: process.pid,
        uptime: `${hours}h ${minutes}m ${seconds}s`,
        sessionCount: this.sessionManager.count(),
        memoryUsage: `${memoryMB}MB`,
        clientCount: this.clients.size
      }
    };
  }

  private async createSession(name?: string, model?: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    try {
      const session = await this.sessionManager.create(name, model);
      // Dispatch session.created hook
      this.hookEngine.dispatch('session.created', { sessionId: session.id, name: session.name }).catch(() => {});
      return { data: { sessionId: session.id, name: session.name, model: session.model } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to create session' };
    }
  }

  private async killSession(sessionId: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    try {
      await this.sessionManager.kill(sessionId);
      // Dispatch session.destroyed hook
      this.hookEngine.dispatch('session.destroyed', { sessionId }).catch(() => {});
      return { data: { success: true } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to kill session' };
    }
  }

  private selectSession(sessionId: string): { data?: Record<string, unknown>; error?: string } {
    try {
      this.sessionManager.select(sessionId);
      return { data: { success: true } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to select session' };
    }
  }

  private getCurrentSession(): { data?: Record<string, unknown>; error?: string } {
    const session = this.sessionManager.current();
    if (!session) {
      return { data: {} };
    }
    return {
      data: {
        sessionId: session.id,
        name: session.name,
        status: session.status
      }
    };
  }

  private getLastOutput(): { data?: Record<string, unknown>; error?: string } {
    const session = this.sessionManager.current();
    if (!session) {
      return { error: 'No session selected' };
    }
    return {
      data: {
        sessionId: session.id,
        status: session.status,
        output: session.getLastOutput()
      }
    };
  }

  private attachSession(
    sessionId: string,
    socket: Socket
  ): { data?: Record<string, unknown>; error?: string } {
    try {
      const session = this.sessionManager.get(sessionId);
      if (!session) {
        return { error: 'Session not found' };
      }
      session.attach(socket);
      // Register the socket-session mapping so stdin can find the session
      this.sessionManager.registerAttachment(socket, sessionId);
      return { data: { success: true } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to attach' };
    }
  }

  private detachSession(socket: Socket): { data?: Record<string, unknown>; error?: string } {
    // Get the attached session for this socket (not just current)
    const session = this.sessionManager.getAttachedSession(socket);
    if (session) {
      session.detach(socket);
    }
    // Unregister the socket-session mapping
    this.sessionManager.unregisterAttachment(socket);
    return { data: { success: true } };
  }

  private watchSession(socket: Socket): { data?: Record<string, unknown>; error?: string } {
    const session = this.sessionManager.current();
    if (!session) {
      return { error: 'No session selected' };
    }
    session.watch(socket);
    return { data: { success: true } };
  }

  private unwatchSession(socket: Socket): { data?: Record<string, unknown>; error?: string } {
    const session = this.sessionManager.current();
    if (session) {
      session.unwatch(socket);
    }
    return { data: { success: true } };
  }

  private async sendPrompt(prompt: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    let session = this.sessionManager.current();

    // Auto-create session if none exists
    if (!session) {
      const result = await this.createSession();
      if (result.error) {
        return result;
      }
      session = this.sessionManager.current();
    }

    if (!session) {
      return { error: 'Failed to get or create session' };
    }

    try {
      const promptId = await session.sendPrompt(prompt);

      // Dispatch prompt.received hook
      this.hookEngine.dispatch('prompt.received', {
        sessionId: session.id,
        promptId,
        prompt
      }).catch(() => {});

      // Listen for completion to dispatch prompt.completed
      const completionHandler = (info: { promptId?: string; code?: number }) => {
        if (info.promptId === promptId) {
          this.hookEngine.dispatch('prompt.completed', {
            sessionId: session!.id,
            promptId,
            status: info.code === 0 || info.code === null ? 'success' : 'failed',
            output: session!.getLastOutput()
          }).catch(() => {});
          session!.off('prompt.completed', completionHandler);
        }
      };
      session.on('prompt.completed', completionHandler);

      // Listen for notification events to write to inbox
      const notificationHandler = (notifData: NotificationInput) => {
        this.notificationInbox.addNotification(notifData).catch(() => {});
        session!.off('notification', notificationHandler);
      };
      session.on('notification', notificationHandler);

      return { data: { promptId, sessionId: session.id } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to send prompt' };
    }
  }

  private handleStdin(data: string, socket: Socket): { data?: Record<string, unknown>; error?: string } {
    const session = this.sessionManager.getAttachedSession(socket);
    if (!session) {
      return { error: 'Not attached to any session' };
    }
    session.writeStdin(data);
    return { data: { success: true } };
  }

  private async startRest(
    port?: number,
    host?: string
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (this.restServer) {
      return { error: 'REST server is already running' };
    }

    if (port) this.restConfig.port = port;
    if (host) this.restConfig.host = host;

    try {
      this.restServer = new RestServer({
        host: this.restConfig.host,
        port: this.restConfig.port,
        sessionManager: this.sessionManager,
        hookEngine: this.hookEngine,
        configDir: this.config.configDir
      });

      const address = await this.restServer.start();
      this.log(`REST server started on ${address}`);

      // Dispatch rest.started hook
      this.hookEngine.dispatch('rest.started', {
        host: this.restConfig.host,
        port: this.restConfig.port
      }).catch(() => {});

      const apiKey = this.restServer.getAuthManager().getApiKey();

      return {
        data: {
          success: true,
          address,
          port: this.restConfig.port,
          host: this.restConfig.host,
          apiKey
        }
      };
    } catch (error) {
      this.restServer = null;
      return { error: error instanceof Error ? error.message : 'Failed to start REST server' };
    }
  }

  private async stopRest(): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!this.restServer) {
      return { error: 'REST server is not running' };
    }

    try {
      await this.restServer.stop();
      this.restServer = null;
      this.log('REST server stopped');
      // Dispatch rest.stopped hook
      this.hookEngine.dispatch('rest.stopped', {}).catch(() => {});
      return { data: { success: true } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to stop REST server' };
    }
  }

  private getRestStatus(): { data?: Record<string, unknown>; error?: string } {
    if (!this.restServer) {
      return { data: { running: false } };
    }

    return {
      data: {
        running: true,
        host: this.restConfig.host,
        port: this.restConfig.port
      }
    };
  }

  private async getRestApiKey(): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!this.restServer) {
      return { error: 'REST server is not running' };
    }

    const apiKey = this.restServer.getAuthManager().getApiKey();
    return { data: { apiKey } };
  }

  // Hook management methods
  private async addShellHook(
    event: HookEventType | '*',
    command: string,
    timeout?: number,
    sessionFilter?: string
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!event || !command) {
      return { error: 'Event and command are required' };
    }

    try {
      const hook = await this.hookEngine.addShellHook(event, command, { timeout, sessionFilter });
      return { data: { hook } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to add shell hook' };
    }
  }

  private async removeShellHook(id: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!id) {
      return { error: 'Hook ID is required' };
    }

    const deleted = await this.hookEngine.removeShellHook(id);
    if (!deleted) {
      return { error: 'Hook not found' };
    }
    return { data: { success: true } };
  }

  private async toggleShellHook(
    id: string,
    enabled: boolean
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!id) {
      return { error: 'Hook ID is required' };
    }

    const hook = await this.hookEngine.toggleShellHook(id, enabled);
    if (!hook) {
      return { error: 'Hook not found' };
    }
    return { data: { hook } };
  }

  private async addWebhook(
    event: HookEventType | '*',
    url: string,
    options: Record<string, unknown>
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!event || !url) {
      return { error: 'Event and URL are required' };
    }

    try {
      const webhook = await this.hookEngine.addWebhook(event, url, {
        method: options.method as 'POST' | 'PUT' | undefined,
        headers: options.headers as Record<string, string> | undefined,
        timeout: options.timeout as number | undefined,
        retries: options.retries as number | undefined,
        transform: options.transform as string | undefined,
        sessionFilter: options.sessionFilter as string | undefined
      });
      return { data: { webhook } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to add webhook' };
    }
  }

  private async removeWebhook(id: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!id) {
      return { error: 'Webhook ID is required' };
    }

    const deleted = await this.hookEngine.removeWebhook(id);
    if (!deleted) {
      return { error: 'Webhook not found' };
    }
    return { data: { success: true } };
  }

  private async toggleWebhook(
    id: string,
    enabled: boolean
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!id) {
      return { error: 'Webhook ID is required' };
    }

    const webhook = await this.hookEngine.toggleWebhook(id, enabled);
    if (!webhook) {
      return { error: 'Webhook not found' };
    }
    return { data: { webhook } };
  }

  // Orchestration methods
  private async addRemoteHost(params: {
    url: string;
    apiKey: string;
    name?: string;
    priority?: number;
  }): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!params.url || !params.apiKey) {
      return { error: 'URL and API key are required' };
    }

    try {
      const host = createHost(params.url, params.apiKey, {
        name: params.name,
        priority: params.priority
      });

      await this.orchestrationManager.addHost(host);
      return { data: { host } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to add host' };
    }
  }

  private async removeRemoteHost(hostId: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!hostId) {
      return { error: 'Host ID is required' };
    }

    const removed = await this.orchestrationManager.removeHost(hostId);
    if (!removed) {
      return { error: 'Host not found' };
    }
    return { data: { success: true } };
  }

  private async toggleRemoteHost(
    hostId: string,
    enabled: boolean
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!hostId) {
      return { error: 'Host ID is required' };
    }

    const toggled = await this.orchestrationManager.toggleHost(hostId, enabled);
    if (!toggled) {
      return { error: 'Host not found' };
    }
    return { data: { success: true, enabled } };
  }

  private getOrchestrationStats(): { data?: Record<string, unknown>; error?: string } {
    const stats = this.orchestrationManager.getStats();
    // Convert circuit breakers Map to object for JSON serialization
    const circuitBreakers: Record<string, { state: string; failures: number }> = {};
    for (const [hostId, cb] of stats.circuitBreakers) {
      circuitBreakers[hostId] = cb;
    }

    return {
      data: {
        hosts: stats.hosts,
        requests: stats.requests,
        pipelines: stats.pipelines,
        circuitBreakers
      }
    };
  }

  private async sendRemotePrompt(
    prompt: string,
    hostId?: string,
    sessionId?: string
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!prompt) {
      return { error: 'Prompt is required' };
    }

    try {
      const result = await this.orchestrationManager.sendPrompt(prompt, {
        hostId,
        sessionId,
        timeout: 300000
      });

      return {
        data: {
          sessionId: result.sessionId,
          promptId: result.promptId,
          status: result.status,
          output: result.output,
          error: result.error,
          host: result.host,
          latency: result.latency
        }
      };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to send remote prompt' };
    }
  }

  // Notification inbox methods
  private async listNotifications(unreadOnly?: boolean): Promise<{ data?: Record<string, unknown>; error?: string }> {
    const notifications = unreadOnly
      ? await this.notificationInbox.getUnread()
      : await this.notificationInbox.getAll(50);
    return { data: { notifications } };
  }

  private async getNotificationCount(): Promise<{ data?: Record<string, unknown>; error?: string }> {
    const counts = await this.notificationInbox.count();
    return { data: counts };
  }

  private async clearNotifications(): Promise<{ data?: Record<string, unknown>; error?: string }> {
    const cleared = await this.notificationInbox.markAllRead();
    return { data: { cleared } };
  }

  // Fire-and-forget methods
  private async fireAndForget(
    prompt: string,
    name?: string,
    goal?: string,
    model?: string
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!prompt) return { error: 'Prompt is required' };

    try {
      const session = await this.sessionManager.create(
        name || `task-${nanoid(4)}`,
        model,
        goal || prompt.slice(0, 100),
        true
      );

      const promptId = await session.sendPrompt(prompt);

      // Listen for completion to write notification to inbox
      const completionHandler = (info: { promptId?: string; code?: number }) => {
        if (info.promptId === promptId) {
          const structured = session.getStructuredResult();
          this.notificationInbox.addNotification({
            sessionId: session.id,
            sessionName: session.name,
            type: info.code === 0 || info.code === null ? 'prompt.completed' : 'prompt.error',
            goal: session.goal,
            exitCode: info.code ?? null,
            durationMs: structured?.durationMs,
            costUsd: structured?.costUsd,
            resultPreview: structured?.result?.slice(0, 200) || session.getLastOutput().slice(0, 200),
            viewCommand: `cb -l`,
          }).catch(() => {});

          this.hookEngine.dispatch('prompt.completed', {
            sessionId: session.id,
            promptId,
            status: info.code === 0 || info.code === null ? 'success' : 'failed',
            output: session.getLastOutput()
          }).catch(() => {});

          session.off('prompt.completed', completionHandler);
        }
      };
      session.on('prompt.completed', completionHandler);

      return { data: { sessionId: session.id, promptId, goal: session.goal } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to fire task' };
    }
  }

  private async fireRemotePrompt(
    prompt: string,
    hostId?: string,
    goal?: string
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!prompt) return { error: 'Prompt is required' };

    const trackingId = nanoid(8);
    const taskGoal = goal || prompt.slice(0, 100);

    // Fire asynchronously - don't await
    this.orchestrationManager.sendPrompt(prompt, {
      hostId,
      timeout: 600000
    }).then(async (result) => {
      await this.notificationInbox.addNotification({
        sessionId: result.sessionId,
        sessionName: `remote:${result.host}`,
        type: result.status === 'completed' ? 'prompt.completed' : 'prompt.error',
        goal: taskGoal,
        exitCode: result.status === 'completed' ? 0 : 1,
        durationMs: result.latency,
        resultPreview: result.output?.slice(0, 200),
        viewCommand: `cb -i`,
      });
    }).catch(async (error) => {
      await this.notificationInbox.addNotification({
        sessionId: trackingId,
        sessionName: `remote:${hostId || 'auto'}`,
        type: 'prompt.error',
        goal: taskGoal,
        exitCode: 1,
        resultPreview: error instanceof Error ? error.message : String(error),
        viewCommand: `cb -i`,
      });
    });

    return { data: { trackingId, goal: taskGoal, status: 'dispatched' } };
  }

  private log(message: string): void {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${message}`);
    // In production, also write to log file
  }

  private async cleanup(): Promise<void> {
    try {
      if (existsSync(this.config.pidFile)) {
        await unlink(this.config.pidFile);
      }
      if (existsSync(this.config.socketPath)) {
        await unlink(this.config.socketPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private async shutdown(): Promise<void> {
    this.log('Shutting down...');

    // Dispatch daemon.stopped hook (don't await - best effort)
    this.hookEngine.dispatch('daemon.stopped', { pid: process.pid }).catch(() => {});

    // Stop REST server if running
    if (this.restServer) {
      await this.restServer.stop();
      this.hookEngine.dispatch('rest.stopped', {}).catch(() => {});
      this.restServer = null;
    }

    // Stop orchestration
    await this.orchestrationManager.shutdown();

    // Close all client connections
    for (const client of this.clients) {
      client.end();
    }

    // Stop all sessions
    await this.sessionManager.stopAll();

    // Close server
    this.server?.close();

    // Clean up files
    await this.cleanup();

    this.log('Daemon stopped');
    process.exit(0);
  }
}

// Start daemon
const daemon = new Daemon();
daemon.start().catch((error) => {
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
