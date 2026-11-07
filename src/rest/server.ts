import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { SessionManager } from '../daemon/session-manager.js';
import { HookEngine } from '../hooks/engine.js';
import { NotificationInbox } from '../notifications/inbox.js';
import { ClaudeBTelegramBot } from '../telegram/bot.js';
import { OrchestrationManager } from '../orchestration/index.js';
import { AuthManager } from './auth.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHookRoutes } from './routes/hooks.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerTelegramRoutes } from './routes/telegram.js';
import { registerOrchestrationRoutes } from './routes/orchestration.js';
import { registerNotifyRoutes } from './routes/notify.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { NotificationOutbox } from '../notifications/outbox.js';
import { createDeliveryOutbox } from '../notifications/delivery.js';
import { Session } from '../session/session.js';
import { isTerminalTask } from '../jobs/store.js';
import type { TaskRecord } from '../jobs/types.js';
import type { TranscriptTurn } from '../utils/transcript.js';

export interface RestServerOptions {
  host: string;
  port: number;
  sessionManager: SessionManager;
  hookEngine?: HookEngine;
  notificationInbox?: NotificationInbox;
  notificationOutbox?: NotificationOutbox;
  telegramBot?: ClaudeBTelegramBot;
  orchestrationManager?: OrchestrationManager;
  configDir: string;
  allowedOrigins?: string[];
  // Optional hook invoked by /api/notify when the payload carries a
  // transcriptPath. Daemon uses this to cache tmux session → transcript
  // mappings for the voice pipeline's context lookup.
  onTmuxTranscript?: (sessionId: string, transcriptPath: string) => void;
  onTmuxContext?: (sessionId: string, turns: TranscriptTurn[]) => void | Promise<void>;
  // Optional hook invoked by /api/notify when the payload carries an `agent`
  // field (e.g. "codex"). Daemon uses this to register non-Claude tmux panes
  // so they surface in the Telegram /sessions list.
  onTmuxSession?: (sessionId: string, sessionName: string | undefined, agent: string, goal: string | undefined) => string | void | Promise<string | void>;
}

export class RestServer {
  private app: FastifyInstance;
  private sessionManager: SessionManager;
  private hookEngine: HookEngine | null;
  private notificationInbox: NotificationInbox | null;
  private telegramBot: ClaudeBTelegramBot | null;
  private orchestrationManager: OrchestrationManager | null;
  private authManager: AuthManager;
  private onTmuxTranscript: ((sessionId: string, transcriptPath: string) => void) | null;
  private onTmuxContext: ((sessionId: string, turns: TranscriptTurn[]) => void | Promise<void>) | null;
  private onTmuxSession: ((sessionId: string, sessionName: string | undefined, agent: string, goal: string | undefined) => string | void | Promise<string | void>) | null;
  private host: string;
  private port: number;
  private allowedOrigins: string[];
  private notificationOutbox: NotificationOutbox;
  private ownsOutbox: boolean;
  private initialization: Promise<void> | null = null;
  private pendingEnqueues = new Set<Promise<unknown>>();
  private taskTerminalHandler = (task: TaskRecord) => {
    const pending = this.notificationOutbox.enqueue(Session.notificationForTask(task));
    this.pendingEnqueues.add(pending);
    void pending.catch(() => this.app.log.error('Failed to enqueue durable task notification'))
      .finally(() => this.pendingEnqueues.delete(pending));
  };

