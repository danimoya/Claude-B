import { createServer, Server, Socket } from 'net';
import { homedir } from 'os';
import { mkdir, writeFile, unlink, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { nanoid } from 'nanoid';
import { spawn, spawnSync } from 'child_process';
import { SessionManager } from './session-manager.js';
import { RestServer } from '../rest/server.js';
import { HookEngine } from '../hooks/engine.js';
import { HookEventType } from '../hooks/events.js';
import { OrchestrationManager, createHost } from '../orchestration/index.js';
import { NotificationInbox, NotificationInput } from '../notifications/inbox.js';
import { ClaudeBTelegramBot } from '../telegram/bot.js';
import { VoicePipeline } from '../telegram/voice.js';
import { createAIProvider } from '../telegram/ai-provider.js';
import { createSTTTTSProvider } from '../telegram/stt-tts-provider.js';

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
  private telegramBot: ClaudeBTelegramBot;
  private clients: Set<Socket> = new Set();
  private startTime: number = Date.now();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private restServer: RestServer | null = null;
  private restConfig: RestConfig = {
    host: process.env.REST_HOST || '127.0.0.1',
    port: parseInt(process.env.REST_PORT || '3847', 10)
  };

  // Maps virtual tmux session ids ("tmux:general:1.0") → Claude Code transcript
  // path, populated by the cb-notify.sh hook via /api/notify. Used by the
  // voice pipeline's context lookup so `optimizePrompt` knows what the pane
  // was just working on. In-memory only, 24h TTL.
  private tmuxTranscriptCache = new Map<string, { transcriptPath: string; lastSeen: number }>();
  private static readonly TMUX_TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000;

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
    this.telegramBot = new ClaudeBTelegramBot({
      configDir,
      onCreateSession: async () => {
        const result = await this.createSession();
        if (result.error || !result.data) return null;
        const data = result.data as { sessionId: string; name?: string };
        return { sessionId: data.sessionId, name: data.name };
      },
      onPrompt: async (sessionId: string, prompt: string) => {
        // Virtual tmux-backed session: sessionId is "tmux:<target>" where
        // <target> is a tmux target string like "general:1.0".
        // Replies to notifications from external Claude Code panes land here;
        // we type the reply directly into the pane via tmux send-keys.
        if (sessionId.startsWith('tmux:')) {
          const target = sessionId.slice('tmux:'.length);
          await this.sendToTmuxPane(target, prompt);
          return;
        }

        const session = this.sessionManager.get(sessionId);
        if (!session) throw new Error('Session not found');
        this.sessionManager.select(sessionId);

        // Register notification listener BEFORE sending prompt to avoid race condition
        // (notification event fires synchronously right after prompt.completed)
        const notificationHandler = (notifData: NotificationInput) => {
          this.notificationInbox.addNotification(notifData).catch(() => {});
          this.forwardToTelegram(notifData);
          session.off('notification', notificationHandler);
        };
        session.on('notification', notificationHandler);

        await session.sendPrompt(prompt);
      },
      getSessions: () => [
        ...this.sessionManager.list(),
        ...this.listTmuxClaudePanes(),
      ],
      getInboxCount: () => this.notificationInbox.count(),
      getSessionContext: (sessionId: string) => {
        // tmux-hosted session: resolve from the cached transcript populated
        // by the Stop hook via /api/notify. Context is built by walking the
        // JSONL backwards for the last few real user↔assistant turn pairs,
        // skipping tool_result wrappers and system reminders.
        if (sessionId.startsWith('tmux:')) {
          return this.buildTmuxSessionContext(sessionId);
        }
        const session = this.sessionManager.get(sessionId);
        if (!session) return undefined;
        return {
          sessionName: session.name,
          goal: session.goal,
          lastOutput: session.getLastOutput().slice(-2000),
          status: session.status,
        };
      },
    });
  }

  private async initVoicePipeline(): Promise<void> {
    const config = this.telegramBot.getConfigManager().get();
    if (config.sttProvider && config.aiProvider) {
      try {
        const tempDir = `${this.config.configDir}/voice-temp`;
        const sttProvider = createSTTTTSProvider(config.sttProvider, tempDir);
        const aiProvider = createAIProvider(config.aiProvider);
        const pipeline = new VoicePipeline({ sttProvider, aiProvider });
        this.telegramBot.setVoicePipeline(pipeline);
        this.log(`Voice pipeline initialized (STT: ${config.sttProvider.provider})`);
      } catch (err) {
        this.log(`Voice pipeline init failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
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

    // Run initial cleanup of expired and completed fire-and-forget sessions
    const expiredCount = await this.sessionManager.cleanupExpired();
    const ffCount = await this.sessionManager.cleanupFireAndForget();
    if (expiredCount > 0 || ffCount > 0) {
      this.log(`Cleanup: ${expiredCount} expired, ${ffCount} fire-and-forget sessions removed`);
    }

    // Schedule periodic cleanup every hour
    this.cleanupInterval = setInterval(async () => {
      const expired = await this.sessionManager.cleanupExpired();
      const ff = await this.sessionManager.cleanupFireAndForget();
      if (expired > 0 || ff > 0) {
        this.log(`Cleanup: ${expired} expired, ${ff} fire-and-forget sessions removed`);
      }
    }, 60 * 60 * 1000);

    // Auto-start Telegram bot if configured
    try {
      await this.telegramBot.start();
      this.log('Telegram bot started');
      // Initialize voice pipeline if configured
      await this.initVoicePipeline();
    } catch (err) {
      // No token configured or invalid — that's fine
      this.log(`Telegram bot not started: ${err instanceof Error ? err.message : String(err)}`);
    }

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
        return this.sendPrompt(params?.prompt as string, params?.model as string | undefined);

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

      case 'notification.markRead':
        return this.markNotificationRead(params?.id as string);

      case 'notification.delete':
        return this.deleteNotification(params?.id as string);

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

      // Telegram bot
      case 'telegram.setup':
        return this.setupTelegram(params?.token as string);

      case 'telegram.stop':
        return this.stopTelegram();

      case 'telegram.status':
        return this.getTelegramStatus();

      // Voice pipeline
      case 'telegram.setForward':
        return this.setTelegramForward(params?.enabled as boolean);

      case 'voice.setup':
        return this.setupVoice(params?.provider as string, params?.apiKey as string);

      case 'voice.ai':
        return this.setupVoiceAI(
          params?.provider as string,
          params?.apiKey as string,
          params?.model as string | undefined
        );

      case 'voice.status':
        return this.getVoiceStatus();

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

  private async sendPrompt(prompt: string, model?: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    let session = this.sessionManager.current();

    // Auto-create session if none exists
    if (!session) {
      const result = await this.createSession(undefined, model);
      if (result.error) {
        return result;
      }
      session = this.sessionManager.current();
    }

    if (!session) {
      return { error: 'Failed to get or create session' };
    }

    // Apply model override if provided
    if (model && session.model !== model) {
      session.model = model;
      this.sessionManager.save().catch(() => {});
    }

    try {
      // Register listeners BEFORE sending prompt to avoid race conditions
      // (notification fires synchronously right after prompt.completed in same tick)
      const completionHandler = (info: { promptId?: string; code?: number }) => {
        this.hookEngine.dispatch('prompt.completed', {
          sessionId: session!.id,
          promptId: info.promptId || '',
          status: info.code === 0 || info.code === null ? 'success' : 'failed',
          output: session!.getLastOutput()
        }).catch(() => {});
        session!.off('prompt.completed', completionHandler);
      };
      session.on('prompt.completed', completionHandler);

      const notificationHandler = (notifData: NotificationInput) => {
        this.notificationInbox.addNotification(notifData).catch(() => {});
        this.forwardToTelegram(notifData);
        session!.off('notification', notificationHandler);
      };
      session.on('notification', notificationHandler);

      const promptId = await session.sendPrompt(prompt);

      // Dispatch prompt.received hook
      this.hookEngine.dispatch('prompt.received', {
        sessionId: session.id,
        promptId,
        prompt
      }).catch(() => {});

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
        notificationInbox: this.notificationInbox,
        telegramBot: this.telegramBot,
        orchestrationManager: this.orchestrationManager,
        configDir: this.config.configDir,
        onTmuxTranscript: (sessionId, transcriptPath) =>
          this.rememberTmuxTranscript(sessionId, transcriptPath),
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

  private async markNotificationRead(id: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!id) return { error: 'Notification ID is required' };
    const marked = await this.notificationInbox.markRead(id);
    return { data: { success: marked } };
  }

  private async deleteNotification(id: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!id) return { error: 'Notification ID is required' };
    const deleted = await this.notificationInbox.deleteNotification(id);
    return { data: { success: deleted } };
  }

  // Telegram methods
  private async setupTelegram(token: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!token) return { error: 'Token is required' };

    try {
      if (this.telegramBot.isRunning()) {
        await this.telegramBot.stop();
      }
      const info = await this.telegramBot.start(token);
      this.log(`Telegram bot started: @${info.username}`);
      // Initialize voice pipeline if STT + AI are configured
      await this.initVoicePipeline();
      return { data: { success: true, username: info.username } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to start Telegram bot' };
    }
  }

  private async stopTelegram(): Promise<{ data?: Record<string, unknown>; error?: string }> {
    try {
      await this.telegramBot.disable();
      this.log('Telegram bot stopped and disabled');
      return { data: { success: true } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to stop Telegram bot' };
    }
  }

  private getTelegramStatus(): { data?: Record<string, unknown>; error?: string } {
    const running = this.telegramBot.isRunning();
    const config = this.telegramBot.getConfig();
    const configManager = this.telegramBot.getConfigManager();
    return {
      data: {
        running,
        enabled: config.enabled,
        chatIds: config.chatIds,
        forwardAllSessions: configManager.shouldForwardSession(),
      },
    };
  }

  private async setTelegramForward(enabled: boolean): Promise<{ data?: Record<string, unknown>; error?: string }> {
    try {
      const configManager = this.telegramBot.getConfigManager();
      await configManager.setForwardAllSessions(enabled);
      return { data: { success: true, enabled } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to set forward mode' };
    }
  }

  private async setupVoice(provider: string, apiKey: string): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!provider || !apiKey) return { error: 'Provider and API key are required' };
    const validProviders = ['speechmatics', 'deepgram', 'openai'];
    if (!validProviders.includes(provider)) {
      return { error: `Provider must be one of: ${validProviders.join(', ')}` };
    }

    try {
      const configManager = this.telegramBot.getConfigManager();
      await configManager.setSTTProvider({ provider: provider as 'speechmatics' | 'deepgram' | 'openai', apiKey });
      // Re-init voice pipeline if AI provider is already configured
      await this.initVoicePipeline();
      return { data: { success: true, provider } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to configure STT provider' };
    }
  }

  private async setupVoiceAI(
    provider: string,
    apiKey: string,
    model?: string
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!provider || !apiKey) return { error: 'Provider and API key are required' };
    if (provider !== 'anthropic' && provider !== 'openrouter') {
      return { error: 'Provider must be "anthropic" or "openrouter"' };
    }

    try {
      const configManager = this.telegramBot.getConfigManager();
      await configManager.setAIProvider({ provider: provider as 'anthropic' | 'openrouter', apiKey, model });
      // Re-init voice pipeline if Speechmatics is already configured
      await this.initVoicePipeline();
      return { data: { success: true, provider, model: model || 'default' } };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Failed to configure AI provider' };
    }
  }

  private getVoiceStatus(): { data?: Record<string, unknown>; error?: string } {
    const configManager = this.telegramBot.getConfigManager();
    const config = configManager.get();
    return {
      data: {
        sttProvider: config.sttProvider ? {
          provider: config.sttProvider.provider,
        } : null,
        aiProvider: config.aiProvider ? {
          provider: config.aiProvider.provider,
          model: config.aiProvider.model || 'default',
        } : null,
        pipelineActive: !!config.sttProvider && !!config.aiProvider,
      },
    };
  }

  /**
   * Enumerate live tmux panes that are running `claude` and expose them
   * as virtual sessions so they show up in the Telegram /sessions list and
   * are targetable by /select.
   *
   * Virtual session id = "tmux:<session:window.pane>" — the same opaque
   * identifier format used by the Stop hook's /api/notify payloads, so the
   * Telegram bot's existing sessionMap (for reply-to-notification routing)
   * and the /select handler line up with zero changes.
   *
   * Status is inferred from the first glyph of the pane title — Claude Code
   * uses `✳` when idle/waiting and a braille spinner char (`⠂⠄⠠⠐⠈⠁⠃⠇`…)
   * while working. Anything that isn't `✳` is treated as busy.
   */
  private listTmuxClaudePanes(): Array<{
    id: string;
    name: string;
    status: string;
    selected: boolean;
    createdAt: string;
    goal?: string;
  }> {
    try {
      const out = spawnSync(
        'tmux',
        ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}|#{pane_current_command}|#{pane_title}'],
        { encoding: 'utf8', timeout: 2000 }
      );
      if (out.status !== 0 || !out.stdout) return [];

      const panes: ReturnType<Daemon['listTmuxClaudePanes']> = [];
      for (const line of out.stdout.split('\n')) {
        if (!line) continue;
        const [target, cmd, rawTitle] = line.split('|', 3);
        if (cmd !== 'claude') continue;

        const title = (rawTitle || '').trim();
        // First grapheme is the busy/idle glyph; everything after is the slug.
        // We split on the first space after the glyph.
        const spaceIdx = title.indexOf(' ');
        const glyph = spaceIdx >= 0 ? title.slice(0, spaceIdx) : title;
        const slug = spaceIdx >= 0 ? title.slice(spaceIdx + 1) : '';
        const status = glyph === '✳' ? 'idle' : 'busy';

        panes.push({
          id: `tmux:${target}`,
          name: title ? `${target} ${title}` : target,
          status,
          selected: false,
          createdAt: '', // unknown for external panes
          goal: slug || undefined,
        });
      }
      return panes;
    } catch {
      return [];
    }
  }

  /**
   * Record a tmux session → Claude Code transcript mapping. Called from
   * /api/notify when the cb-notify.sh hook forwards a Stop event with a
   * transcriptPath. Prunes entries older than TMUX_TRANSCRIPT_TTL_MS.
   */
  private rememberTmuxTranscript(sessionId: string, transcriptPath: string): void {
    if (!sessionId.startsWith('tmux:') || !transcriptPath) return;
    const now = Date.now();
    this.tmuxTranscriptCache.set(sessionId, { transcriptPath, lastSeen: now });

    // Opportunistic TTL prune — cheap, runs at write time.
    for (const [key, entry] of this.tmuxTranscriptCache) {
      if (now - entry.lastSeen > Daemon.TMUX_TRANSCRIPT_TTL_MS) {
        this.tmuxTranscriptCache.delete(key);
      }
    }
  }

  /**
   * Build a SessionContext for a tmux-hosted session so the Telegram voice
   * pipeline can ground `optimizePrompt` with real conversation history.
   *
   * Looks up the cached transcript, pulls the pane's current name/goal/status
   * from a fresh tmux enumeration, and walks the JSONL backwards to extract
   * the last N real user↔assistant turn pairs. Tool-result wrappers
   * (<task-notification>, <system-reminder>, tool_result content arrays) are
   * filtered out — they'd just confuse the optimizer with internal noise.
   */
  private buildTmuxSessionContext(sessionId: string): {
    sessionName?: string;
    goal?: string;
    lastOutput: string;
    status: string;
  } | undefined {
    const target = sessionId.slice('tmux:'.length);

    // Find the current pane entry for labels/status. If the pane has gone
    // away we still return context from the transcript if we have one.
    const panes = this.listTmuxClaudePanes();
    const pane = panes.find((p) => p.id === sessionId);

    const cached = this.tmuxTranscriptCache.get(sessionId);
    if (!cached && !pane) return undefined;

    let lastOutput = '';
    if (cached) {
      try {
        lastOutput = this.readLastTurnsFromTranscript(cached.transcriptPath, 3);
      } catch {
        // transcript file moved/rotated — drop the cache entry so we don't
        // keep retrying a dead path
        this.tmuxTranscriptCache.delete(sessionId);
      }
    }

    return {
      sessionName: pane?.name || target,
      goal: pane?.goal,
      lastOutput,
      status: pane?.status || 'unknown',
    };
  }

  /**
   * Read the last `turns` user↔assistant exchanges from a Claude Code
   * transcript JSONL file and render them as a compact text block that can
   * be handed to `optimizePrompt`.
   *
   * Heuristics:
   *  - a "real" user message has `.message.content` as a string and does
   *    NOT start with "<" (which would indicate a <task-notification> or
   *    <system-reminder> tool-result wrapper)
   *  - an assistant message is `.type == "assistant"` and we join all
   *    `content[]` items where `type == "text"`
   *  - each captured turn is trimmed to ~600 chars so the total output
   *    stays well under the 2000-char budget the bot already uses
   */
  private readLastTurnsFromTranscript(path: string, turns: number): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    const raw = fs.readFileSync(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);

    type Turn = { role: 'user' | 'assistant'; text: string };
    const collected: Turn[] = [];

    // Walk backwards — most recent first. Stop once we have `turns` user
    // messages AND `turns` assistant messages (or run out of file).
    let userCount = 0;
    let assistantCount = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (userCount >= turns && assistantCount >= turns) break;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(lines[i]);
      } catch {
        continue;
      }

      const type = parsed.type as string | undefined;
      const message = parsed.message as { role?: string; content?: unknown } | undefined;
      if (!type || !message) continue;

      if (type === 'user' && userCount < turns) {
        const content = message.content;
        if (typeof content !== 'string') continue; // skip tool_result arrays
        const trimmed = content.trim();
        if (!trimmed || trimmed.startsWith('<')) continue; // skip wrappers
        collected.push({ role: 'user', text: trimmed.slice(0, 600) });
        userCount++;
      } else if (type === 'assistant' && assistantCount < turns) {
        const content = message.content;
        if (!Array.isArray(content)) continue;
        const text = (content as Array<{ type?: string; text?: string }>)
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => (block.text as string).trim())
          .filter((t) => t.length > 0)
          .join('\n');
        if (!text) continue;
        collected.push({ role: 'assistant', text: text.slice(0, 600) });
        assistantCount++;
      }
    }

    // Reverse to chronological order and format.
    collected.reverse();
    return collected
      .map((turn) => (turn.role === 'user' ? `USER: ${turn.text}` : `ASSISTANT: ${turn.text}`))
      .join('\n\n');
  }

  /**
   * Type a prompt into an external Claude Code pane via tmux send-keys.
   * Used when Telegram replies target a "tmux:<target>" virtual session ID.
   *
   * Uses `send-keys -l` so the text is sent literally (no key-name expansion,
   * no risk of a stray "Enter" in the middle of a prompt), followed by a
   * separate Enter to submit. This is the equivalent of pasting + pressing
   * Return inside the pane.
   */
  private async sendToTmuxPane(target: string, text: string): Promise<void> {
    // Accept only sane tmux targets — session:window.pane style. Reject
    // anything containing shell metacharacters to avoid process injection
    // even though we're using argv (defense in depth).
    if (!/^[A-Za-z0-9_./:%@+-]+$/.test(target)) {
      throw new Error(`Invalid tmux target: ${target}`);
    }

    const runTmux = (args: string[]) => new Promise<void>((resolve, reject) => {
      const proc = spawn('tmux', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tmux exited ${code}: ${stderr.trim()}`));
      });
    });

    // Type the text literally (no key-name interpretation), then press Enter.
    await runTmux(['send-keys', '-t', target, '-l', text]);
    await runTmux(['send-keys', '-t', target, 'Enter']);
  }

  private forwardToTelegram(notification: {
    sessionId: string;
    sessionName?: string;
    type: string;
    goal?: string;
    exitCode: number | null;
    durationMs?: number;
    costUsd?: number;
    resultPreview?: string;
    resultFull?: string;
  }): void {
    if (!this.telegramBot.isRunning()) return;

    const configManager = this.telegramBot.getConfigManager();
    if (!configManager.shouldForwardSession()) return;

    // Use full result for Telegram (up to 3000 chars) instead of the short inbox preview
    const telegramNotif = {
      ...notification,
      resultPreview: notification.resultFull?.slice(0, 3000) || notification.resultPreview
    };
    this.telegramBot.broadcastNotification(telegramNotif).catch(() => {});
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
          const fullResult = structured?.result || session.getLastOutput();
          this.notificationInbox.addNotification({
            sessionId: session.id,
            sessionName: session.name,
            type: info.code === 0 || info.code === null ? 'prompt.completed' : 'prompt.error',
            goal: session.goal,
            exitCode: info.code ?? null,
            durationMs: structured?.durationMs,
            costUsd: structured?.costUsd,
            resultPreview: fullResult.slice(0, 200),
            resultFull: fullResult.slice(0, 50000),
            claudeSessionId: session.getClaudeSessionId(),
            viewCommand: `cb -l`,
          }).catch(() => {});

          // Forward to Telegram
          this.forwardToTelegram({
            sessionId: session.id,
            sessionName: session.name,
            type: info.code === 0 || info.code === null ? 'prompt.completed' : 'prompt.error',
            goal: session.goal,
            exitCode: info.code ?? null,
            durationMs: structured?.durationMs,
            costUsd: structured?.costUsd,
            resultPreview: fullResult.slice(0, 200),
            resultFull: fullResult,
          });

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
      const notif = {
        sessionId: result.sessionId,
        sessionName: `remote:${result.host}`,
        type: (result.status === 'completed' ? 'prompt.completed' : 'prompt.error') as 'prompt.completed' | 'prompt.error',
        goal: taskGoal,
        exitCode: result.status === 'completed' ? 0 : 1,
        durationMs: result.latency,
        resultPreview: result.output?.slice(0, 200),
        resultFull: result.output?.slice(0, 50000),
        viewCommand: `cb -i`,
      };
      await this.notificationInbox.addNotification(notif);
      this.forwardToTelegram(notif);
    }).catch(async (error) => {
      const notif = {
        sessionId: trackingId,
        sessionName: `remote:${hostId || 'auto'}`,
        type: 'prompt.error' as const,
        goal: taskGoal,
        exitCode: 1,
        resultPreview: error instanceof Error ? error.message : String(error),
        viewCommand: `cb -i`,
      };
      await this.notificationInbox.addNotification(notif);
      this.forwardToTelegram(notif);
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

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Stop Telegram bot
    if (this.telegramBot.isRunning()) {
      await this.telegramBot.stop();
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
