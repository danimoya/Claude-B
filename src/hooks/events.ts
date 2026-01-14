// Hook event types and definitions

export type HookEventType =
  | 'session.created'
  | 'session.destroyed'
  | 'prompt.received'
  | 'prompt.started'
  | 'prompt.completed'
  | 'prompt.error'
  | 'tool.called'
  | 'daemon.started'
  | 'daemon.stopped'
  | 'rest.started'
  | 'rest.stopped';

export interface HookEventPayload {
  'session.created': { sessionId: string; name?: string };
  'session.destroyed': { sessionId: string };
  'prompt.received': { sessionId: string; promptId: string; prompt: string };
  'prompt.started': { sessionId: string; promptId: string };
  'prompt.completed': { sessionId: string; promptId: string; status: string; output?: string };
  'prompt.error': { sessionId: string; promptId: string; error: string };
  'tool.called': { sessionId: string; toolName: string; args?: Record<string, unknown> };
  'daemon.started': { pid: number };
  'daemon.stopped': { pid: number };
  'rest.started': { host: string; port: number };
  'rest.stopped': Record<string, never>;
}

export interface HookEvent<T extends HookEventType = HookEventType> {
  type: T;
  timestamp: string;
  payload: HookEventPayload[T];
}

export function createEvent<T extends HookEventType>(
  type: T,
  payload: HookEventPayload[T]
): HookEvent<T> {
  return {
    type,
    timestamp: new Date().toISOString(),
    payload
  };
}

// All available events for documentation
export const ALL_EVENTS: HookEventType[] = [
  'session.created',
  'session.destroyed',
  'prompt.received',
  'prompt.started',
  'prompt.completed',
  'prompt.error',
  'tool.called',
  'daemon.started',
  'daemon.stopped',
  'rest.started',
  'rest.stopped'
];
