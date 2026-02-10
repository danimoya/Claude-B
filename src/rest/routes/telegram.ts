import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ClaudeBTelegramBot } from '../../telegram/bot.js';

interface SetupBody {
  token: string;
}

export async function registerTelegramRoutes(
  app: FastifyInstance,
  telegramBot: ClaudeBTelegramBot
): Promise<void> {

  // Start the Telegram bot
  app.post<{ Body: SetupBody }>('/api/telegram/setup', {
    preHandler: [app.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string', minLength: 1 }
        }
      }
    }
  }, async (request: FastifyRequest<{ Body: SetupBody }>, reply: FastifyReply) => {
    const { token } = request.body;

    try {
      const result = await telegramBot.start(token);
      return { success: true, username: result.username };
    } catch (error) {
      return reply.status(500).send({
        error: 'Setup Failed',
        message: error instanceof Error ? error.message : 'Failed to start Telegram bot'
      });
    }
  });

  // Stop the Telegram bot
  app.post('/api/telegram/stop', {
    preHandler: [app.authenticate]
  }, async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      await telegramBot.stop();
      return { success: true };
    } catch (error) {
      return reply.status(500).send({
        error: 'Stop Failed',
        message: error instanceof Error ? error.message : 'Failed to stop Telegram bot'
      });
    }
  });

  // Get Telegram bot status
  app.get('/api/telegram/status', {
    preHandler: [app.authenticate]
  }, async () => {
    const config = telegramBot.getConfig();
    return {
      running: telegramBot.isRunning(),
      enabled: config.enabled,
      chatIds: config.chatIds
    };
  });
}
