import { readFile, readdir, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from '../storage/atomic-json.js';
import { TaskConflictError, TERMINAL_TASK_STATUSES, type TaskRecord, type TaskStatus } from './types.js';
import { validateTaskRecord } from './validation.js';
import { recoverTaskExecutor } from './executor.js';

type Acceptance = Pick<TaskRecord, 'sessionId' | 'sessionName' | 'goal' | 'prompt' | 'workingDir' | 'model' | 'executionPolicy' | 'idempotencyKey'> & { taskId?: string };
const locks = new Map<string, Promise<unknown>>();
type TaskUpdate = Partial<Pick<TaskRecord, 'status' | 'startedAt' | 'completedAt' | 'output' | 'rawOutput' | 'structuredResult' | 'error' | 'exitCode' | 'claudeSessionId' | 'executor'>>;
const mutableFields = new Set(['status', 'startedAt', 'completedAt', 'output', 'rawOutput', 'structuredResult', 'error', 'exitCode', 'claudeSessionId', 'executor']);

export class TaskStore {
  readonly directory: string;

  constructor(configDir: string) {
    this.directory = resolve(configDir, 'tasks');
  }

  private locked<T>(operation: () => Promise<T>): Promise<T> {
    const previous = locks.get(this.directory) || Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(() => undefined, () => undefined);
    locks.set(this.directory, settled);
    void settled.then(() => { if (locks.get(this.directory) === settled) locks.delete(this.directory); });
    return next;
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid task ID');
    return join(this.directory, `${id}.json`);
  }

  async get(id: string): Promise<TaskRecord | null> {
    try {
      const bytes = await readFile(this.path(id), 'utf8');
      let task: unknown;
      try { task = JSON.parse(bytes); }
      catch { throw new Error(`Invalid task receipt JSON: ${id}`); }
      validateTaskRecord(task, id);
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(sessionId?: string): Promise<TaskRecord[]> {
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const tasks: TaskRecord[] = [];
    for (const file of files) {
      if (!/^[a-zA-Z0-9_-]{8,128}\.json$/.test(file)) continue;
      const task = await this.get(file.slice(0, -5));
      if (task && (!sessionId || task.sessionId === sessionId)) tasks.push(task);
    }
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async findByIdempotencyKey(key: string): Promise<TaskRecord | null> {
    return (await this.list()).find((task) => task.idempotencyKey === key) || null;
  }

  async accept(input: Acceptance): Promise<{ task: TaskRecord; created: boolean }> {
    if (!input.prompt.trim()) throw new Error('Prompt must not be empty');
    if (input.idempotencyKey !== undefined && (!input.idempotencyKey || input.idempotencyKey.length > 256)) throw new Error('Invalid idempotency key');
    return this.locked(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const byId = input.taskId ? await this.get(input.taskId) : null;
      const byKey = input.idempotencyKey ? await this.findByIdempotencyKey(input.idempotencyKey) : null;
      if (byId && byKey && byId.id !== byKey.id) throw new TaskConflictError();
      const existing = byId || byKey;
      if (existing) {
        if (input.taskId && existing.id !== input.taskId) throw new TaskConflictError();
        if (existing.prompt !== input.prompt || existing.workingDir !== input.workingDir || existing.model !== input.model || existing.executionPolicy !== input.executionPolicy || (input.idempotencyKey && existing.idempotencyKey !== input.idempotencyKey)) throw new TaskConflictError();
        return { task: existing, created: false };
      }
      const id = input.taskId || randomUUID();
      const now = new Date().toISOString();
      const task: TaskRecord = {
        id, taskId: id, promptId: id, sessionId: input.sessionId, status: 'pending',
        sessionName: input.sessionName, goal: input.goal,
        prompt: input.prompt, workingDir: input.workingDir, model: input.model,
        executionPolicy: input.executionPolicy, idempotencyKey: input.idempotencyKey,
        createdAt: now, updatedAt: now, output: '', rawOutput: '',
      };
      validateTaskRecord(task, id);
      await atomicWriteJson(this.path(id), task);
      return { task, created: true };
    });
  }

  async update(id: string, changes: TaskUpdate): Promise<TaskRecord> {
    return this.locked(async () => {
      if (Object.keys(changes).some((key) => !mutableFields.has(key))) throw new TaskConflictError('Task submission metadata is immutable');
      const current = await this.get(id);
      if (!current) throw new Error('Task not found');
      if (current.executor && 'executor' in changes && JSON.stringify(current.executor) !== JSON.stringify(changes.executor)) throw new TaskConflictError('Executor ownership metadata is immutable');
      if (TERMINAL_TASK_STATUSES.has(current.status)) {
        if (Object.entries(changes).some(([key, value]) => JSON.stringify(current[key as keyof TaskRecord]) !== JSON.stringify(value))) throw new TaskConflictError('A terminal task cannot change');
        return current;
      }
      if (current.status === 'running' && changes.status === 'pending') throw new TaskConflictError('A running task cannot become pending');
      const now = new Date().toISOString();
      const next: TaskRecord = { ...current, ...changes, updatedAt: now };
      if (next.status === 'running' && !next.startedAt) next.startedAt = now;
      if (TERMINAL_TASK_STATUSES.has(next.status) && !next.completedAt) next.completedAt = now;
      validateTaskRecord(next, id);
      await atomicWriteJson(this.path(id), next);
      return next;
    });
  }

  async recoverInterrupted(): Promise<TaskRecord[]> {
    return this.locked(async () => {
      const recovered: TaskRecord[] = [];
      for (const task of await this.list()) {
        if (TERMINAL_TASK_STATUSES.has(task.status)) continue;
        const recovery = await recoverTaskExecutor(task.executor);
        const now = new Date().toISOString();
        const receipt: TaskRecord = { ...task, status: 'interrupted', updatedAt: now, completedAt: now, error: `Daemon restarted before task completion; execution was not replayed. ${recovery.explanation}` };
        validateTaskRecord(receipt, task.id);
        await atomicWriteJson(this.path(task.id), receipt);
        recovered.push(receipt);
      }
      return recovered;
    });
  }
}

export function isTerminalTask(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.has(status);
}
