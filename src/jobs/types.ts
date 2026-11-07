import type { ExecutionPolicy, StructuredResult } from '../session/session.js';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted';

export interface TaskExecutor {
  pid: number;
  processGroup: number;
  uid: number;
  startedAt: string;
}

export interface TaskRecord {
  id: string;
  taskId: string;
  promptId: string;
  sessionId: string;
  sessionName?: string;
  goal?: string;
  claudeSessionId?: string;
  status: TaskStatus;
  prompt: string;
  workingDir: string;
  model?: string;
  executionPolicy: ExecutionPolicy;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  output: string;
  rawOutput: string;
  structuredResult?: StructuredResult;
  error?: string;
  exitCode?: number | null;
  idempotencyKey?: string;
  executor?: TaskExecutor;
}

export interface TaskSubmission {
  taskId?: string;
  idempotencyKey?: string;
}

export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(['completed', 'error', 'cancelled', 'interrupted']);

export class TaskConflictError extends Error {
  readonly code = 'TASK_CONFLICT';
  constructor(message = 'Idempotency key or task ID is already used for a different submission') {
    super(message);
    this.name = 'TaskConflictError';
  }
}
