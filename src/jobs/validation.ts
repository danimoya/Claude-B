import { isAbsolute } from 'node:path';
import type { TaskRecord, TaskStatus } from './types.js';

const statuses: ReadonlySet<unknown> = new Set<TaskStatus>(['pending', 'running', 'completed', 'error', 'cancelled', 'interrupted']);
const timestamp = (value: unknown): boolean => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
};
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';

export function validateTaskRecord(value: unknown, expectedId?: string): asserts value is TaskRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid task receipt');
  const task = value as Record<string, unknown>;
  const id = task.id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(id) ||
      (expectedId !== undefined && id !== expectedId) || task.taskId !== id || task.promptId !== id ||
      typeof task.sessionId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(task.sessionId) ||
      !statuses.has(task.status) || typeof task.prompt !== 'string' || !task.prompt.trim() ||
      typeof task.workingDir !== 'string' || !isAbsolute(task.workingDir) || task.workingDir.includes('\0') ||
      !['default', 'bypass'].includes(task.executionPolicy as string) ||
      !timestamp(task.createdAt) || !timestamp(task.updatedAt) ||
      typeof task.output !== 'string' || typeof task.rawOutput !== 'string') throw new Error(`Invalid task receipt: ${String(id)}`);
  for (const key of ['sessionName', 'goal', 'claudeSessionId', 'error', 'model', 'idempotencyKey']) {
    if (!optionalString(task[key])) throw new Error(`Invalid task receipt field: ${key}`);
  }
  if (task.model !== undefined && !(task.model as string).trim()) throw new Error('Invalid task model');
  if (task.idempotencyKey !== undefined && (!(task.idempotencyKey as string) || (task.idempotencyKey as string).length > 256)) throw new Error('Invalid idempotency key');
  for (const key of ['startedAt', 'completedAt']) {
    if (task[key] !== undefined && !timestamp(task[key])) throw new Error(`Invalid task timestamp: ${key}`);
  }
  if (task.status === 'running' && !timestamp(task.startedAt)) throw new Error('Running task lacks a start timestamp');
  if (['completed', 'error', 'cancelled', 'interrupted'].includes(task.status as string) && !timestamp(task.completedAt)) throw new Error('Terminal task lacks a completion timestamp');
  if (['error', 'cancelled', 'interrupted'].includes(task.status as string) && (typeof task.error !== 'string' || !task.error)) throw new Error('Failed task lacks an explanation');
  if (task.status === 'completed' && task.error !== undefined) throw new Error('Completed task has a failure explanation');
  if (task.exitCode !== undefined && task.exitCode !== null && !Number.isSafeInteger(task.exitCode)) throw new Error('Invalid task exit code');
  if (task.structuredResult !== undefined) {
    const result = task.structuredResult as Record<string, unknown>;
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.result !== 'string' ||
        typeof result.durationMs !== 'number' || !Number.isFinite(result.durationMs) || result.durationMs < 0 ||
        typeof result.costUsd !== 'number' || !Number.isFinite(result.costUsd) || result.costUsd < 0 ||
        !Number.isSafeInteger(result.numTurns) || (result.numTurns as number) < 0 || typeof result.isError !== 'boolean' ||
        (task.status === 'completed' && result.isError)) throw new Error('Invalid structured task result');
  }
  if (task.executor !== undefined) {
    const executor = task.executor as Record<string, unknown>;
    if (!executor || typeof executor !== 'object' || Array.isArray(executor) ||
        !Number.isSafeInteger(executor.pid) || (executor.pid as number) <= 0 ||
        executor.processGroup !== executor.pid || !Number.isSafeInteger(executor.uid) || (executor.uid as number) < 0 ||
        typeof executor.startedAt !== 'string' || executor.startedAt.length > 256 || /[\r\n\0]/.test(executor.startedAt) ||
        (!/^linux:(?:[a-f0-9-]{36}:)?\d+$/.test(executor.startedAt) && !(executor.startedAt.startsWith('ps:') && Number.isFinite(Date.parse(executor.startedAt.slice(3))))) ||
        task.status === 'pending') throw new Error('Invalid executor ownership metadata');
  }
}
