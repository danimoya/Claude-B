import type { FastifyInstance, FastifyReply } from 'fastify';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { SessionManager } from '../../daemon/session-manager.js';
import { TaskConflictError, type TaskRecord, type TaskSubmission } from '../../jobs/types.js';
import type { ExecutionPolicy } from '../../session/session.js';

export interface TaskBody extends TaskSubmission {
  prompt: string;
  sessionId?: string;
  workingDir?: string;
  model?: string;
  executionPolicy?: ExecutionPolicy;
}
export const taskSubmissionProperties = {
  taskId: { type: 'string', pattern: '^[a-zA-Z0-9_-]{8,128}$' },
  idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 }
};

export function submissionOptions(body: TaskSubmission, header: string | string[] | undefined): TaskSubmission {
  if (Array.isArray(header) || (header !== undefined && (!header || header.length > 256))) throw new Error('Invalid Idempotency-Key header');
  if (header && body.idempotencyKey && header !== body.idempotencyKey) throw new TaskConflictError('Header and body idempotency keys differ');
  return { taskId: body.taskId, idempotencyKey: body.idempotencyKey ?? header };
}
export function acceptedTask(task: TaskRecord) {
  return { taskId: task.id, promptId: task.id, sessionId: task.sessionId, status: 'accepted' as const, taskStatus: task.status };
}
export function taskError(reply: FastifyReply, error: unknown) {
  if (error instanceof TaskConflictError) return reply.status(409).send({ error: 'Task Conflict', message: error.message });
  if (error instanceof Error && (/^Invalid |^Prompt must |^Working directory |^Execution policy |^Idempotency-Key/.test(error.message) ||
      ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code || ''))) {
    return reply.status(400).send({ error: 'Invalid task submission', message: 'Check prompt, working directory, model and idempotency fields' });
  }
  return reply.status(500).send({ error: 'Task submission failed', message: 'The durable task receipt could not be stored' });
}

export async function registerTaskRoutes(app: FastifyInstance, manager: SessionManager): Promise<void> {
  app.post<{ Body: TaskBody }>('/api/tasks', { preHandler: [app.authenticate], schema: { body: {
    type: 'object', additionalProperties: false, required: ['prompt'], properties: {
      prompt: { type: 'string', minLength: 1 }, sessionId: { type: 'string', minLength: 1 },
      workingDir: { type: 'string', minLength: 1 }, model: { type: 'string', minLength: 1 },
      executionPolicy: { type: 'string', enum: ['default', 'bypass'] }, ...taskSubmissionProperties
    }
  } } }, async (request, reply) => {
    try {
      const body = request.body;
      if (!body.prompt.trim() || (body.workingDir && !isAbsolute(body.workingDir))) throw new Error('Invalid prompt or working directory');
      const options = submissionOptions(body, request.headers['idempotency-key']);
      const store = manager.getTaskStore();
      const byId = options.taskId ? await store.get(options.taskId) : null;
      const byKey = options.idempotencyKey ? await store.findByIdempotencyKey(options.idempotencyKey) : null;
      if (byId && byKey && byId.id !== byKey.id) throw new TaskConflictError();
      const existing = byId || byKey;
      if (existing) {
        let directory = body.workingDir;
        if (directory) { try { directory = realpathSync(directory); } catch { directory = resolve(directory); } }
        if ((options.taskId && options.taskId !== existing.id) || existing.prompt !== body.prompt ||
            (options.idempotencyKey && existing.idempotencyKey !== options.idempotencyKey) ||
            (body.sessionId && existing.sessionId !== body.sessionId) ||
            (directory && existing.workingDir !== directory) ||
            (body.model !== undefined && existing.model !== body.model) ||
            (body.executionPolicy !== undefined && existing.executionPolicy !== body.executionPolicy)) throw new TaskConflictError();
        return reply.status(202).send(acceptedTask(existing));
      }
      const session = body.sessionId ? manager.get(body.sessionId)
        : await manager.create(undefined, body.model, undefined, false, body.workingDir, body.executionPolicy);
      if (!session) return reply.status(404).send({ error: 'Session not found' });
      const state = session.getState();
      if ((body.model !== undefined && body.model !== state.model) ||
          (body.executionPolicy !== undefined && body.executionPolicy !== state.executionPolicy) ||
          (body.workingDir !== undefined && realpathSync(body.workingDir) !== state.workingDir)) throw new TaskConflictError('Explicit session settings differ from this submission');
      const id = await session.sendPrompt(body.prompt, options);
      const task = await store.get(id);
      if (!task) throw new Error('Durable task receipt unavailable');
      if (body.sessionId && task.sessionId !== body.sessionId) throw new TaskConflictError('Task belongs to a different session');
      return reply.status(202).send(acceptedTask(task));
    } catch (error) { return taskError(reply, error); }
  });

  app.get<{ Querystring: { sessionId?: string } }>('/api/tasks', { preHandler: [app.authenticate] }, async request => {
    return { tasks: await manager.listTasks(request.query.sessionId) };
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', { preHandler: [app.authenticate], schema: {
    params: { type: 'object', required: ['id'], properties: { id: taskSubmissionProperties.taskId } }
  } }, async (request, reply) => {
    const task = await manager.getTask(request.params.id);
    return task ? { task } : reply.status(404).send({ error: 'Task not found' });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', { preHandler: [app.authenticate], schema: {
    params: { type: 'object', required: ['id'], properties: { id: taskSubmissionProperties.taskId } }
  } }, async (request, reply) => {
    const task = await manager.cancelTask(request.params.id);
    return task ? { task } : reply.status(404).send({ error: 'Task not found' });
  });
}
