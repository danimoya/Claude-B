import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { ClaudeBTelegramBot } from '../../telegram/bot.js';
import { AuthManager } from '../auth.js';
import { NotificationInbox, type NotificationInput } from '../../notifications/inbox.js';
import { NotificationConflictError, type NotificationOutbox } from '../../notifications/outbox.js';
import { HookEngine } from '../../hooks/engine.js';
import { randomUUID } from 'node:crypto';

// Payload accepted from external hook scripts (e.g. Claude Code Stop hook
// running inside a tmux pane). The pane reports its own completion — Claude-B
// dispatches it to hooks and the inbox, with optional Telegram delivery.
interface NotifyBody {
  eventId?: string;
  sessionId: string;         // opaque; use "tmux:<target>" for tmux-hosted sessions
  sessionName?: string;      // human label, e.g. "dimensigon:1.0 ✳ Investigate repository"
  type?: 'prompt.completed' | 'prompt.error';
  goal?: string;
  exitCode?: number | null;
  durationMs?: number;
  costUsd?: number;
  resultPreview?: string;    // last assistant text (full; bot truncates for display)
  transcriptPath?: string;   // absolute path to the Claude Code / Codex session
                             // JSONL; cached so the voice pipeline can ground
                             // optimizePrompt in real turn history
  agent?: string;            // originating agent, e.g. "codex". Claude Code's
                             // cb-notify.sh omits it. Lets the daemon register
                             // Codex tmux panes (which tmux reports as `node`,
                             // so they can't be enumerated like Claude panes).
}

/**
 * Registers POST /api/notify — a localhost-only, header-auth ingest endpoint
 * used by external Claude Code sessions (running in tmux panes) to push
 * completion/error events into Claude-B's hooks, inbox and Telegram sinks.
 *
 * Auth: request.ip must be loopback AND header `x-claude-b-key` must match
 * the on-disk API key. No JWT dance — the hook script is a bash one-liner.
 */
export async function registerNotifyRoutes(
  app: FastifyInstance,
  telegramBot: ClaudeBTelegramBot | null,
  authManager: AuthManager,
  inbox: NotificationInbox | null,
  onTmuxTranscript: ((sessionId: string, transcriptPath: string) => void) | null,
  onTmuxSession: ((sessionId: string, sessionName: string | undefined, agent: string, goal: string | undefined) => string | void | Promise<string | void>) | null,
  hookEngine: HookEngine | null = null,
  outbox: NotificationOutbox | null = null
): Promise<void> {

  app.post<{ Body: NotifyBody }>('/api/notify', {
    schema: {
      body: {
        type: 'object',
        required: ['sessionId'],
        properties: {
          sessionId:     { type: 'string', minLength: 1 },
          eventId:       { type: 'string', minLength: 1, maxLength: 256 },
          sessionName:   { type: 'string' },
          type:          { type: 'string', enum: ['prompt.completed', 'prompt.error'] },
          goal:          { type: 'string' },
          exitCode:      { type: ['integer', 'null'] },
          durationMs:    { type: 'number', minimum: 0 },
          costUsd:       { type: 'number', minimum: 0 },
          resultPreview: { type: 'string' },
          transcriptPath:{ type: 'string' },
          agent:         { type: 'string' },
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

    const body = request.body;
    const notif = {
      sessionId:    body.sessionId,
      sessionName:  body.sessionName,
      type:         body.type || 'prompt.completed' as const,
      goal:         body.goal,
      exitCode:     body.exitCode ?? (body.type === 'prompt.error' ? 1 : 0),
      durationMs:   body.durationMs,
      costUsd:      body.costUsd,
      resultPreview: body.resultPreview,
    };

    // Bind display addresses to the recorded stable pane/process identity
    // before persisting routing context. Resolution failures remain non-fatal.
    if (onTmuxSession && body.sessionId.startsWith('tmux:')) {
      try {
        const canonical = await onTmuxSession(body.sessionId, body.sessionName, body.agent || 'claude', body.goal);
        if (typeof canonical === 'string' && canonical) notif.sessionId = canonical;
      } catch { /* accepted notifications remain independent of pane discovery */ }
    }
    if (body.transcriptPath && onTmuxTranscript) {
      try { await onTmuxTranscript(notif.sessionId, body.transcriptPath); } catch { /* non-fatal */ }
    }

    if (outbox) {
      const eventId = `external:${body.eventId || randomUUID()}`;
      const notification: NotificationInput = {
        ...notif, deliveryId: eventId, promptId: eventId, agent: body.agent,
        transcriptPath: body.transcriptPath, resultFull: body.resultPreview?.slice(0, 50000), viewCommand: 'cb -i'
      };
      try {
        await outbox.enqueue(notification, eventId);
        // Persist the local inbox before acknowledging ingestion; network
        // channels remain asynchronous and retry through durable receipts.
        if (inbox) await inbox.addNotification(notification);
      } catch (error) {
        if (error instanceof NotificationConflictError) return reply.status(409).send({ error: 'Notification event ID conflicts with an existing event' });
        return reply.status(503).send({ error: 'Notification storage unavailable' });
      }
      void outbox.drain().catch(() => app.log.error('Notification delivery deferred'));
      return { ok: true };
    }

    // Each delivery channel is independent. Start the hooks exactly once;
    // their retries must not block the external agent's Stop hook.
    if (hookEngine) {
      const context = {
        ...notif,
        agent: body.agent,
        transcriptPath: body.transcriptPath,
        promptId: randomUUID(),
      };
      const dispatch = notif.type === 'prompt.error'
        ? () => hookEngine.dispatch('prompt.error', { ...context, error: body.resultPreview || 'External prompt failed' })
        : () => hookEngine.dispatch('prompt.completed', { ...context, status: 'success', output: body.resultPreview });
      Promise.resolve().then(dispatch).catch((err) => {
        app.log.error({ err }, 'Hook dispatch failed in /api/notify');
      });
    }

    if (telegramBot?.isRunning()) {
      Promise.resolve().then(() => telegramBot.broadcastNotification(notif)).catch((err) => {
        app.log.error({ err }, 'broadcastNotification failed in /api/notify');
      });
    }

    // Also persist to the inbox so `cb -i` shows it
    if (inbox) {
      await inbox.addNotification({
        ...notif,
        resultFull: body.resultPreview?.slice(0, 50000),
        viewCommand: 'cb -i',
      }).catch((err) => {
        app.log.error({ err }, 'Inbox persistence failed in /api/notify');
      });
    }

    return { ok: true };
  });
}
