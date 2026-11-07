import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJson } from '../storage/atomic-json.js';
import { TaskConflictError } from '../jobs/types.js';
import type { TaskStatus } from '../jobs/types.js';

export type RemoteFailureKind = 'auth' | 'rejected' | 'unavailable' | 'uncertain';
export type RemoteReceiptStatus = 'prepared' | 'submitting' | 'accepted' | 'uncertain' | 'completed' | 'error' | 'cancelled' | 'interrupted' | 'rejected';

export interface RemoteReceipt {
  id: string;
  receiptId: string;
  taskId: string;
  remoteTaskId?: string;
  hostId: string;
  sessionId: string;
  prompt: string;
  goal?: string;
  idempotencyKey: string;
  status: RemoteReceiptStatus;
  taskStatus?: TaskStatus;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  output?: string;
  error?: string;
  failureKind?: RemoteFailureKind;
  retrySafe?: boolean;
}

export class RemoteRequestError extends Error {
  constructor(message: string, readonly failureKind: RemoteFailureKind, readonly retrySafe = false) {
    super(message);
    this.name = 'RemoteRequestError';
  }
}

export class RemoteReceiptStore {
  private readonly directory?: string;
  private readonly memory = new Map<string, RemoteReceipt>();
  private readonly lockKey: string;

