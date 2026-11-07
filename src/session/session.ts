import { spawn, ChildProcess } from 'child_process';
import { Socket } from 'net';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { EventEmitter } from 'events';
import { mkdir, readFile, appendFile, rm } from 'fs/promises';
import { existsSync, realpathSync, statSync } from 'fs';
import { resolve } from 'path';
import { getClaudePath } from '../utils/claude-detector.js';
import { TaskStore, isTerminalTask } from '../jobs/store.js';
import type { TaskRecord, TaskSubmission, TaskStatus } from '../jobs/types.js';
import type { NotificationInput } from '../notifications/inbox.js';
import { atomicWriteFile, atomicWriteJson } from '../storage/atomic-json.js';
import { captureTaskExecutor } from '../jobs/executor.js';
import type * as NodePty from 'node-pty';
// Node-pty types are kept for the NodePty.IPty branches in write/resize/kill,
// but the active spawn path uses ChildProcess via `claude --print`.

function ignoreLateError(): void { /* an already finalized child has no active task */ }

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try { process.kill(-child.pid, signal); return; }
    catch { /* fall back if the process group has already disappeared */ }
  }
  try { child.kill(signal); } catch { /* process already exited */ }
}

export interface StructuredResult {
  result: string;
  durationMs: number;
  costUsd: number;
  numTurns: number;
  isError: boolean;
}

export type ExecutionPolicy = 'default' | 'bypass';

export interface SessionState {
  id: string;
  name?: string;
  model?: string;  // Claude model to use (e.g., 'claude-3-opus', 'claude-3-sonnet')
  status: 'idle' | 'busy';
  createdAt: string;
  lastActivityAt: string;    // Last prompt sent or completed
  workingDir: string;
  lastPromptId?: string;
  promptCount: number;
  claudeSessionId?: string;  // Claude Code's own session UUID for conversation continuity
  goal?: string;             // Task objective for fire-and-forget
  fireAndForget?: boolean;   // Whether this is a fire-and-forget task
  executionPolicy?: ExecutionPolicy;
}

interface PromptEntry {
  id: string;
  prompt: string;
  timestamp: string;
  status: 'pending' | 'completed' | 'error';
  output?: string;
}

export class Session extends EventEmitter {
  public id: string;
  public name?: string;
  public model?: string;
  public status: 'idle' | 'busy' = 'idle';
  public createdAt: string;
  public goal?: string;
  public fireAndForget: boolean = false;
  public lastActivityAt: string;
  public executionPolicy: ExecutionPolicy;
  public readonly taskStore: TaskStore;

  private workingDir: string;
  private sessionDir: string;
  private process: ChildProcess | NodePty.IPty | null = null;
  private outputBuffer: string[] = [];
  private currentPromptOutput: string[] = [];
  private lastOutput: string = '';
  private lastPromptId?: string;
  private promptCount: number = 0;
  private attachedSockets: Set<Socket> = new Set();
  private watchingSockets: Set<Socket> = new Set();
  private promptQueue: TaskRecord[] = [];
  private activeTask: TaskRecord | null = null;
  private finalization: Promise<void> | null = null;
  private stopping = false;
  private stopOperation: Promise<void> | null = null;
  private submissions = new Set<Promise<string>>();
  private cancelled = new Set<string>();
  private publishedTasks = new Set<string>();
  private outputCheckpoint: Promise<unknown> = Promise.resolve();
  private lastError?: string;
  private activeFailure?: string;
  private cleanupProcess: (() => void) | null = null;
  private isProcessing = false;
  private isReady = false;
  private readyResolvers: Array<() => void> = [];
  private claudeSessionId?: string;
  private lastStructuredResult?: StructuredResult;
  private jsonBuffer: string = '';

  constructor(state: SessionState, configDir: string) {
    super();
    this.id = state.id;
    this.name = state.name;
    this.model = state.model;
    this.status = state.status;
    this.createdAt = state.createdAt;
    this.workingDir = state.workingDir;
    this.sessionDir = `${configDir}/sessions/${this.id}`;
    this.lastPromptId = state.lastPromptId;
    this.promptCount = state.promptCount || 0;
    this.claudeSessionId = state.claudeSessionId;
    this.goal = state.goal;
    this.fireAndForget = state.fireAndForget || false;
    this.lastActivityAt = state.lastActivityAt || state.createdAt;
    this.executionPolicy = state.executionPolicy === 'bypass' ? 'bypass' : 'default';
    this.taskStore = new TaskStore(configDir);
  }

