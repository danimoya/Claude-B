import { loadEnv, getDataDir } from '../config/env.js';

loadEnv();

import { createServer, Server, Socket } from 'net';
import { nanoid } from 'nanoid';
import { SessionManager } from './session-manager.js';
import { DaemonInstanceLock } from './instance-lock.js';
import { selectExecutionSession } from './execution-context.js';
import { TmuxRegistry } from './tmux-registry.js';
import { readLastTurnsFromTranscript, type TranscriptTurn } from '../utils/transcript.js';
import { Session, type ExecutionPolicy } from '../session/session.js';
import { TERMINAL_TASK_STATUSES, type TaskRecord, type TaskSubmission } from '../jobs/types.js';
import { submitPromptWithDelivery } from './prompt-delivery.js';
import { RestServer } from '../rest/server.js';
import { HookEngine } from '../hooks/engine.js';
import { HookEventType } from '../hooks/events.js';
import { OrchestrationManager, createHost, redactRemoteHost } from '../orchestration/index.js';
import { NotificationInbox } from '../notifications/inbox.js';
import { NotificationOutbox } from '../notifications/outbox.js';
import { createDeliveryOutbox } from '../notifications/delivery.js';
import { ClaudeBTelegramBot } from '../telegram/bot.js';
import { VoicePipeline } from '../telegram/voice.js';
import { createAIProvider } from '../telegram/ai-provider.js';
import { createSTTTTSProvider } from '../telegram/stt-tts-provider.js';

interface DaemonConfig {
  socketPath: string;
  pidFile: string;
  lockFile: string;
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
  private instanceLock: DaemonInstanceLock;
  private tmuxRegistry: TmuxRegistry;
  private tmuxInlineContext = new Map<string, { turns: TranscriptTurn[]; lastSeen: number }>();
  private shuttingDown = false;
  private sessionManager: SessionManager;
  private hookEngine: HookEngine;
  private orchestrationManager: OrchestrationManager;
  private notificationInbox: NotificationInbox;
  private notificationOutbox: NotificationOutbox;
  private telegramBot: ClaudeBTelegramBot;
  private clients: Set<Socket> = new Set();
  private startTime: number = Date.now();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private restServer: RestServer | null = null;
  private restConfig: RestConfig = {
    host: process.env.CB_REST_HOST || process.env.REST_HOST || '127.0.0.1',
    port: parseInt(process.env.CB_REST_PORT || process.env.REST_PORT || '3847', 10)
  };

  // Maps canonical native invocation IDs to bounded transcript context.
  // path, populated by the cb-notify.sh hook via /api/notify. Used by the
  // voice pipeline's context lookup so `optimizePrompt` knows what the pane
  // was just working on. In-memory only, 24h TTL.
  private tmuxTranscriptCache = new Map<string, { transcriptPath: string; lastSeen: number }>();
  private static readonly TMUX_TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000;