  constructor(configDir?: string) {
    this.directory = configDir ? resolve(configDir, 'remote-tasks') : undefined;
    this.lockKey = this.directory || randomUUID();
  }

  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new Error('Invalid remote receipt ID');
    return join(this.directory!, `${id}.json`);
  }

  async get(id: string): Promise<RemoteReceipt | null> {
    if (!this.directory) return structuredClone(this.memory.get(id) || null);
    try {
      const bytes = await readFile(this.path(id), 'utf8');
      let receipt: RemoteReceipt;
      try { receipt = JSON.parse(bytes) as RemoteReceipt; }
      catch { throw new Error('Invalid remote receipt JSON; file preserved'); }
      if (receipt.id !== id || receipt.receiptId !== id || typeof receipt.taskId !== 'string' ||
          typeof receipt.hostId !== 'string' || typeof receipt.sessionId !== 'string' ||
          typeof receipt.prompt !== 'string' || typeof receipt.idempotencyKey !== 'string' ||
          !['prepared', 'submitting', 'accepted', 'uncertain', 'completed', 'error', 'cancelled', 'interrupted', 'rejected'].includes(receipt.status) ||
          !Number.isFinite(Date.parse(receipt.createdAt)) || !Number.isFinite(Date.parse(receipt.updatedAt))) throw new Error('Invalid remote receipt; file preserved');
      if (!/^[a-zA-Z0-9_-]{8,128}$/.test(receipt.taskId) || !receipt.hostId || !receipt.sessionId || !receipt.prompt.trim() || !receipt.idempotencyKey || receipt.idempotencyKey.length > 256 ||
          (receipt.remoteTaskId !== undefined && (typeof receipt.remoteTaskId !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(receipt.remoteTaskId))) ||
          (receipt.submittedAt !== undefined && (typeof receipt.submittedAt !== 'string' || !Number.isFinite(Date.parse(receipt.submittedAt)))) ||
          (!['prepared', 'rejected'].includes(receipt.status) && !receipt.submittedAt) ||
          (receipt.taskStatus !== undefined && !['pending', 'running', 'completed', 'error', 'cancelled', 'interrupted'].includes(receipt.taskStatus)) ||
          (receipt.output !== undefined && typeof receipt.output !== 'string') || (receipt.error !== undefined && typeof receipt.error !== 'string') ||
          (receipt.goal !== undefined && (typeof receipt.goal !== 'string' || !receipt.goal.trim() || receipt.goal.length > 10000)) ||
          (receipt.retrySafe !== undefined && typeof receipt.retrySafe !== 'boolean') ||
          (receipt.failureKind !== undefined && !['auth', 'rejected', 'unavailable', 'uncertain'].includes(receipt.failureKind))) throw new Error('Invalid remote receipt fields; file preserved');
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list(): Promise<RemoteReceipt[]> {
    if (!this.directory) return [...this.memory.values()].map((receipt) => structuredClone(receipt));
    let files: string[];
    try { files = await readdir(this.directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const receipts = await Promise.all(files.filter((file) => /^[a-zA-Z0-9_-]{8,128}\.json$/.test(file)).map((file) => this.get(file.slice(0, -5))));
    return receipts.filter((receipt): receipt is RemoteReceipt => !!receipt);
  }

  private locked<T>(action: () => Promise<T>): Promise<T> {
    const previous = receiptLocks.get(this.lockKey) || Promise.resolve();
    const result = previous.then(action, action);
    const settled = result.then(() => undefined, () => undefined);
    receiptLocks.set(this.lockKey, settled);
    void settled.then(() => { if (receiptLocks.get(this.lockKey) === settled) receiptLocks.delete(this.lockKey); });
    return result;
  }

  private async write(receipt: RemoteReceipt): Promise<void> {
    if (this.directory) { await mkdir(this.directory, { recursive: true, mode: 0o700 }); await atomicWriteJson(this.path(receipt.id), receipt); }
    else this.memory.set(receipt.id, structuredClone(receipt));
  }

  async prepare(input: Pick<RemoteReceipt, 'taskId' | 'hostId' | 'sessionId' | 'prompt' | 'idempotencyKey' | 'goal'> & { strictTaskId?: boolean }): Promise<{ receipt: RemoteReceipt; created: boolean }> {
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(input.taskId) || !input.prompt.trim() || !input.idempotencyKey || input.idempotencyKey.length > 256) throw new Error('Invalid remote submission');
    if (input.goal !== undefined && (typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 10000)) throw new Error('Invalid remote submission goal');
    return this.locked(async () => {
      const existing = (await this.list()).find((receipt) => receipt.hostId === input.hostId && (receipt.taskId === input.taskId || receipt.idempotencyKey === input.idempotencyKey));
      if (existing) {
        if (existing.prompt !== input.prompt || existing.sessionId !== input.sessionId || (input.strictTaskId && existing.taskId !== input.taskId) || existing.idempotencyKey !== input.idempotencyKey || (input.goal !== undefined && existing.goal !== input.goal)) throw new TaskConflictError();
        return { receipt: existing, created: false };
      }
      const now = new Date().toISOString();
      const id = randomUUID();
      const fields = { taskId: input.taskId, hostId: input.hostId, sessionId: input.sessionId, prompt: input.prompt, goal: input.goal, idempotencyKey: input.idempotencyKey };
      const receipt: RemoteReceipt = { ...fields, id, receiptId: id, status: 'prepared', createdAt: now, updatedAt: now };
      await this.write(receipt);
      return { receipt, created: true };
    });
  }

  async update(id: string, changes: Partial<Pick<RemoteReceipt, 'status' | 'taskStatus' | 'submittedAt' | 'remoteTaskId' | 'output' | 'error' | 'failureKind' | 'retrySafe'>>): Promise<RemoteReceipt> {
    return this.locked(async () => {
      const current = await this.get(id);
      if (!current) throw new Error('Remote receipt not found');
      if (['completed', 'error', 'cancelled', 'interrupted'].includes(current.status)) return current;
      const next = { ...current, ...changes, updatedAt: new Date().toISOString() };
      if (current.status === 'accepted' && ['prepared', 'submitting', 'uncertain', 'rejected'].includes(next.status)) next.status = 'accepted';
      await this.write(next);
      return next;
    });
  }

  async claimSubmission(id: string): Promise<{ claimed: boolean; receipt: RemoteReceipt }> {
    return this.locked(async () => {
      const current = await this.get(id);
      if (!current) throw new Error('Remote receipt not found');
      if (!['prepared', 'rejected'].includes(current.status)) return { claimed: false, receipt: current };
      const receipt: RemoteReceipt = { ...current, status: 'submitting', submittedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: undefined, failureKind: undefined, retrySafe: false };
      await this.write(receipt);
      return { claimed: true, receipt };
    });
  }
}

const receiptLocks = new Map<string, Promise<unknown>>();
