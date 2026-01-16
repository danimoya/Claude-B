import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HookEngine } from '../../hooks/engine.js';
import { HookEventType, ALL_EVENTS } from '../../hooks/events.js';

interface AddShellHookBody {
  event: HookEventType | '*';
  command: string;
  timeout?: number;
  sessionFilter?: string;
}

interface AddWebhookBody {
  event: HookEventType | '*';
  url: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  transform?: string;
  sessionFilter?: string;
}

interface ToggleBody {
  enabled: boolean;
}

interface HookParams {
  id: string;
}

export async function registerHookRoutes(
  app: FastifyInstance,
  hookEngine: HookEngine
): Promise<void> {

  // List available events
  app.get('/api/hooks/events', {
    preHandler: [app.authenticate]
  }, async () => {
    return { events: ALL_EVENTS };
  });

  // Get hook statistics
  app.get('/api/hooks/stats', {
    preHandler: [app.authenticate]
  }, async () => {
    return hookEngine.getStats();
  });

  // Get event history
  app.get('/api/hooks/history', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Querystring: { limit?: string } }>) => {
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 50;
    return { events: hookEngine.getEventHistory(limit) };
  });

  // === Shell Hooks ===

  // List shell hooks
  app.get('/api/hooks/shell', {
    preHandler: [app.authenticate]
  }, async () => {
    return { hooks: hookEngine.listShellHooks() };
  });

  // Add shell hook
  app.post<{ Body: AddShellHookBody }>('/api/hooks/shell', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['event', 'command'],
        properties: {
          event: { type: 'string' },
          command: { type: 'string', minLength: 1 },
          timeout: { type: 'number' },
          sessionFilter: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: AddShellHookBody }>) => {
    const { event, command, timeout, sessionFilter } = request.body;
    const hook = await hookEngine.addShellHook(event, command, { timeout, sessionFilter });
    return { hook };
  });

  // Get shell hook
  app.get<{ Params: HookParams }>('/api/hooks/shell/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: HookParams }>, reply: FastifyReply) => {
    const hook = hookEngine.getShellHook(request.params.id);
    if (!hook) {
      return reply.status(404).send({ error: 'Hook not found' });
    }
    return { hook };
  });

  // Delete shell hook
  app.delete<{ Params: HookParams }>('/api/hooks/shell/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: HookParams }>, reply: FastifyReply) => {
    const deleted = await hookEngine.removeShellHook(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Hook not found' });
    }
    return { success: true };
  });

  // Toggle shell hook
  app.patch<{ Params: HookParams; Body: ToggleBody }>('/api/hooks/shell/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['enabled'],
        properties: {
          enabled: { type: 'boolean' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Params: HookParams; Body: ToggleBody }>, reply: FastifyReply) => {
    const hook = await hookEngine.toggleShellHook(request.params.id, request.body.enabled);
    if (!hook) {
      return reply.status(404).send({ error: 'Hook not found' });
    }
    return { hook };
  });

  // === Webhooks ===

  // List webhooks
  app.get('/api/hooks/webhook', {
    preHandler: [app.authenticate]
  }, async () => {
    return { webhooks: hookEngine.listWebhooks() };
  });

  // Add webhook
  app.post<{ Body: AddWebhookBody }>('/api/hooks/webhook', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['event', 'url'],
        properties: {
          event: { type: 'string' },
          url: { type: 'string', format: 'uri' },
          method: { type: 'string', enum: ['POST', 'PUT'] },
          headers: { type: 'object' },
          timeout: { type: 'number' },
          retries: { type: 'number' },
          transform: { type: 'string' },
          sessionFilter: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: AddWebhookBody }>) => {
    const { event, url, ...options } = request.body;
    const webhook = await hookEngine.addWebhook(event, url, options);
    return { webhook };
  });

  // Get webhook
  app.get<{ Params: HookParams }>('/api/hooks/webhook/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: HookParams }>, reply: FastifyReply) => {
    const webhook = hookEngine.getWebhook(request.params.id);
    if (!webhook) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return { webhook };
  });

  // Delete webhook
  app.delete<{ Params: HookParams }>('/api/hooks/webhook/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: HookParams }>, reply: FastifyReply) => {
    const deleted = await hookEngine.removeWebhook(request.params.id);
    if (!deleted) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return { success: true };
  });

  // Toggle webhook
  app.patch<{ Params: HookParams; Body: ToggleBody }>('/api/hooks/webhook/:id', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['enabled'],
        properties: {
          enabled: { type: 'boolean' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Params: HookParams; Body: ToggleBody }>, reply: FastifyReply) => {
    const webhook = await hookEngine.toggleWebhook(request.params.id, request.body.enabled);
    if (!webhook) {
      return reply.status(404).send({ error: 'Webhook not found' });
    }
    return { webhook };
  });
}
