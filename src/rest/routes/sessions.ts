import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SessionManager } from '../../daemon/session-manager.js';
import { WebSocket } from 'ws';

interface CreateSessionBody {
  name?: string;
}

interface SendPromptBody {
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
          name: { type: 'string' }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: CreateSessionBody }>) => {
    const { name } = request.body || {};
    const session = await sessionManager.create(name);

    return {
      id: session.id,
      name: session.name,
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
      status: state.status,
      createdAt: state.createdAt,
      workingDir: state.workingDir,
      promptCount: state.promptCount,
      lastPromptId: state.lastPromptId
    };
  });

  // Delete/kill session
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
          prompt: { type: 'string', minLength: 1 }
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
      const promptId = await session.sendPrompt(prompt);
      return {
        sessionId: id,
        promptId,
        status: 'queued',
        message: 'Prompt queued for processing'
      };
    } catch (error) {
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: error instanceof Error ? error.message : 'Failed to send prompt'
      });
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
  }, async (request: FastifyRequest, reply: FastifyReply) => {
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

    // Subscribe to session events
    session.on('output', outputHandler);
    session.on('prompt.completed', completionHandler);

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
          session.sendPrompt(msg.prompt).then(promptId => {
            socket.send(JSON.stringify({
              type: 'prompt.queued',
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
    });

    socket.on('error', () => {
      session.off('output', outputHandler);
      session.off('prompt.completed', completionHandler);
    });
  });
}
