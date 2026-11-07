import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionManager } from '../../daemon/session-manager.js';
import { WebSocket } from 'ws';
import type { TaskSubmission } from '../../jobs/types.js';
import { acceptedTask, submissionOptions, taskError, taskSubmissionProperties } from './tasks.js';

interface CreateSessionBody {
  name?: string;
  model?: string;
  workingDir?: string;
  executionPolicy?: 'default' | 'bypass';
}

interface SendPromptBody extends TaskSubmission {
  prompt: string;
}

interface SessionParams {
  id: string;
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager
): Promise<void> {

  // List all sessions
  app.get('/api/sessions', {
    preHandler: [app.authenticate]
  }, async () => {
    const sessions = sessionManager.list();
    return {
      sessions,
      count: sessions.length
    };
  });

  // Create new session
  app.post<{ Body: CreateSessionBody }>('/api/sessions', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          model: { type: 'string' },
          workingDir: { type: 'string', minLength: 1 },
          executionPolicy: { type: 'string', enum: ['default', 'bypass'] }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: CreateSessionBody }>) => {
    const { name, model, workingDir, executionPolicy } = request.body || {};
    const session = await sessionManager.create(name, model, undefined, false, workingDir, executionPolicy);

    return {
      id: session.id,
      name: session.name,
      model: session.model,
      executionPolicy: session.executionPolicy,
      status: session.status,
      createdAt: session.createdAt
    };
  });

  // Get session details
  app.get<{ Params: SessionParams }>('/api/sessions/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
    const { id } = request.params;
    const session = sessionManager.get(id);

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Session not found: ${id}`
      });
    }

    const state = session.getState();
    return {
      id: state.id,
      name: state.name,
      model: state.model,
      status: state.status,
      createdAt: state.createdAt,
      workingDir: state.workingDir,
      executionPolicy: state.executionPolicy,
      promptCount: state.promptCount,
      lastPromptId: state.lastPromptId
    };
  });

  // Delete/kill session
  app.post<{ Params: SessionParams; Body: { executionPolicy: 'default' | 'bypass' } }>('/api/sessions/:id/policy', {
    preHandler: [app.authenticate],
    schema: { body: { type: 'object', required: ['executionPolicy'], properties: {
      executionPolicy: { type: 'string', enum: ['default', 'bypass'] }
    } } }
  }, async (request, reply) => {
    const session = sessionManager.get(request.params.id);
    if (!session) return reply.status(404).send({ error: 'Session not found' });
    try { await sessionManager.setExecutionPolicy(session.id, request.body.executionPolicy); }
    catch { return reply.status(409).send({ error: 'Cannot change execution policy while tasks are pending or shutdown is in progress' }); }
    return { sessionId: session.id, executionPolicy: session.executionPolicy };
  });

  app.delete<{ Params: SessionParams }>('/api/sessions/:id', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
    const { id } = request.params;

    try {
      await sessionManager.kill(id);
      return { success: true, message: `Session ${id} terminated` };
    } catch (error) {
      return reply.status(404).send({
        error: 'Not Found',
        message: error instanceof Error ? error.message : 'Session not found'
      });
    }
  });

  // Get session output (last prompt result)
  app.get<{ Params: SessionParams }>('/api/sessions/:id/last', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
    const { id } = request.params;
    const session = sessionManager.get(id);

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Session not found: ${id}`
      });
    }

    return {
      sessionId: id,
      output: session.getLastOutput(),
      status: session.status
    };
  });

  // Get full session transcript
  app.get<{ Params: SessionParams }>('/api/sessions/:id/transcript', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
    const { id } = request.params;
    const session = sessionManager.get(id);

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Session not found: ${id}`
      });
    }

    const transcript = await session.exportTranscript();
    return {
      sessionId: id,
      transcript
    };
  });

  // Send prompt to session
  app.post<{ Params: SessionParams; Body: SendPromptBody }>('/api/sessions/:id/prompt', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', minLength: 1 },
          ...taskSubmissionProperties
        }
      }
    }
  }, async (request: FastifyRequest<{ Params: SessionParams; Body: SendPromptBody }>, reply: FastifyReply) => {
    const { id } = request.params;
    const { prompt } = request.body;

    const session = sessionManager.get(id);

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: `Session not found: ${id}`
      });
    }

    try {
      const options = submissionOptions(request.body, request.headers['idempotency-key']);
      const promptId = await session.sendPrompt(prompt, options);
      const task = await sessionManager.getTask(promptId);
      if (!task) throw new Error('Durable task receipt unavailable');
      if (task.sessionId !== session.id) return reply.status(409).send({ error: 'Task belongs to a different session' });
      return reply.status(202).send(acceptedTask(task));
    } catch (error) {
      return taskError(reply, error);
    }
  });

  // Select session as current
  app.post<{ Params: SessionParams }>('/api/sessions/:id/select', {
    preHandler: [app.authenticate]
  }, async (request: FastifyRequest<{ Params: SessionParams }>, reply: FastifyReply) => {
    const { id } = request.params;

    try {
      sessionManager.select(id);
      return { success: true, message: `Session ${id} selected` };
    } catch (error) {
      return reply.status(404).send({
        error: 'Not Found',
        message: error instanceof Error ? error.message : 'Session not found'
      });
    }
  });

  // Get current selected session
  app.get('/api/sessions/current', {
    preHandler: [app.authenticate]
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    const session = sessionManager.current();

    if (!session) {
      return reply.status(404).send({
        error: 'Not Found',
        message: 'No session currently selected'
      });
    }

    const state = session.getState();
    return {
      id: state.id,
      name: state.name,
      status: state.status,
      createdAt: state.createdAt
    };
  });

  // WebSocket: Live stream session output
  app.get<{ Params: SessionParams }>('/api/sessions/:id/stream', {
    websocket: true,
    preHandler: [app.authenticate]
  }, (socket: WebSocket, request: FastifyRequest<{ Params: SessionParams }>) => {
    const { id } = request.params;
    const session = sessionManager.get(id);

    if (!session) {
      socket.send(JSON.stringify({
        type: 'error',
        error: 'Session not found'
      }));
      socket.close(1008, 'Session not found');
      return;
    }

    // Send connection confirmation
    socket.send(JSON.stringify({
      type: 'connected',
      sessionId: id,
      status: session.status
    }));

    // Create a handler for session output
    const outputHandler = (data: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'output',
          data: { content: data }
        }));
      }
    };

    // Create a handler for prompt completion
    const completionHandler = (info: { promptId?: string; code?: number }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          type: 'prompt.completed',
          promptId: info.promptId,
          exitCode: info.code
        }));
      }
    };
    const errorHandler = (info: { promptId?: string; code?: number | null; error?: string }) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'prompt.error', promptId: info.promptId, exitCode: info.code, error: info.error }));
      }
    };

    // Subscribe to session events
    session.on('output', outputHandler);
    session.on('prompt.completed', completionHandler);
    session.on('prompt.error', errorHandler);

    // Send buffered output
    const lastOutput = session.getLastOutput();
    if (lastOutput) {
      socket.send(JSON.stringify({
        type: 'output',
        data: { content: lastOutput, buffered: true }
      }));
    }

    // Handle client messages (for sending input)
    socket.on('message', (message: Buffer) => {
      try {
        const msg = JSON.parse(message.toString());

        if (msg.type === 'input' && msg.data) {
          session.writeStdin(msg.data);
        } else if (msg.type === 'prompt' && msg.prompt) {
          session.sendPrompt(msg.prompt, { taskId: msg.taskId, idempotencyKey: msg.idempotencyKey }).then(promptId => {
            socket.send(JSON.stringify({
              type: 'prompt.queued',
              status: 'accepted',
              taskId: promptId,
              promptId
            }));
          }).catch(error => {
            socket.send(JSON.stringify({
              type: 'error',
              error: error.message
            }));
          });
        } else if (msg.type === 'resize' && msg.cols && msg.rows) {
          session.resize(msg.cols, msg.rows);
        }
      } catch {
        // Ignore invalid messages
      }
    });

    // Cleanup on disconnect
    socket.on('close', () => {
      session.off('output', outputHandler);
      session.off('prompt.completed', completionHandler);
      session.off('prompt.error', errorHandler);
    });

    socket.on('error', () => {
      session.off('output', outputHandler);
      session.off('prompt.completed', completionHandler);
      session.off('prompt.error', errorHandler);
    });
  });
}
