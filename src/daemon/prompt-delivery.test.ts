import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../session/session.js';
import { submitPromptWithDelivery } from './prompt-delivery.js';
import type { NotificationInput } from '../notifications/inbox.js';

function notification(promptId: string, type: 'prompt.completed' | 'prompt.error' = 'prompt.completed'): NotificationInput {
  return { sessionId: 'session', promptId, type, exitCode: type === 'prompt.error' ? 1 : 0, resultFull: promptId, viewCommand: 'cb -l' };
}

describe('prompt-scoped delivery', () => {
  function fixture() {
    let next = 0;
    const emitter = Object.assign(new EventEmitter(), {
      id: 'session', sendPrompt: vi.fn(async () => `prompt-${++next}`),
    });
    const sinks = {
      hooks: { dispatch: vi.fn().mockResolvedValue(undefined) },
      inbox: { addNotification: vi.fn().mockResolvedValue(undefined) },
      forward: vi.fn(),
    };
    return { emitter, session: emitter as unknown as Session, sinks };
  }

  it('delivers a failure followed by a success once each without stale listeners', async () => {
    const { emitter, session, sinks } = fixture();
    const first = await submitPromptWithDelivery(session, 'first', sinks);
    emitter.emit('notification', notification(first, 'prompt.error'));
    expect(emitter.listenerCount('notification')).toBe(0);
    const second = await submitPromptWithDelivery(session, 'second', sinks);
    emitter.emit('notification', notification(first));
    expect(sinks.inbox.addNotification).toHaveBeenCalledOnce();
    emitter.emit('notification', notification(second));
    emitter.emit('notification', notification(second));
    expect(sinks.inbox.addNotification).toHaveBeenCalledTimes(2);
    expect(sinks.forward).toHaveBeenCalledTimes(2);
    expect(sinks.hooks.dispatch.mock.calls.filter(([type]) => type === 'prompt.error')).toEqual([
      ['prompt.error', { sessionId: 'session', promptId: first, error: first }],
    ]);
    expect(sinks.hooks.dispatch.mock.calls.filter(([type]) => type === 'prompt.completed')).toEqual([
      ['prompt.completed', { sessionId: 'session', promptId: second, status: 'success', output: second }],
    ]);
    expect(emitter.listenerCount('notification')).toBe(0);
  });

  it('keeps two queued submissions correlated with their own terminal result', async () => {
    const { emitter, session, sinks } = fixture();
    const [first, second] = await Promise.all([
      submitPromptWithDelivery(session, 'first', sinks), submitPromptWithDelivery(session, 'second', sinks),
    ]);
    emitter.emit('notification', notification(first));
    expect(emitter.listenerCount('notification')).toBe(1);
    expect(sinks.inbox.addNotification).toHaveBeenCalledTimes(1);
    emitter.emit('notification', notification(second, 'prompt.error'));
    expect(sinks.inbox.addNotification).toHaveBeenCalledTimes(2);
    expect(emitter.listenerCount('notification')).toBe(0);
  });

  it('handles an early terminal event and removes listeners when submission rejects', async () => {
    const { emitter, session, sinks } = fixture();
    emitter.sendPrompt.mockImplementationOnce(async () => {
      emitter.emit('notification', notification('early', 'prompt.error'));
      return 'early';
    });
    await submitPromptWithDelivery(session, 'early', sinks);
    expect(sinks.forward).toHaveBeenCalledOnce();
    emitter.sendPrompt.mockRejectedValueOnce(new Error('rejected'));
    await expect(submitPromptWithDelivery(session, 'bad', sinks)).rejects.toThrow('rejected');
    expect(emitter.listenerCount('notification')).toBe(0);
  });

  it('isolates throwing and rejected sinks without blocking other channels or later prompts', async () => {
    const { emitter, session, sinks } = fixture();
    sinks.forward.mockImplementationOnce(() => { throw new Error('Telegram unavailable'); });
    sinks.inbox.addNotification.mockRejectedValueOnce(new Error('inbox unavailable'));
    const first = await submitPromptWithDelivery(session, 'first', sinks);
    expect(() => emitter.emit('notification', notification(first))).not.toThrow();
    expect(sinks.hooks.dispatch).toHaveBeenCalledWith('prompt.completed', expect.objectContaining({ promptId: first }));
    sinks.hooks.dispatch.mockImplementationOnce(() => { throw new Error('hooks unavailable'); });
    const second = await submitPromptWithDelivery(session, 'second', sinks);
    expect(() => emitter.emit('notification', notification(second))).not.toThrow();
    expect(sinks.forward).toHaveBeenCalledTimes(2);
    expect(emitter.listenerCount('notification')).toBe(0);
  });
});