  /**
   * Load persisted output from disk (call after constructor for restored sessions).
   */
  async loadPersistedOutput(): Promise<void> {
    try {
      const outputPath = `${this.sessionDir}/last-output.txt`;
      if (existsSync(outputPath)) {
        this.lastOutput = await readFile(outputPath, 'utf-8');
      }
    } catch { /* ignore */ }
    const tasks = (await this.listTasks()).filter((task) => isTerminalTask(task.status));
    tasks.sort((a, b) => (a.completedAt || a.updatedAt).localeCompare(b.completedAt || b.updatedAt));
    const latest = tasks.at(-1);
    if (latest) {
      this.lastPromptId = latest.id;
      this.lastOutput = latest.rawOutput;
      this.lastStructuredResult = latest.structuredResult;
      this.lastError = latest.error;
      this.status = 'idle';
      return;
    }

    try {
      const resultPath = `${this.sessionDir}/last-result.json`;
      if (existsSync(resultPath)) {
        const data = await readFile(resultPath, 'utf-8');
        this.lastStructuredResult = JSON.parse(data);
      }
    } catch { /* ignore */ }
  }

  /**
   * Persist last output and structured result to disk.
   */
  private async persistOutput(): Promise<void> {
    await this.ensureSessionDir();
    // Empty output is meaningful: it must replace an earlier prompt's result.
    await atomicWriteFile(`${this.sessionDir}/last-output.txt`, this.lastOutput);
    if (this.lastStructuredResult) {
      await atomicWriteJson(`${this.sessionDir}/last-result.json`, this.lastStructuredResult);
    } else {
      await rm(`${this.sessionDir}/last-result.json`, { force: true });
    }
  }

  static create(name: string | undefined, configDir: string, model?: string, goal?: string, fireAndForget?: boolean, workingDir = process.cwd(), executionPolicy: ExecutionPolicy = 'default'): Session {
    const projectDir = realpathSync(resolve(workingDir));
    if (!statSync(projectDir).isDirectory()) throw new Error('Working directory must be a directory');
    if (executionPolicy !== 'default' && executionPolicy !== 'bypass') throw new Error('Invalid execution policy');
    const now = new Date().toISOString();
    const state: SessionState = {
      id: nanoid(8),
      name,
      model,
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
      workingDir: projectDir,
      executionPolicy,
      promptCount: 0,
      goal,
      fireAndForget
    };
    return new Session(state, configDir);
  }

  getState(): SessionState {
    return {
      id: this.id,
      name: this.name,
      model: this.model,
      status: this.status,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      workingDir: this.workingDir,
      lastPromptId: this.lastPromptId,
      promptCount: this.promptCount,
      claudeSessionId: this.claudeSessionId,
      goal: this.goal,
      fireAndForget: this.fireAndForget,
      executionPolicy: this.executionPolicy
    };
  }

  getClaudeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  getStructuredResult(): StructuredResult | undefined {
    return this.lastStructuredResult;
  }

