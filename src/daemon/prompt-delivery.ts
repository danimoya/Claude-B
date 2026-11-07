import type { Session } from '../session/session.js';
import type { HookEngine } from '../hooks/engine.js';
import type { NotificationInbox, NotificationInput } from '../notifications/inbox.js';

interface DeliverySinks {
  hooks: Pick<HookEngine, 'dispatch'>;
  inbox: Pick<NotificationInbox, 'addNotification'>;
  forward: (notification: NotificationInput) => void;
}

function runSink(action: () => unknown): void {
  try {
    Promise.resolve(action()).catch(() => {});
  } catch {
    // A delivery-channel failure must not escape a session event listener.
  }
}

/** Correlate one submitted prompt with its terminal notification. */
export async function submitPromptWithDelivery(session: Session, prompt: string, sinks: DeliverySinks): Promise<string> {
  let promptId: string | undefined;
  let delivered = false;
  const earlyNotifications: NotificationInput[] = [];
  const deliver = (notification: NotificationInput) => {
    if (promptId === undefined) {
      earlyNotifications.push(notification);
      return;
    }
    if (notification.promptId !== promptId) return;
    const terminalPromptId = promptId;
    if (delivered) return;
    delivered = true;
    session.off('notification', deliver);
    runSink(() => sinks.inbox.addNotification(notification));
    runSink(() => sinks.forward(notification));
    if (notification.type === 'prompt.error') {
      runSink(() => sinks.hooks.dispatch('prompt.error', {
        sessionId: session.id, promptId: terminalPromptId,
        error: notification.resultFull || notification.resultPreview || 'Prompt failed',
      }));
    } else {
      runSink(() => sinks.hooks.dispatch('prompt.completed', {
        sessionId: session.id, promptId: terminalPromptId, status: 'success',
        output: notification.resultFull ?? notification.resultPreview ?? '',
      }));
    }
  };
  session.on('notification', deliver);
  try {
    const submittedPromptId = await session.sendPrompt(prompt);
    promptId = submittedPromptId;
    runSink(() => sinks.hooks.dispatch('prompt.received', { sessionId: session.id, promptId: submittedPromptId, prompt }));
    for (const notification of earlyNotifications) deliver(notification);
    return promptId;
  } catch (error) {
    session.off('notification', deliver);
    throw error;
  }
}
