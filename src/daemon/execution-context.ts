import { realpath, stat } from 'node:fs/promises';
import type { SessionManager } from './session-manager.js';
import type { Session, ExecutionPolicy } from '../session/session.js';

export function executionPolicy(value: unknown, fallback: ExecutionPolicy = 'default'): ExecutionPolicy {
  if (value === undefined) return fallback;
  if (value !== 'default' && value !== 'bypass') throw new Error('Execution policy must be default or bypass');
  return value;
}

const selectionChains = new WeakMap<SessionManager, Promise<unknown>>();

/** Serialize first submissions and keep implicit sessions inside the caller project. */
export async function selectExecutionSession(manager: SessionManager, options: {
  sessionId?: string; workingDir?: string; model?: string; executionPolicy?: unknown;
}): Promise<Session> {
  const previous = selectionChains.get(manager) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const directory = await realpath(options.workingDir ?? process.cwd());
    if (!(await stat(directory)).isDirectory()) throw new Error('Working directory must be a directory');
    let session: Session | undefined;
    if (options.sessionId) {
      session = manager.get(options.sessionId);
      if (!session) throw new Error(`Session not found: ${options.sessionId}`);
    } else {
      const selected = manager.current();
      if (selected?.getState().workingDir === directory) session = selected;
      else session = manager.list().map(info => manager.get(info.id)!).find(candidate => candidate.getState().workingDir === directory);
    }
    const policy = executionPolicy(options.executionPolicy, session?.executionPolicy ?? 'default');
    if (!session) session = await manager.create(undefined, options.model, undefined, false, directory, policy);
    else {
      if (session.hasPendingTasks() && ((options.model && session.model !== options.model) || policy !== session.executionPolicy)) {
        throw new Error('Cannot change model or execution policy while a session is busy');
      }
      if (options.model) session.model = options.model;
      if (session.executionPolicy !== policy) await session.setExecutionPolicy(policy);
    }
    manager.select(session.id);
    await manager.save();
    return session;
  });
  selectionChains.set(manager, next);
  try { return await next; }
  finally { if (selectionChains.get(manager) === next) selectionChains.delete(manager); }
}