  constructor(options: RestServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.allowedOrigins = [...new Set(options.allowedOrigins || [])];
    for (const origin of this.allowedOrigins) {
      let valid = false;
      try {
        const parsed = new URL(origin);
        valid = ['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin &&
          !parsed.username && !parsed.password;
      } catch { /* rejected below without echoing a possibly secret URL */ }
      if (!valid) throw new Error('Allowed browser origins must be exact HTTP(S) origins');
    }
    this.sessionManager = options.sessionManager;
    this.hookEngine = options.hookEngine || null;
    this.notificationInbox = options.notificationInbox || new NotificationInbox(options.configDir);
    this.telegramBot = options.telegramBot || null;
    this.orchestrationManager = options.orchestrationManager || null;
    this.onTmuxTranscript = options.onTmuxTranscript || null;
    this.onTmuxContext = options.onTmuxContext || null;
    this.onTmuxSession = options.onTmuxSession || null;
    this.authManager = new AuthManager(options.configDir);
    this.ownsOutbox = !options.notificationOutbox;
    this.notificationOutbox = options.notificationOutbox || createDeliveryOutbox(options.configDir, {
      inbox: this.notificationInbox, hooks: this.hookEngine, telegram: this.telegramBot
    });

    this.app = Fastify({
      disableRequestLogging: process.env.CB_REST_REQUEST_LOGS !== '1',
      logger: {
        redact: ['req.headers.authorization', 'req.headers["x-claude-b-key"]', 'req.body.api_key', 'req.body.refresh_token', 'req.body.apiKey', 'req.body.token', 'req.body.secret', 'req.url'],
        level: process.env.CB_REST_LOG_LEVEL || 'warn'
      }
    });
  }

  initialize(): Promise<void> {
    this.initialization ||= this.initializeOnce();
    return this.initialization;
  }

  private async initializeOnce(): Promise<void> {
    await this.sessionManager.load();
    await this.authManager.load();
    const jwtSecret = await this.authManager.ensureApiKey();

    // Register plugins
    await this.app.register(fastifyCors, {
      origin: this.allowedOrigins.length > 0 ? this.allowedOrigins : false,
      credentials: false
    });

    await this.app.register(fastifyRateLimit, {
      max: 100,
      timeWindow: '1 minute',
      keyGenerator: (request: FastifyRequest) => {
        return request.ip;
      }
    });

    await this.app.register(fastifyJwt, {
      secret: jwtSecret,
      sign: {
        expiresIn: '1h'
      }
    });

    await this.app.register(fastifyWebsocket);

    // Add authentication decorator
    this.app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        await request.jwtVerify();
        if (!this.authManager.validateTokenPayload(request.user, 'access')) {
          throw new Error('Invalid access claims');
        }
      } catch {
        reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired token' });
      }
    });

    // Add context decorators
    this.app.decorate('sessionManager', this.sessionManager);
    this.app.decorate('authManager', this.authManager);

    // Health check (no auth required)
    this.app.get('/api/health', async () => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        sessions: this.sessionManager.count()
      };
    });

    // Register route modules
    await registerAuthRoutes(this.app, this.authManager);
    await registerSessionRoutes(this.app, this.sessionManager);
    await registerTaskRoutes(this.app, this.sessionManager);

    // Register hook routes if hook engine is available
    if (this.hookEngine) {
      await registerHookRoutes(this.app, this.hookEngine);
    }

    // Register notification routes if inbox is available
    if (this.notificationInbox) {
      await registerNotificationRoutes(this.app, this.notificationInbox);
    }

    // Register telegram routes if bot is available
    if (this.telegramBot) {
      await registerTelegramRoutes(this.app, this.telegramBot);

    }

    // External completions also feed hooks and the inbox with Telegram disabled.
    await registerNotifyRoutes(
        this.app,
        this.telegramBot,
        this.authManager,
        this.notificationInbox,
        this.onTmuxTranscript,
        this.onTmuxSession,
        this.hookEngine,
        this.notificationOutbox,
        this.onTmuxContext
      );

    // Register orchestration routes if manager is available
    if (this.orchestrationManager) {
      await registerOrchestrationRoutes(this.app, this.orchestrationManager);
    }
    this.sessionManager.on('task.terminal', this.taskTerminalHandler);
    for (const task of await this.sessionManager.listTasks()) {
      if (isTerminalTask(task.status)) await this.notificationOutbox.enqueue(Session.notificationForTask(task));
    }
    if (this.ownsOutbox) this.notificationOutbox.start();
  }

  async start(): Promise<string> {
    await this.initialize();
    const address = await this.app.listen({ host: this.host, port: this.port });
    return address;
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.sessionManager.off('task.terminal', this.taskTerminalHandler);
    await Promise.allSettled([...this.pendingEnqueues]);
    if (this.ownsOutbox) await this.notificationOutbox.stop();
  }

  getNotificationOutbox(): NotificationOutbox { return this.notificationOutbox; }

  getApp(): FastifyInstance {
    return this.app;
  }

  getAuthManager(): AuthManager {
    return this.authManager;
  }
}

// Type augmentation for Fastify
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    sessionManager: SessionManager;
    authManager: AuthManager;
  }
}
