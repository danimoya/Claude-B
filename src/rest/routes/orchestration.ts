import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OrchestrationManager, createHost } from '../../orchestration/index.js';

interface HostParams {
  id: string;
}

interface AddHostBody {
  url: string;
  apiKey: string;
  name?: string;
  priority?: number;
}

interface ToggleHostBody {
  enabled: boolean;
}

interface PromptBody {
  prompt: string;
  hostId?: string;
  sessionId?: string;
  timeout?: number;
}

export async function registerOrchestrationRoutes(
  app: FastifyInstance,
  orchestrationManager: OrchestrationManager
): Promise<void> {

  // List hosts
  app.get('/api/orchestration/hosts', {
    preHandler: [app.authenticate]
  }, async () => {
    return { hosts: orchestrationManager.listHosts() };
  });

  // Add host
  app.post<{ Body: AddHostBody }>('/api/orchestration/hosts', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['url', 'apiKey'],
        properties: {
          url: { type: 'string', minLength: 1 },
          apiKey: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          priority: { type: 'number' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: AddHostBody }>) => {
    const { url, apiKey, name, priority } = request.body;
    const host = createHost(url, apiKey, { name, priority });
    await orchestrationManager.addHost(host);
    return { host };
  });

  // Remove host
  app.delete<{ Params: HostParams }>('/api/orchestration/hosts/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: HostParams }>, reply: FastifyReply) => {
    const { id } = request.params;
    const removed = await orchestrationManager.removeHost(id);
    if (!removed) {
      return reply.status(404).send({ error: 'Host not found' });
    }
    return { success: true };
  });

  // Toggle host enabled/disabled
  app.patch<{ Params: HostParams; Body: ToggleHostBody }>('/api/orchestration/hosts/:id', {
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
  }, async (request: FastifyRequest<{ Params: HostParams; Body: ToggleHostBody }>, reply: FastifyReply) => {
    const { id } = request.params;
    const toggled = await orchestrationManager.toggleHost(id, request.body.enabled);
    if (!toggled) {
      return reply.status(404).send({ error: 'Host not found' });
    }
    return { success: true, hostId: id, enabled: request.body.enabled };
  });

  // Health status
  app.get('/api/orchestration/health', {
    preHandler: [app.authenticate]
  }, async () => {
    return orchestrationManager.getHealthStatus();
  });

  // Stats (convert circuitBreakers Map to object)
  app.get('/api/orchestration/stats', {
    preHandler: [app.authenticate]
  }, async () => {
    const stats = orchestrationManager.getStats();
    return {
      ...stats,
      circuitBreakers: Object.fromEntries(stats.circuitBreakers)
    };
  });

  // Send prompt to remote host
  app.post<{ Body: PromptBody }>('/api/orchestration/prompt', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1 },
          hostId: { type: 'string' },
          sessionId: { type: 'string' },
          timeout: { type: 'number' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: PromptBody }>, reply: FastifyReply) => {
    const { prompt, hostId, sessionId, timeout } = request.body;

    try {
      const result = await orchestrationManager.sendPrompt(prompt, { hostId, sessionId, timeout });
      return result;
    } catch (error) {
      return reply.status(500).send({
        error: 'Orchestration Error',
        message: error instanceof Error ? error.message : 'Failed to send prompt'
      });
    }
  });
}