  constructor() {
    const configDir = getDataDir();
    this.config = {
      socketPath: `${configDir}/daemon.sock`,
      pidFile: `${configDir}/daemon.pid`,
      lockFile: `${configDir}/daemon.lock`,
      logFile: `${configDir}/daemon.log`,
      configDir
    };
    this.instanceLock = new DaemonInstanceLock(configDir);
    this.tmuxRegistry = new TmuxRegistry({ stateFile: `${configDir}/tmux-registry.json` });
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
      onPrompt: async (sessionId: string, prompt: string, options?: { idempotencyKey?: string }) => {
        // Native replies require the same verified foreground invocation.
        if (sessionId.startsWith('tmux:')) {
          await this.tmuxRegistry.send(sessionId, prompt);
          await this.tmuxRegistry.flush();
          return;
        }

        const session = this.sessionManager.get(sessionId);
        if (!session) throw new Error('Session not found');
        this.sessionManager.select(sessionId);

        const taskId = await submitPromptWithDelivery(session, prompt, {
          outbox: this.notificationOutbox,
          hooks: this.hookEngine,
          inbox: this.notificationInbox,
          forward: (notification) => this.forwardToTelegram(notification),
        }, options);
        return { taskId };
      },
      onExecutionPolicy: async (sessionId, policy) => {
        await this.sessionManager.setExecutionPolicy(sessionId, policy);
      },
      getPromptReceipt: async (key) => {
        const task = await this.sessionManager.getTaskStore().findByIdempotencyKey(key);
        return task ? { taskId: task.id } : undefined;
      },
      getSessions: () => [...this.sessionManager.list(), ...this.tmuxRegistry.discover()],
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
    this.notificationOutbox = createDeliveryOutbox(configDir, {
      inbox: this.notificationInbox, hooks: this.hookEngine, telegram: this.telegramBot,
    });
    this.sessionManager.on('task.terminal', (task: TaskRecord) => {
      void this.notificationOutbox.enqueue(Session.notificationForTask(task)).then(() => this.notificationOutbox.drain()).catch(() => {
        this.log('Task notification remains recoverable from its durable receipt');
      });
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
    await this.instanceLock.acquire();

    // Load sessions, hooks, and orchestration
    await this.sessionManager.load();
    await this.tmuxRegistry.restore();
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

    for (const task of await this.sessionManager.listTasks()) {
      if (TERMINAL_TASK_STATUSES.has(task.status)) await this.notificationOutbox.enqueue(Session.notificationForTask(task));
    }
    this.notificationOutbox.start();

    // Create server
    this.server = createServer((socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.socketPath, () => {
        this.instanceLock.recordSocket().then(resolve, reject);
      });
    });
    this.log(`Daemon started on ${this.config.socketPath}`);
    this.hookEngine.dispatch('daemon.started', { pid: process.pid }).catch(() => {});

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
    if (this.shuttingDown && !['daemon.status', 'task.get', 'task.find', 'task.list', 'session.list'].includes(method)) return { error: 'Daemon is shutting down; no new work was accepted' };

    switch (method) {
      case 'daemon.status':
        return this.getStatus();

      case 'session.list':
        return { data: { sessions: this.sessionManager.list() } };

      case 'session.create':
        return this.createSession(params?.name as string | undefined, params?.model as string | undefined, params?.workingDir as string | undefined, params?.executionPolicy as ExecutionPolicy | undefined);

      case 'session.policy': {
        const session = params?.sessionId ? this.sessionManager.get(params.sessionId as string) : this.sessionManager.current();
        if (!session) return { error: 'Session not found' };
        if (params?.executionPolicy !== 'default' && params?.executionPolicy !== 'bypass') return { error: 'Execution policy must be default or bypass' };
        await this.sessionManager.setExecutionPolicy(session.id, params.executionPolicy);
        return { data: { sessionId: session.id, executionPolicy: session.executionPolicy } };
      }

      case 'task.get':
        return { data: { task: await this.sessionManager.getTask(params?.taskId as string) } };
      case 'task.find':
        return { data: { task: await this.sessionManager.getTaskStore().findByIdempotencyKey(params?.idempotencyKey as string) } };
      case 'task.list':
        return { data: { tasks: await this.sessionManager.listTasks(params?.sessionId as string | undefined) } };
      case 'task.cancel':
        return { data: { task: await this.sessionManager.cancelTask(params?.taskId as string) } };

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
        return this.watchSession(socket, params?.sessionId as string | undefined);

      case 'session.unwatch':
        return this.unwatchSession(socket);

      case 'prompt.send':
        return this.sendPrompt(params?.prompt as string, params?.model as string | undefined, params?.executionPolicy as ExecutionPolicy | undefined, params?.workingDir as string | undefined, params?.sessionId as string | undefined, { taskId: params?.taskId as string | undefined, idempotencyKey: params?.idempotencyKey as string | undefined });

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
          params?.model as string | undefined,
          params?.executionPolicy as ExecutionPolicy | undefined,
          params?.workingDir as string | undefined,
          { taskId: params?.taskId as string | undefined, idempotencyKey: params?.idempotencyKey as string | undefined }
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

      case 'telegram.pair':
        return { data: await this.telegramBot.beginPairing(typeof params?.expectedSenderId === 'string' ? params.expectedSenderId : undefined) };

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

  private async createSession(name?: string, model?: string, workingDir?: string, executionPolicy: ExecutionPolicy = 'default'): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (this.shuttingDown) return { error: 'Daemon is shutting down' };
    try {
      const session = await this.sessionManager.create(name, model, undefined, false, workingDir, executionPolicy);
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

  private watchSession(socket: Socket, sessionId?: string): { data?: Record<string, unknown>; error?: string } {
    const session = sessionId ? this.sessionManager.get(sessionId) : this.sessionManager.current();
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

  private async sendPrompt(prompt: string, model?: string, executionPolicy?: ExecutionPolicy, workingDir?: string, sessionId?: string, submission?: TaskSubmission): Promise<{ data?: Record<string, unknown>; error?: string }> {
    try {
      const session = await selectExecutionSession(this.sessionManager, { sessionId, workingDir, model, executionPolicy });
      const promptId = await submitPromptWithDelivery(session, prompt, {
        outbox: this.notificationOutbox,
        hooks: this.hookEngine,
        inbox: this.notificationInbox,
        forward: (notification) => this.forwardToTelegram(notification),
      }, submission);
      const task = await this.sessionManager.getTask(promptId);
      return { data: { promptId, taskId: promptId, sessionId: task?.sessionId ?? session.id, status: 'accepted' } };
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
        notificationOutbox: this.notificationOutbox,
        telegramBot: this.telegramBot,
        orchestrationManager: this.orchestrationManager,
        configDir: this.config.configDir,
        onTmuxTranscript: (sessionId, transcriptPath) =>
          this.rememberTmuxTranscript(sessionId, transcriptPath),
        onTmuxSession: async (sessionId, sessionName, agent, goal) => {
          const canonical = this.tmuxRegistry.register(sessionId, sessionName, agent, goal);
          if (canonical) await this.tmuxRegistry.flush();
          return canonical;
        },
        onTmuxContext: (sessionId, turns) => this.rememberTmuxContext(sessionId, turns),
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
        secret: options.secret as string | undefined,
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
      return { data: { host: redactRemoteHost(host) } };
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

  private rememberTmuxTranscript(sessionId: string, transcriptPath: string): void {
    if (!sessionId.startsWith('tmux:') || !transcriptPath) return;
    this.tmuxTranscriptCache.delete(sessionId);
    this.tmuxTranscriptCache.set(sessionId, { transcriptPath, lastSeen: Date.now() });
    for (const [id, cached] of this.tmuxTranscriptCache) {
      if (Date.now() - cached.lastSeen > Daemon.TMUX_TRANSCRIPT_TTL_MS || this.tmuxTranscriptCache.size > 500) this.tmuxTranscriptCache.delete(id);
    }
  }

  private rememberTmuxContext(sessionId: string, turns: TranscriptTurn[]): void {
    if (!sessionId.startsWith('tmux:')) return;
    this.tmuxInlineContext.delete(sessionId);
    this.tmuxInlineContext.set(sessionId, { lastSeen: Date.now(), turns: turns.slice(-6).map(turn => ({ role: turn.role, text: turn.text.slice(0, 600) })) });
    for (const [id, cached] of this.tmuxInlineContext) {
      if (Date.now() - cached.lastSeen > Daemon.TMUX_TRANSCRIPT_TTL_MS || this.tmuxInlineContext.size > 500) this.tmuxInlineContext.delete(id);
    }
  }

  private buildTmuxSessionContext(sessionId: string) {
    const pane = this.tmuxRegistry.aliveSessions().find(entry => entry.id === sessionId);
    if (!pane) {
      this.tmuxTranscriptCache.delete(sessionId);
      this.tmuxInlineContext.delete(sessionId);
      return undefined;
    }
    let lastOutput = '';
    const transcript = this.tmuxTranscriptCache.get(sessionId);
    if (transcript && Date.now() - transcript.lastSeen <= Daemon.TMUX_TRANSCRIPT_TTL_MS) {
      try { lastOutput = readLastTurnsFromTranscript(transcript.transcriptPath, 3); }
      catch { this.tmuxTranscriptCache.delete(sessionId); }
    }
    const inline = this.tmuxInlineContext.get(sessionId);
    if (!lastOutput && inline && Date.now() - inline.lastSeen <= Daemon.TMUX_TRANSCRIPT_TTL_MS) {
      lastOutput = inline.turns.map(turn => `${turn.role.toUpperCase()}: ${turn.text}`).join('\n\n');
    }
    return { sessionName: pane.name, goal: pane.goal, status: pane.status, lastOutput: lastOutput.slice(-2000) };
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
    model?: string,
    executionPolicy: ExecutionPolicy = 'default',
    workingDir?: string,
    submission?: TaskSubmission
  ): Promise<{ data?: Record<string, unknown>; error?: string }> {
    if (!prompt) return { error: 'Prompt is required' };

    try {
      const session = await this.sessionManager.create(
        name || `task-${nanoid(4)}`,
        model,
        goal || prompt.slice(0, 100),
        true,
        workingDir,
        executionPolicy
      );

      const promptId = await submitPromptWithDelivery(session, prompt, {
        outbox: this.notificationOutbox,
        hooks: this.hookEngine,
        inbox: this.notificationInbox,
        forward: (notification) => this.forwardToTelegram(notification),
      }, submission);

      const task = await this.sessionManager.getTask(promptId);
      return { data: { sessionId: task?.sessionId ?? session.id, promptId, taskId: promptId, goal: task?.goal ?? session.goal, status: 'accepted' } };
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

  async cleanupFailedStart(): Promise<void> {
    this.shuttingDown = true;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    await this.telegramBot.stop().catch(() => {});
    await this.sessionManager.stopAll().catch(() => {});
    this.orchestrationManager.stopHealthChecks();
    await this.notificationOutbox.stop().catch(() => {});
    if (this.server?.listening) {
      for (const client of this.clients) client.destroy();
      await new Promise<void>(resolve => this.server!.close(() => resolve()));
    }
    await this.instanceLock.release();
  }

  private async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    let failed = false;
    const settle = async (label: string, operation: Promise<unknown>) => {
      try { await operation; }
      catch { failed = true; this.log(`${label} could not finish; persisted state was preserved`); }
    };
    // Close acceptance before waiting for cancellation or network shutdown.
    const sessionsStopped = settle('Task cancellation', this.sessionManager.stopAll());
    const remoteStopped = settle('Remote request shutdown', this.orchestrationManager.shutdown());
    const serverClosed = this.server?.listening
      ? new Promise<void>(resolve => this.server!.close(() => resolve())) : Promise.resolve();
    for (const client of this.clients) client.destroy();
    await settle('REST shutdown', this.restServer?.stop() || Promise.resolve());
    await settle('Telegram shutdown', this.telegramBot.stop());
    await remoteStopped;
    await sessionsStopped;
    await settle('Notification shutdown', this.notificationOutbox.stop());
    await settle('Native session identity persistence', this.tmuxRegistry.flush());
    await settle('IPC shutdown', serverClosed);
    await settle('Daemon ownership cleanup', this.instanceLock.release());
    this.log('Daemon stopped');
    process.exit(failed ? 1 : 0);
  }

}

// Start daemon
const daemon = new Daemon();
daemon.start().catch(async (error) => {
  await daemon.cleanupFailedStart().catch(() => {});
  console.error('Failed to start daemon:', error);
  process.exit(1);
});
