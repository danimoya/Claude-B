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

export interface RestServerOptions {
  host: string;
  port: number;
  sessionManager: SessionManager;
  hookEngine?: HookEngine;
  notificationInbox?: NotificationInbox;
  telegramBot?: ClaudeBTelegramBot;
  orchestrationManager?: OrchestrationManager;
  configDir: string;
  // Optional hook invoked by /api/notify when the payload carries a
  // transcriptPath. Daemon uses this to cache tmux session → transcript
  // mappings for the voice pipeline's context lookup.
  onTmuxTranscript?: (sessionId: string, transcriptPath: string) => void;
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
  private host: string;
  private port: number;

  constructor(options: RestServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.sessionManager = options.sessionManager;
    this.hookEngine = options.hookEngine || null;
    this.notificationInbox = options.notificationInbox || null;
    this.telegramBot = options.telegramBot || null;
    this.orchestrationManager = options.orchestrationManager || null;
    this.onTmuxTranscript = options.onTmuxTranscript || null;
    this.authManager = new AuthManager(options.configDir);

    this.app = Fastify({
      logger: {
        level: 'info'
      }
    });
  }

  async initialize(): Promise<void> {
    await this.authManager.load();
    const jwtSecret = await this.authManager.ensureApiKey();

    // Register plugins
    await this.app.register(fastifyCors, {
      origin: true,
      credentials: true
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
      } catch (err) {
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

      // Register /api/notify ingest — external hook sink for tmux-hosted
      // Claude Code sessions. Only available when the bot is running.
      await registerNotifyRoutes(
        this.app,
        this.telegramBot,
        this.authManager,
        this.notificationInbox,
        this.onTmuxTranscript
      );
    }

    // Register orchestration routes if manager is available
    if (this.orchestrationManager) {
      await registerOrchestrationRoutes(this.app, this.orchestrationManager);
    }
  }

  async start(): Promise<string> {
    await this.initialize();
    const address = await this.app.listen({ host: this.host, port: this.port });
    return address;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

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
