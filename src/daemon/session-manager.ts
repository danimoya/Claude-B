import { Socket } from 'net';
import { readFile, mkdir } from 'fs/promises';
import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { Session, SessionState, type ExecutionPolicy } from '../session/session.js';
import { TaskStore, isTerminalTask } from '../jobs/store.js';
import type { TaskRecord } from '../jobs/types.js';
import { atomicWriteJson } from '../storage/atomic-json.js';
import { isAbsolute } from 'path';

interface SessionIndex {
  sessions: SessionState[];
  selectedId?: string;
}

function validateSessionIndex(value: unknown): asserts value is SessionIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid session index');
  const index = value as Record<string, unknown>;
  if (!Array.isArray(index.sessions)) throw new Error('Invalid session index sessions');
  const ids = new Set<string>();
  for (const raw of index.sessions) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session state');
    const state = raw as Record<string, unknown>;
    if (typeof state.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(state.id) || ids.has(state.id) ||
        !['idle', 'busy'].includes(state.status as string) ||
        typeof state.createdAt !== 'string' || !Number.isFinite(Date.parse(state.createdAt)) ||
        typeof state.workingDir !== 'string' || !isAbsolute(state.workingDir) || state.workingDir.includes('\0') ||
        !Number.isSafeInteger(state.promptCount) || (state.promptCount as number) < 0 ||
        (state.executionPolicy !== undefined && !['default', 'bypass'].includes(state.executionPolicy as string)) ||
        (state.fireAndForget !== undefined && typeof state.fireAndForget !== 'boolean')) throw new Error('Invalid session state');
    for (const key of ['name', 'model', 'goal', 'lastPromptId', 'claudeSessionId']) {
      if (state[key] !== undefined && typeof state[key] !== 'string') throw new Error('Invalid session state field');
    }
    if (state.lastActivityAt !== undefined && (typeof state.lastActivityAt !== 'string' || !Number.isFinite(Date.parse(state.lastActivityAt)))) throw new Error('Invalid session activity timestamp');
    ids.add(state.id);
  }
  if (index.selectedId !== undefined && (typeof index.selectedId !== 'string' || !ids.has(index.selectedId))) throw new Error('Invalid selected session');
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map();
  private selectedId: string | null = null;
  private configDir: string;
  private indexPath: string;
  private attachedSessions: Map<Socket, string> = new Map();
  private readonly taskStore: TaskStore;
  private saveChain: Promise<unknown> = Promise.resolve();
  private loadFailure: Error | null = null;
  private loaded = false;
  private closing = false;
  private stopOperation: Promise<void> | null = null;

  constructor(configDir: string) {
    super();
    this.configDir = configDir;
    this.indexPath = `${configDir}/sessions/index.json`;
    this.taskStore = new TaskStore(configDir);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    const sessionsDir = `${this.configDir}/sessions`;
    await mkdir(sessionsDir, { recursive: true });
    let index: SessionIndex | null = null;
    try {
      if (existsSync(this.indexPath)) {
        const value: unknown = JSON.parse(await readFile(this.indexPath, 'utf-8'));
        validateSessionIndex(value);
        index = value;
      }
    } catch {
      this.loadFailure = new Error(`Cannot load session index ${this.indexPath}; invalid or unreadable state was preserved`);
      throw this.loadFailure;
    }
    try {
      await this.taskStore.recoverInterrupted();
      this.loadFailure = null;
      if (!index) {
        await this.save();
        this.loaded = true;
        return;
      }
      let staleCount = 0;
      for (const state of index.sessions) {
        // Reset stale "busy" sessions — no process survives a daemon restart
        if (state.status === 'busy') {
          state.status = 'idle';
          staleCount++;
        }
        const session = new Session(state, this.configDir);
        // Load persisted output buffer from disk
        await session.loadPersistedOutput();
        this.sessions.set(session.id, session);
        this.observeSession(session);
      }

      if (index.selectedId && this.sessions.has(index.selectedId)) {
        this.selectedId = index.selectedId;
      }
      if (staleCount > 0) {
        console.log(`[SessionManager] Reset ${staleCount} stale busy session(s) to idle`);
        await this.save();
      }
      this.loaded = true;
    } catch (error) {
      this.loadFailure = new Error('Cannot recover session/task state; existing files were preserved');
      throw error;
    }
  }

  async save(): Promise<void> {
    if (this.loadFailure) throw this.loadFailure;
    const sessionsDir = `${this.configDir}/sessions`;
    await mkdir(sessionsDir, { recursive: true });

    const index: SessionIndex = {
      sessions: Array.from(this.sessions.values()).map(s => s.getState()),
      selectedId: this.selectedId || undefined
    };

    const operation = this.saveChain.then(() => atomicWriteJson(this.indexPath, {
      ...index,
      sessions: Array.from(this.sessions.values()).map((session) => session.getState()),
      selectedId: this.selectedId || undefined,
    }));
    this.saveChain = operation.catch(() => {});
    await operation;
  }

  async create(name?: string, model?: string, goal?: string, fireAndForget?: boolean, workingDir?: string, executionPolicy: ExecutionPolicy = 'default'): Promise<Session> {
    if (this.closing) throw new Error('Session manager is closing');
    const session = Session.create(name, this.configDir, model, goal, fireAndForget, workingDir, executionPolicy);
    this.sessions.set(session.id, session);
    this.observeSession(session);

    // Auto-select if no session is selected
    if (!this.selectedId) {
      this.selectedId = session.id;
    }

    await this.save();
    if (this.closing) throw new Error('Session manager is closing');
    return session;
  }

  private observeSession(session: Session): void {
    session.on('task.accepted', () => { void this.save().catch(() => {}); });
    session.on('task.terminal', (task: TaskRecord) => {
      void this.save().catch(() => {});
      this.emit('task.terminal', task);
    });
  }

  getTaskStore(): TaskStore { return this.taskStore; }

  async getTask(taskId: string): Promise<TaskRecord | null> { return this.taskStore.get(taskId); }

  async listTasks(sessionId?: string): Promise<TaskRecord[]> { return this.taskStore.list(sessionId); }

  async setExecutionPolicy(sessionId: string, policy: ExecutionPolicy): Promise<void> {
    if (this.closing) throw new Error('Session manager is closing');
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');
    await session.setExecutionPolicy(policy);
    await this.save();
  }

  async cancelTask(taskId: string): Promise<TaskRecord | null> {
    const task = await this.taskStore.get(taskId);
    if (!task || isTerminalTask(task.status)) return task;
    const session = this.sessions.get(task.sessionId);
    if (session) return session.cancelTask(taskId);
    const cancelled = await this.taskStore.update(taskId, { status: 'cancelled', completedAt: new Date().toISOString(), error: 'Task cancelled before execution' });
    this.emit('task.terminal', cancelled);
    return cancelled;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  current(): Session | null {
    if (!this.selectedId) {
      return null;
    }
    return this.sessions.get(this.selectedId) || null;
  }

  select(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.selectedId = sessionId;
    this.save().catch(() => {});
  }

  list(): Array<{
    id: string;
    name?: string;
    model?: string;
    workingDir: string;
    executionPolicy: ExecutionPolicy;
    status: string;
    selected: boolean;
    createdAt: string;
    goal?: string;
    fireAndForget?: boolean;
    claudeSessionId?: string;
  }> {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      name: session.name,
      model: session.model,
      workingDir: session.getState().workingDir,
      executionPolicy: session.executionPolicy,
      status: session.status,
      selected: session.id === this.selectedId,
      createdAt: session.createdAt,
      goal: session.goal,
      fireAndForget: session.fireAndForget,
      claudeSessionId: session.getClaudeSessionId(),
    }));
  }

  count(): number {
    return this.sessions.size;
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await session.stop();
    this.sessions.delete(sessionId);

    // Clear selection if killing selected session
    if (this.selectedId === sessionId) {
      this.selectedId = this.sessions.size > 0
        ? this.sessions.keys().next().value || null
        : null;
    }

    await this.save();
  }

  async stopAll(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    this.closing = true;
    this.stopOperation = (async () => {
      await Promise.all(Array.from(this.sessions.values()).map(session => session.stop()));
      await this.save();
    })();
    return this.stopOperation;
  }

  // Remove idle sessions older than maxAge (default: 30 days)
  async cleanupExpired(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'busy' || session.hasPendingTasks()) continue;
      const lastActive = new Date(session.lastActivityAt || session.createdAt).getTime();
      if (now - lastActive > maxAgeMs) {
        expired.push(id);
      }
    }

    for (const id of expired) {
      const session = this.sessions.get(id);
      if (session) {
        await session.stop();
        this.sessions.delete(id);
        if (this.selectedId === id) {
          this.selectedId = this.sessions.size > 0
            ? this.sessions.keys().next().value || null
            : null;
        }
      }
    }

    if (expired.length > 0) {
      await this.save();
    }
    return expired.length;
  }

  // Remove completed fire-and-forget sessions that are idle
  async cleanupFireAndForget(): Promise<number> {
    const completed: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.fireAndForget && session.status === 'idle' && !session.hasPendingTasks() && session.getState().promptCount > 0) {
        completed.push(id);
      }
    }

    for (const id of completed) {
      const session = this.sessions.get(id);
      if (session) {
        await session.stop();
        this.sessions.delete(id);
        if (this.selectedId === id) {
          this.selectedId = this.sessions.size > 0
            ? this.sessions.keys().next().value || null
            : null;
        }
      }
    }

    if (completed.length > 0) {
      await this.save();
    }
    return completed.length;
  }

  getAttachedSession(socket: Socket): Session | undefined {
    const sessionId = this.attachedSessions.get(socket);
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  registerAttachment(socket: Socket, sessionId: string): void {
    this.attachedSessions.set(socket, sessionId);
  }

  unregisterAttachment(socket: Socket): void {
    this.attachedSessions.delete(socket);
  }
}
