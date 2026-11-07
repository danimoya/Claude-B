import { NotificationOutbox } from './outbox.js';
import type { NotificationInbox } from './inbox.js';
import type { HookEngine } from '../hooks/engine.js';
import type { ClaudeBTelegramBot } from '../telegram/bot.js';
import { isChatAllowed } from '../telegram/allow-list.js';

export interface DeliveryChannels {
  inbox?: Pick<NotificationInbox, 'addNotification'> | null;
  hooks?: Pick<HookEngine, 'dispatch'> | null;
  telegram?: Pick<ClaudeBTelegramBot, 'getConfig' | 'isRunning' | 'broadcastNotification'> | null;
}

/** Stable event metadata survives retries; only acknowledged channels finish. */
export function createDeliveryOutbox(configDir: string, channels: DeliveryChannels): NotificationOutbox {
  return new NotificationOutbox(configDir, {
    ...(channels.inbox ? { inbox: { deliver: (notification) => channels.inbox!.addNotification(notification) } } : {}),
    ...(channels.hooks ? { hooks: { deliver: async (notification, id, timestamp, signal?: AbortSignal) => {
      const context = { ...notification, promptId: notification.promptId || id };
      const result = notification.type === 'prompt.error'
        ? await channels.hooks!.dispatch('prompt.error', { ...context, error: notification.resultFull || notification.resultPreview || 'Prompt failed' }, { id, timestamp, signal })
        : await channels.hooks!.dispatch('prompt.completed', { ...context, status: 'success', output: notification.resultFull ?? notification.resultPreview ?? '' }, { id, timestamp, signal });
      const failures = [...result.shellResults, ...result.webhookResults].filter(value => !value.success);
      if (failures.length) {
        const error = new Error('Hook subscriber delivery failed') as Error & { retryable: boolean; code: string; retryAfterMs: number };
        error.retryable = failures.some(value => value.retryable !== false);
        error.code = error.retryable ? 'TRANSIENT_HOOK_DELIVERY' : 'PERMANENT_HOOK_DELIVERY';
        error.retryAfterMs = Math.min(10000, Math.max(0, ...failures.filter(value => value.retryable !== false).map(value => 'retryAfterMs' in value ? value.retryAfterMs || 0 : 0)));
        throw error;
      }
    } } } : {}),
    ...(channels.telegram ? { telegram: {
      enabled: () => {
        const config = channels.telegram!.getConfig?.();
        // Transport-only embeddings can explicitly omit configuration; actual
        // bot configuration distinguishes disabled from configured/offline.
        return config ? config.enabled && config.chatIds.some(id => /^[1-9]\d*$/.test(id) &&
          (!process.env.TELEGRAM_ALLOWED_CHAT_IDS?.trim() || isChatAllowed(id, process.env.TELEGRAM_ALLOWED_CHAT_IDS)))
          : channels.telegram!.isRunning();
      },
      deliver: async (notification, _id, _timestamp, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        if (!channels.telegram!.isRunning()) throw new Error('Configured Telegram bot is offline');
        await channels.telegram!.broadcastNotification({ ...notification,
          resultPreview: notification.resultFull ?? notification.resultPreview }, signal);
      }
    } } : {})
  });
}
