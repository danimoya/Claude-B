import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OrchestrationManager, createHost, redactRemoteHost } from '../../orchestration/index.js';
import { RemoteRequestError, type RemoteReceipt } from '../../orchestration/receipts.js';
import type { RemotePromptResult } from '../../orchestration/remote-client.js';
import { TaskConflictError } from '../../jobs/types.js';
import { submissionOptions, taskSubmissionProperties } from './tasks.js';

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
  taskId?: string;
  idempotencyKey?: string;
  waitForCompletion?: boolean;
}

interface ResumeBody { timeout?: number; waitForCompletion?: boolean }
const requestProperties = {
  timeout: { type: 'integer', minimum: 1, maximum: 300000 },
  waitForCompletion: { type: 'boolean' }
};
const receiptParams = { type: 'object', required: ['id'], properties: { id: taskSubmissionProperties.taskId } };

function orchestrationError(reply: FastifyReply, error: unknown) {
  if (error instanceof TaskConflictError) return reply.status(409).send({ error: 'Remote task conflict' });
  if (error instanceof RemoteRequestError) {
    if (error.failureKind === 'rejected') return reply.status(400).send({ error: 'Remote request rejected' });
    if (error.failureKind === 'auth') return reply.status(502).send({ error: 'Remote authentication failed' });
  }
  return reply.status(503).send({ error: 'Remote operation unavailable', message: 'The saved receipt can be inspected before retrying' });
}

// Explicit response fields keep transport/configuration objects out of API results.
function publicResult(result: RemotePromptResult): RemotePromptResult {
  return {
    sessionId: result.sessionId, promptId: result.promptId, taskId: result.taskId,
    receiptId: result.receiptId, status: result.status, taskStatus: result.taskStatus,
    failureKind: result.failureKind, retrySafe: result.retrySafe, output: result.output,
    error: result.error, host: result.host, latency: result.latency
  };
}
function publicReceipt(task: RemoteReceipt): RemoteReceipt {
  return {
    id: task.id, receiptId: task.receiptId, taskId: task.taskId, remoteTaskId: task.remoteTaskId,
    hostId: task.hostId, sessionId: task.sessionId, prompt: task.prompt, goal: task.goal, idempotencyKey: task.idempotencyKey,
    status: task.status, taskStatus: task.taskStatus, createdAt: task.createdAt, updatedAt: task.updatedAt,
    submittedAt: task.submittedAt, output: task.output, error: task.error,
    failureKind: task.failureKind, retrySafe: task.retrySafe
  };
}
function sendResult(reply: FastifyReply, result: RemotePromptResult) {
  if (result.status === 'error' && !result.taskStatus) {
    const status = result.failureKind === 'auth' ? 502 : result.failureKind === 'rejected' ? 400 : 503;
    return reply.status(status).send(publicResult(result));
  }
  return reply.status(['accepted', 'uncertain'].includes(result.status) ? 202 : 200).send(publicResult(result));
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
  }, async (request: FastifyRequest<{ Body: AddHostBody }>, reply) => {
    const { url, apiKey, name, priority } = request.body;
    let host;
    try { host = createHost(url, apiKey, { name, priority }); }
    catch { return reply.status(400).send({ error: 'Invalid remote host URL' }); }
    try {
      await orchestrationManager.addHost(host);
      return { host: redactRemoteHost(host) };
    } catch (error) { return orchestrationError(reply, error); }
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
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1 },
          hostId: { type: 'string', minLength: 1 },
          sessionId: { type: 'string', minLength: 1 },
          ...taskSubmissionProperties,
          ...requestProperties
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: PromptBody }>, reply: FastifyReply) => {
    try {
      const { prompt, hostId, sessionId, timeout, waitForCompletion } = request.body;
      if (!prompt.trim()) return reply.status(400).send({ error: 'Prompt must contain text' });
      let options;
      try { options = submissionOptions(request.body, request.headers['idempotency-key']); }
      catch (error) {
        if (error instanceof TaskConflictError) throw error;
        return reply.status(400).send({ error: 'Invalid idempotency header' });
      }
      if (hostId && !orchestrationManager.listHosts().some(host => host.id === hostId)) {
        return reply.status(404).send({ error: 'Host not found' });
      }
      const existing = (await orchestrationManager.listRemoteTasks()).find(task =>
        (options.idempotencyKey && task.idempotencyKey === options.idempotencyKey) ||
        (options.taskId && task.taskId === options.taskId));
      if (existing && (existing.prompt !== prompt || (sessionId && existing.sessionId !== sessionId) ||
          (hostId && existing.hostId !== hostId) || (options.taskId && existing.taskId !== options.taskId) ||
          (options.idempotencyKey && existing.idempotencyKey !== options.idempotencyKey))) throw new TaskConflictError();
      const result = await orchestrationManager.sendPrompt(prompt, { hostId, sessionId, timeout, waitForCompletion, ...options });
      return sendResult(reply, result);
    } catch (error) {
      return orchestrationError(reply, error);
    }
  });

  app.get('/api/orchestration/tasks', { preHandler: [app.authenticate] }, async (_request, reply) => {
    try { return { tasks: (await orchestrationManager.listRemoteTasks()).map(publicReceipt) }; }
    catch (error) { return orchestrationError(reply, error); }
  });
  app.get<{ Params: HostParams }>('/api/orchestration/tasks/:id', {
    preHandler: [app.authenticate], schema: { params: receiptParams }
  }, async (request, reply) => {
    try {
      const task = await orchestrationManager.getRemoteTask(request.params.id);
      return task ? { task: publicReceipt(task) } : reply.status(404).send({ error: 'Remote receipt not found' });
    } catch (error) { return orchestrationError(reply, error); }
  });
  app.post<{ Params: HostParams; Body: ResumeBody | undefined }>('/api/orchestration/tasks/:id/resume', {
    preHandler: [app.authenticate],
    preValidation: async request => { request.body ??= {}; },
    schema: { params: receiptParams,
      body: { type: 'object', additionalProperties: false, properties: requestProperties }
    }
  }, async (request, reply) => {
    try {
      const task = await orchestrationManager.getRemoteTask(request.params.id);
      if (!task) return reply.status(404).send({ error: 'Remote receipt not found' });
      if (!orchestrationManager.listHosts().some(host => host.id === task.hostId)) {
        return reply.status(409).send({ error: 'Saved receipt host is not configured' });
      }
      return sendResult(reply, await orchestrationManager.resumeRemoteTask(task.id, request.body || {}));
    } catch (error) { return orchestrationError(reply, error); }
  });
}
