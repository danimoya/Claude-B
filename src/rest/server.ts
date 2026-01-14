import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyWebsocket from '@fastify/websocket';
import { SessionManager } from '../daemon/session-manager.js';
import { HookEngine } from '../hooks/engine.js';
import { AuthManager } from './auth.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerHookRoutes } from './routes/hooks.js';

export interface RestServerOptions {
  host: string;
  port: number;
  sessionManager: SessionManager;
  hookEngine?: HookEngine;
  configDir: string;
}

export class RestServer {
  private app: FastifyInstance;
  private sessionManager: SessionManager;
  private hookEngine: HookEngine | null;
  private authManager: AuthManager;
  private host: string;
  private port: number;

  constructor(options: RestServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.sessionManager = options.sessionManager;
    this.hookEngine = options.hookEngine || null;
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