  private async ensureSessionDir(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true, mode: 0o700 });
  }

  private async savePromptToHistory(entry: PromptEntry): Promise<void> {
    await this.ensureSessionDir();
    const historyPath = `${this.sessionDir}/history.jsonl`;
    await appendFile(historyPath, JSON.stringify(entry) + '\n');
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    for (const resolver of this.readyResolvers) {
      resolver();
    }
    this.readyResolvers = [];
  }

  private handleOutput(data: string): void {
    this.outputBuffer.push(data);
    this.currentPromptOutput.push(data);
    this.broadcastOutput(data);
    this.emitSafely('output', data);
    const task = this.activeTask;
    if (task) {
      const output = this.currentPromptOutput.join('');
      this.outputCheckpoint = this.outputCheckpoint.catch(() => {}).then(() => this.taskStore.update(task.id, { rawOutput: output, output }));
      void this.outputCheckpoint.catch(() => {});
    }

    // Check if Claude Code is ready (showing the input prompt "❯")
    // This indicates the startup is complete and it's ready for input
    if (!this.isReady && data.includes('❯')) {
      this.markReady();
    }

    // --print output is arbitrary text. Only process close establishes a
    // terminal result; prompt-looking text and separators are ordinary output.
  }

  private async finalizeActive(code: number | null, failureOverride?: string, statusOverride?: TaskStatus): Promise<void> {
    if (this.finalization) return this.finalization;
    const task = this.activeTask;
    if (!task) return;
    this.cleanupProcess?.();
    this.cleanupProcess = null;
    this.process = null;
    this.isReady = false;
    const operation = this.finishTask(task, code, failureOverride || this.activeFailure, statusOverride);
    this.finalization = operation.finally(() => {
      this.activeTask = null;
      this.currentPromptOutput = [];
      this.isProcessing = false;
      this.status = 'idle';
      this.finalization = null;
      void this.processNextPrompt().catch((error) => console.error('Failed to start queued task:', error));
    });
    return this.finalization;
  }

  private async finishTask(task: TaskRecord, code: number | null, failureOverride?: string, statusOverride?: TaskStatus): Promise<void> {
    await this.outputCheckpoint.catch(() => {});
    this.lastOutput = this.currentPromptOutput.join('');
    this.lastActivityAt = new Date().toISOString();
    let failure = failureOverride || (code !== 0 || this.lastStructuredResult?.isError
      ? this.lastStructuredResult?.result || this.lastOutput || `Process terminated (exit ${code})`
      : undefined);
    const cancelled = this.cancelled.has(task.id) || statusOverride === 'cancelled';
    if (cancelled) failure = failureOverride || 'Task cancelled';
    try {
      await this.persistOutput();
      await this.savePromptToHistory({ id: task.id, prompt: '', timestamp: this.lastActivityAt,
        status: failure ? 'error' : 'completed', output: this.lastOutput });
    } catch (error) {
      failure = `Failed to persist result: ${error instanceof Error ? error.message : String(error)}`;
    }
    const status = cancelled ? 'cancelled' : statusOverride || (failure ? 'error' : 'completed');
    const terminal = await this.taskStore.update(task.id, {
      status, completedAt: this.lastActivityAt,
      output: this.lastStructuredResult?.result ?? this.lastOutput,
      rawOutput: this.lastOutput, structuredResult: this.lastStructuredResult,
      error: failure, exitCode: code, claudeSessionId: this.claudeSessionId,
    });
    this.lastError = terminal.error;
    this.status = 'idle';
    this.publishTask(terminal);
  }

  private async handleProcessError(error: Error): Promise<void> {
    await this.finalizeActive(null, error.message);
  }

  async sendPrompt(prompt: string, options: TaskSubmission = {}): Promise<string> {
    if (this.stopping) throw new Error('Session is stopping');
    const operation = this.acceptTask(prompt, options);
    this.submissions.add(operation);
    try { return await operation; }
    finally { this.submissions.delete(operation); }
  }

  private async acceptTask(prompt: string, options: TaskSubmission): Promise<string> {
    const { task, created } = await this.taskStore.accept({
      ...options, sessionId: this.id, sessionName: this.name, goal: this.goal,
      prompt, workingDir: this.workingDir, model: this.model, executionPolicy: this.executionPolicy,
    });
    if (!created) return task.id;
    this.promptCount++;
    if (this.stopping) {
      const cancelled = await this.taskStore.update(task.id, { status: 'cancelled', error: 'Session stopped before execution', completedAt: new Date().toISOString() });
      this.publishTask(cancelled);
      return task.id;
    }
    this.promptQueue.push(task);
    this.emitSafely('task.accepted', task);
    void this.processNextPrompt().catch((error) => console.error('Error processing task:', error));
    return task.id;
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const task = await this.taskStore.get(taskId);
    return task?.sessionId === this.id ? task : null;
  }

  async listTasks(): Promise<TaskRecord[]> { return this.taskStore.list(this.id); }

  hasPendingTasks(): boolean { return this.status === 'busy' || this.isProcessing || this.promptQueue.length > 0 || this.submissions.size > 0; }

  async setExecutionPolicy(policy: ExecutionPolicy): Promise<void> {
    if (policy !== 'default' && policy !== 'bypass') throw new Error('Invalid execution policy');
    if (this.hasPendingTasks()) throw new Error('Execution policy cannot change while the session is busy or tasks are pending');
    this.executionPolicy = policy;
  }

  async cancelTask(taskId: string): Promise<TaskRecord | null> {
    const task = await this.getTask(taskId);
    if (!task || isTerminalTask(task.status)) return task;
    this.cancelled.add(taskId);
    this.promptQueue = this.promptQueue.filter((queued) => queued.id !== taskId);
    if (this.activeTask?.id === taskId) {
      const child = this.process;
      if (child) await this.terminateChild(child);
      if (this.activeTask?.id === taskId) await this.finalizeActive(null, 'Task cancelled', 'cancelled');
      if (this.finalization) await this.finalization;
    } else {
      const terminal = await this.taskStore.update(taskId, { status: 'cancelled', error: 'Task cancelled before execution', completedAt: new Date().toISOString() });
      this.publishTask(terminal);
    }
    return this.getTask(taskId);
  }

  private async processNextPrompt(): Promise<void> {
    if (this.stopping || this.isProcessing || this.promptQueue.length === 0) return;
    const task = this.promptQueue.shift()!;
    this.activeTask = task;
    this.lastPromptId = task.id;
    this.status = 'busy';
    this.lastActivityAt = new Date().toISOString();
    this.isProcessing = true;
    this.currentPromptOutput = [];
    this.jsonBuffer = '';
    this.lastStructuredResult = undefined;
    this.lastOutput = '';
    this.lastError = undefined;
    this.activeFailure = undefined;
    this.outputCheckpoint = Promise.resolve();
    try {
      await this.savePromptToHistory({ id: task.id, prompt: task.prompt, timestamp: this.lastActivityAt, status: 'pending' });
      if (this.activeTask?.id !== task.id) return;
      if (this.cancelled.has(task.id) || this.stopping) {
        await this.finalizeActive(null, 'Task cancelled before execution', 'cancelled');
        return;
      }
      await this.taskStore.update(task.id, { status: 'running', startedAt: new Date().toISOString() });
      if (this.activeTask?.id !== task.id) return;
      if (this.cancelled.has(task.id) || this.stopping) {
        await this.finalizeActive(null, 'Task cancelled before execution', 'cancelled');
        return;
      }
      this.broadcastStatus('processing', { promptId: task.id, prompt: task.prompt.slice(0, 100) });
      const args = ['--print', '--output-format', 'json'];
      if (task.executionPolicy === 'bypass') args.push('--dangerously-skip-permissions');
      if (task.model) args.push('--model', task.model);
      if (this.claudeSessionId) args.push('--resume', this.claudeSessionId);
      else args.push('--session-id', randomUUID());
      const proc = spawn(getClaudePath(), args, { cwd: task.workingDir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env }, detached: process.platform !== 'win32' });
      this.process = proc;
      let promptDispatched = false;
      const onStdout = (chunk: Buffer) => {
        if (this.process !== proc) return;
        const text = chunk.toString();
        this.jsonBuffer += text;
        this.handleOutput(text);
      };
      const onStderr = (chunk: Buffer) => {
        if (this.process === proc) this.handleOutput(chunk.toString());
      };
      const onClose = (code: number | null) => {
        if (this.process !== proc) return;
        this.parseClaudeJsonOutput(this.jsonBuffer);
        const failure = this.activeFailure || (typeof proc.pid === 'number' && !promptDispatched ? 'Executor exited before its prompt was dispatched' : undefined);
        void this.finalizeActive(code, failure).catch((error) => console.error('Failed to persist terminal task:', error));
      };
      const onError = (error: Error) => {
        if (this.process !== proc) return;
        void this.handleProcessError(error).catch((failure) => console.error('Failed to persist failed task:', failure));
      };
      const onInputError = (error: Error) => {
        if (this.process !== proc) return;
        this.activeFailure = `Task input failed: ${error.message}`;
        void this.terminateChild(proc).then(async () => {
          if (this.activeTask?.id === task.id) await this.finalizeActive(null, this.activeFailure);
        }).catch((failure) => console.error('Failed to persist task input error:', failure));
      };
      const onSpawn = () => {
        void (async () => {
          if (this.process !== proc || this.activeTask?.id !== task.id || this.cancelled.has(task.id) || this.stopping) return;
          if (!proc.pid) throw new Error('Spawned executor has no process identity');
          const executor = captureTaskExecutor(proc.pid);
          await this.taskStore.update(task.id, { executor });
          if (this.process !== proc || this.activeTask?.id !== task.id || this.cancelled.has(task.id) || this.stopping) return;
          // The ownership proof must be durable before the executor gets input.
          promptDispatched = true;
          proc.stdin?.end(task.prompt);
        })().catch(async (error) => {
          if (this.process !== proc) return;
          this.activeFailure = `Executor ownership receipt failed: ${error instanceof Error ? error.message : String(error)}`;
          await this.terminateChild(proc);
          if (this.activeTask?.id === task.id) await this.finalizeActive(null, this.activeFailure);
        }).catch((error) => console.error('Failed to finalize undispatched executor:', error));
      };
      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.once('close', onClose);
      proc.once('error', onError);
      proc.once('spawn', onSpawn);
      proc.stdin?.on('error', onInputError);
      this.cleanupProcess = () => {
        proc.stdout?.off('data', onStdout);
        proc.stderr?.off('data', onStderr);
        proc.off('close', onClose);
        proc.off('error', onError);
        proc.off('spawn', onSpawn);
        proc.stdin?.off('error', onInputError);
        // Late stream/process errors remain harmless after detaching the task.
        proc.on('error', ignoreLateError);
        proc.stdin?.on('error', ignoreLateError);
      };
    } catch (error) {
      if (this.activeTask?.id !== task.id) return;
      await this.handleProcessError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private parseClaudeJsonOutput(jsonStr: string): void {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
          (typeof parsed.result !== 'string' && typeof parsed.is_error !== 'boolean')) return;
      // Extract and store Claude's session ID for conversation continuity
      if (typeof parsed.session_id === 'string' && parsed.session_id) {
        this.claudeSessionId = parsed.session_id;
      }
      // Store structured result for richer notifications
      this.lastStructuredResult = {
        result: typeof parsed.result === 'string' ? parsed.result : '',
        durationMs: typeof parsed.duration_ms === 'number' && Number.isFinite(parsed.duration_ms) && parsed.duration_ms >= 0 ? parsed.duration_ms : 0,
        costUsd: typeof parsed.total_cost_usd === 'number' && Number.isFinite(parsed.total_cost_usd) && parsed.total_cost_usd >= 0 ? parsed.total_cost_usd : 0,
        numTurns: Number.isSafeInteger(parsed.num_turns) && parsed.num_turns >= 0 ? parsed.num_turns : 0,
        isError: parsed.is_error === true,
      };
    } catch {
      // Not valid JSON or partial output - ignore, use raw output
    }
  }

  private broadcastStatus(status: string, data?: Record<string, unknown>): void {
    const message = JSON.stringify({ type: 'status', data: { status, ...data } }) + '\n';

    // Send to attached sockets
    for (const socket of this.attachedSockets) {
      try {
        socket.write(message);
      } catch {
        this.attachedSockets.delete(socket);
      }
    }

    // Send to watching sockets
    for (const socket of this.watchingSockets) {
      try {
        socket.write(message);
      } catch {
        this.watchingSockets.delete(socket);
      }
    }
  }

  private broadcastOutput(content: string): void {
    const message = JSON.stringify({ type: 'output', data: { content } }) + '\n';

    // Send to attached sockets
    for (const socket of this.attachedSockets) {
      try {
        socket.write(message);
      } catch {
        this.attachedSockets.delete(socket);
      }
    }

    // Send to watching sockets
    for (const socket of this.watchingSockets) {
      try {
        socket.write(message);
      } catch {
        this.watchingSockets.delete(socket);
      }
    }
  }

  static notificationForTask(task: TaskRecord): NotificationInput {
    const resultFull = task.error && task.error !== task.output ? `${task.output}\n${task.error}`.trim() : task.output;
    return {
      sessionId: task.sessionId, promptId: task.id, sessionName: task.sessionName,
      type: task.status === 'completed' ? 'prompt.completed' : 'prompt.error',
      goal: task.goal, exitCode: task.exitCode ?? null,
      durationMs: task.structuredResult?.durationMs, costUsd: task.structuredResult?.costUsd,
      resultPreview: resultFull.slice(0, 200), resultFull: resultFull.slice(0, 50000),
      claudeSessionId: task.claudeSessionId, viewCommand: `cb --task ${task.id}`,
    };
  }

  private emitSafely(event: string, data: unknown): void {
    for (const listener of this.rawListeners(event)) {
      try { listener.call(this, data); }
      catch (error) { console.error(`Task ${event} observer failed:`, error); }
    }
  }

  private publishTask(task: TaskRecord): void {
    if (this.publishedTasks.has(task.id)) return;
    this.publishedTasks.add(task.id);
    this.broadcastStatus(task.status === 'completed' ? 'completed' : 'error', { promptId: task.id, taskId: task.id, taskStatus: task.status, exitCode: task.exitCode, error: task.error });
    this.emitSafely(task.status === 'completed' ? 'prompt.completed' : 'prompt.error', { promptId: task.id, taskId: task.id, code: task.exitCode, error: task.error, status: task.status });
    this.emitSafely('task.terminal', task);
    this.emitSafely('notification', Session.notificationForTask(task));
  }

  getLastOutput(): string {
    if (!this.isProcessing && this.lastError) {
      const output = this.lastStructuredResult?.result ?? this.lastOutput;
      return output === this.lastError ? output : `${output}\n${this.lastError}`.trim();
    }
    if (this.lastStructuredResult) return this.lastStructuredResult.result;
    // Fall back to raw output, attempting JSON parse
    const raw = this.isProcessing ? this.currentPromptOutput.join('') : this.lastOutput;
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed.result !== undefined) return parsed.result;
    } catch { /* not JSON */ }
    return raw;
  }

  getLastRawOutput(): string {
    return this.isProcessing ? this.currentPromptOutput.join('') : this.lastOutput;
  }

  getFullTranscript(): string {
    return this.outputBuffer.join('');
  }

  attach(socket: Socket): void {
    this.attachedSockets.add(socket);

    // Send buffered output (last N characters to avoid overwhelming)
    const transcript = this.outputBuffer.join('');
    const recentOutput = transcript.slice(-10000); // Last 10KB
    if (recentOutput) {
      socket.write(JSON.stringify({ type: 'output', data: { content: recentOutput } }) + '\n');
    }

    socket.on('close', () => {
      this.attachedSockets.delete(socket);
    });
  }

  detach(socket: Socket): void {
    this.attachedSockets.delete(socket);
  }

  watch(socket: Socket): void {
    this.watchingSockets.add(socket);

    // Send current prompt output if any
    if (this.currentPromptOutput.length > 0) {
      const content = this.currentPromptOutput.join('');
      socket.write(JSON.stringify({ type: 'output', data: { content } }) + '\n');
    }

    socket.on('close', () => {
      this.watchingSockets.delete(socket);
    });
  }

  unwatch(socket: Socket): void {
    this.watchingSockets.delete(socket);
  }

  writeStdin(data: string): void {
    if (this.process) {
      if ('write' in this.process) {
        // PTY
        (this.process as NodePty.IPty).write(data);
      } else if ((this.process as ChildProcess).stdin?.writable) {
        // Regular process
        (this.process as ChildProcess).stdin?.write(data);
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (this.process && 'resize' in this.process) {
      (this.process as NodePty.IPty).resize(cols, rows);
    }
  }

  private async terminateChild(child: ChildProcess | NodePty.IPty): Promise<void> {
    if (!('once' in child)) {
      try { child.kill(); } catch { /* already stopped */ }
      return;
    }
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        child.off('close', done);
        child.off('error', done);
        resolve();
      };
      child.once('close', done);
      child.once('error', done);
      const timer = setTimeout(() => {
        signalChild(child, 'SIGKILL');
        done();
      }, 2000);
      try { signalChild(child, 'SIGTERM'); } catch { done(); }
    });
  }

  async stop(): Promise<void> {
    if (this.stopOperation) return this.stopOperation;
    this.stopping = true;
    this.stopOperation = (async () => {
      await Promise.allSettled([...this.submissions]);
      const queued = this.promptQueue.splice(0);
      for (const task of queued) await this.cancelTask(task.id);
      if (this.activeTask) await this.cancelTask(this.activeTask.id);
      if (this.finalization) await this.finalization;
      for (const socket of this.attachedSockets) socket.end();
      for (const socket of this.watchingSockets) socket.end();
      this.attachedSockets.clear();
      this.watchingSockets.clear();
      this.removeAllListeners();
    })();
    return this.stopOperation;
  }

  async exportTranscript(): Promise<string> {
    const historyPath = `${this.sessionDir}/history.jsonl`;
    try {
      return await readFile(historyPath, 'utf-8');
    } catch {
      return '';
    }
  }
}

// Types come from `import type * as NodePty from 'node-pty'` at the top of the file.
