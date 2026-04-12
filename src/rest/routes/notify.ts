import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ClaudeBTelegramBot } from '../../telegram/bot.js';
import { AuthManager } from '../auth.js';
import { NotificationInbox } from '../../notifications/inbox.js';

// Payload accepted from external hook scripts (e.g. Claude Code Stop hook
// running inside a tmux pane). The pane reports its own completion — Claude-B
// simply relays it to Telegram via the existing broadcastNotification path.
interface NotifyBody {
  sessionId: string;         // opaque; use "tmux:<target>" for tmux-hosted sessions
  sessionName?: string;      // human label, e.g. "dimensigon:1.0 ✳ Investigate repository"
  type?: 'prompt.completed' | 'prompt.error';
  goal?: string;
  exitCode?: number | null;
  durationMs?: number;
  costUsd?: number;
  resultPreview?: string;    // last assistant text (full; bot truncates for display)
  transcriptPath?: string;   // absolute path to the Claude Code session JSONL;
                             // cached so the voice pipeline can ground
                             // optimizePrompt in real turn history
}

/**
 * Registers POST /api/notify — a localhost-only, header-auth ingest endpoint
 * used by external Claude Code sessions (running in tmux panes) to push
 * "response finished" events into Claude-B's Telegram pipeline.
 *
 * Auth: request.ip must be loopback AND header `x-claude-b-key` must match
 * the on-disk API key. No JWT dance — the hook script is a bash one-liner.
 */
export async function registerNotifyRoutes(
  app: FastifyInstance,
  telegramBot: ClaudeBTelegramBot,
  authManager: AuthManager,
  inbox: NotificationInbox | null,
  onTmuxTranscript: ((sessionId: string, transcriptPath: string) => void) | null
): Promise<void> {

  app.post<{ Body: NotifyBody }>('/api/notify', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId:     { type: 'string', minLength: 1 },
          sessionName:   { type: 'string' },
          type:          { type: 'string', enum: ['prompt.completed', 'prompt.error'] },
          goal:          { type: 'string' },
          exitCode:      { type: ['integer', 'null'] },
          durationMs:    { type: 'number' },
          costUsd:       { type: 'number' },
          resultPreview: { type: 'string' },
          transcriptPath:{ type: 'string' },
        },
      },
    },
  }, async (request: FastifyRequest<{ Body: NotifyBody }>, reply: FastifyReply) => {
    // Localhost-only
    const isLocalhost = request.ip === '127.0.0.1' ||
                        request.ip === '::1' ||
                        request.ip === '::ffff:127.0.0.1';
    if (!isLocalhost) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Localhost only' });
    }

    // API key header
    const providedKey = request.headers['x-claude-b-key'];
    const key = Array.isArray(providedKey) ? providedKey[0] : providedKey;
    if (!key || !authManager.validateApiKey(key)) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid API key' });
    }

    // Bot must be running to deliver anything
    if (!telegramBot.isRunning()) {
      return reply.status(503).send({ error: 'Bot offline', message: 'Telegram bot not running' });
    }

    const body = request.body;
    const notif = {
      sessionId:    body.sessionId,
      sessionName:  body.sessionName,
      type:         body.type || 'prompt.completed',
      goal:         body.goal,
      exitCode:     body.exitCode ?? 0,
      durationMs:   body.durationMs,
      costUsd:      body.costUsd,
      resultPreview: body.resultPreview,
    };

    // Cache the transcript path for this tmux session so the voice pipeline
    // can later ground optimizePrompt with real turn history. Fire-and-forget;
    // if the callback isn't wired, skip silently.
    if (body.transcriptPath && onTmuxTranscript) {
      try {
        onTmuxTranscript(body.sessionId, body.transcriptPath);
      } catch { /* non-fatal */ }
    }

    // Fire broadcast. Don't await Telegram — return fast so the hook script
    // doesn't block the host Claude Code response.
    telegramBot.broadcastNotification(notif).catch((err) => {
      app.log.error({ err }, 'broadcastNotification failed in /api/notify');
    });

    // Also persist to the inbox so `cb -i` shows it
    if (inbox) {
      inbox.addNotification({
        ...notif,
        resultFull: body.resultPreview?.slice(0, 50000),
        viewCommand: 'cb -i',
      }).catch(() => { /* non-fatal */ });
    }

    return { ok: true };
  });
}
