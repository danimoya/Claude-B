import { spawn, ChildProcess } from 'child_process';
import { Socket } from 'net';
import { randomUUID } from 'crypto';
import { nanoid } from 'nanoid';
import { EventEmitter } from 'events';
import { mkdir, writeFile, readFile, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { getClaudePath } from '../utils/claude-detector.js';

// Try to import node-pty, fall back to regular spawn if not available
let pty: typeof import('node-pty') | null = null;
try {
  pty = await import('node-pty');
} catch {
  // node-pty not available, will use spawn fallback
}

export interface StructuredResult {
  result: string;
  durationMs: number;
  costUsd: number;
  numTurns: number;
  isError: boolean;
}

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

  private workingDir: string;
  private configDir: string;
  private sessionDir: string;
  private process: ChildProcess | pty.IPty | null = null;
  private outputBuffer: string[] = [];
  private currentPromptOutput: string[] = [];
  private lastOutput: string = '';
  private lastPromptId?: string;
  private promptCount: number = 0;
  private attachedSockets: Set<Socket> = new Set();
  private watchingSockets: Set<Socket> = new Set();
  private promptQueue: Array<{ prompt: string; promptId: string }> = [];
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
    this.configDir = configDir;
    this.sessionDir = `${configDir}/sessions/${this.id}`;
    this.lastPromptId = state.lastPromptId;
    this.promptCount = state.promptCount || 0;
    this.claudeSessionId = state.claudeSessionId;
    this.goal = state.goal;
    this.fireAndForget = state.fireAndForget || false;
    this.lastActivityAt = state.lastActivityAt || state.createdAt;
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
    try {
      await this.ensureSessionDir();
      if (this.lastOutput) {
        await writeFile(`${this.sessionDir}/last-output.txt`, this.lastOutput);
      }
      if (this.lastStructuredResult) {
        await writeFile(`${this.sessionDir}/last-result.json`, JSON.stringify(this.lastStructuredResult));
      }
    } catch { /* ignore */ }
  }

  static create(name: string | undefined, configDir: string, model?: string, goal?: string, fireAndForget?: boolean): Session {
    const now = new Date().toISOString();
    const state: SessionState = {
      id: nanoid(8),
      name,
      model,
      status: 'idle',
      createdAt: now,
      lastActivityAt: now,
      workingDir: process.cwd(),
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
      fireAndForget: this.fireAndForget
    };
  }

  getClaudeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  getStructuredResult(): StructuredResult | undefined {
    return this.lastStructuredResult;
  }

  private async ensureSessionDir(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
  }

  private async savePromptToHistory(entry: PromptEntry): Promise<void> {
    await this.ensureSessionDir();
    const historyPath = `${this.sessionDir}/history.jsonl`;
    await appendFile(historyPath, JSON.stringify(entry) + '\n');
  }

  private waitForReady(): Promise<void> {
    if (this.isReady) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.readyResolvers.push(resolve);
    });
  }

  private markReady(): void {
    if (this.isReady) return;
    this.isReady = true;
    for (const resolver of this.readyResolvers) {
      resolver();
    }
    this.readyResolvers = [];
  }

  private async startClaudeProcess(): Promise<void> {
    if (this.process) {
      return; // Already running
    }

    await this.ensureSessionDir();

    // Try to use PTY for full interactive support
    const claudePath = getClaudePath();
    if (pty) {
      this.process = pty.spawn(claudePath, ['--dangerously-skip-permissions'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.workingDir,
        env: { ...process.env, TERM: 'xterm-256color' }
      });

      (this.process as pty.IPty).onData((data: string) => {
        this.handleOutput(data);
      });

      (this.process as pty.IPty).onExit(({ exitCode }) => {
        this.handleProcessExit(exitCode);
      });
    } else {
      // Fallback to regular spawn with pipe
      const proc = spawn(claudePath, ['--print'], {
        cwd: this.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.process = proc;

      proc.stdout?.on('data', (chunk: Buffer) => {
        this.handleOutput(chunk.toString());
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        this.handleOutput(chunk.toString());
      });

      proc.on('exit', (code) => {
        this.handleProcessExit(code);
      });

      proc.on('error', (error) => {
        this.handleProcessError(error);
      });
    }
  }

  private handleOutput(data: string): void {
    this.outputBuffer.push(data);
    this.currentPromptOutput.push(data);
    this.broadcastOutput(data);

    // Check if Claude Code is ready (showing the input prompt "❯")
    // This indicates the startup is complete and it's ready for input
    if (!this.isReady && data.includes('❯')) {
      this.markReady();
    }

    // Check for completion markers (Claude's response ended)
    // This is heuristic - we look for common patterns indicating the AI finished
    const fullOutput = this.currentPromptOutput.join('');
    if (this.isProcessing && this.detectPromptCompletion(fullOutput)) {
      this.completeCurrentPrompt();
    }
  }

  private detectPromptCompletion(output: string): boolean {
    // Detection heuristics for when Claude finishes responding:
    // 1. Output ends with a prompt indicator (>)
    // 2. Output contains the typical Claude Code ending patterns
    // 3. After a period of no new output (handled by timeout)

    // For --print mode, completion is indicated by process exit
    // For interactive mode, we look for patterns
    const trimmed = output.trim();

    // Check for common completion patterns
    if (trimmed.endsWith('>') || trimmed.endsWith('> ')) {
      return true;
    }

    // Check if output contains typical response end markers
    if (trimmed.includes('─────') && trimmed.split('─────').length > 2) {
      // Multiple separator lines often indicate end of response
      return true;
    }

    return false;
  }

  private completeCurrentPrompt(): void {
    if (!this.isProcessing) return;

    this.isProcessing = false;
    this.status = 'idle';
    this.lastActivityAt = new Date().toISOString();
    this.lastOutput = this.currentPromptOutput.join('');

    // Save to history
    if (this.lastPromptId) {
      this.savePromptToHistory({
        id: this.lastPromptId,
        prompt: '', // We don't store the prompt here, it was logged when sent
        timestamp: new Date().toISOString(),
        status: 'completed',
        output: this.lastOutput
      }).catch(() => {});
    }

    // Persist output to disk for restart recovery
    this.persistOutput().catch(() => {});

    // Notify watchers that processing completed
    this.broadcastStatus('completed', { promptId: this.lastPromptId });

    this.emit('prompt.completed', { promptId: this.lastPromptId });
    this.notifyCompletion(0);
    this.currentPromptOutput = [];

    // Process next prompt in queue
    this.processNextPrompt();
  }

  private handleProcessExit(code: number | null): void {
    this.process = null;
    this.isReady = false; // Reset ready state for next process

    if (this.isProcessing) {
      this.status = 'idle';
      this.lastOutput = this.currentPromptOutput.join('');

      // Persist output to disk for restart recovery
      this.persistOutput().catch(() => {});

      // Notify watchers that processing completed
      this.broadcastStatus('completed', { promptId: this.lastPromptId, exitCode: code });

      this.emit('prompt.completed', { promptId: this.lastPromptId, code });
      this.notifyCompletion(code);
      this.currentPromptOutput = [];
      this.isProcessing = false;
    }

    // Process exited - for --print mode this is expected after each prompt
    // Restart for next prompt if needed
    this.processNextPrompt();
  }

  private handleProcessError(error: Error): void {
    this.status = 'idle';
    this.lastOutput = `Error: ${error.message}`;
    this.emit('prompt.error', { promptId: this.lastPromptId, error: error.message });
    this.process = null;
    this.isProcessing = false;

    // Emit errors for any queued prompts and clear the queue
    while (this.promptQueue.length > 0) {
      const queued = this.promptQueue.shift();
      if (queued) {
        this.emit('prompt.error', { promptId: queued.promptId, error: error.message });
      }
    }
  }

  async sendPrompt(prompt: string): Promise<string> {
    // Generate promptId immediately and return it
    // The actual processing happens asynchronously
    const promptId = nanoid(8);
    this.promptQueue.push({ prompt, promptId });

    // Start processing asynchronously (don't await)
    this.processNextPrompt().catch((err) => {
      console.error('Error processing prompt:', err);
    });

    return promptId;
  }

  private async processNextPrompt(): Promise<void> {
    if (this.isProcessing || this.promptQueue.length === 0) {
      return;
    }

    const { prompt, promptId } = this.promptQueue.shift()!;

    // promptId is now passed in from sendPrompt
    this.lastPromptId = promptId;
    this.promptCount++;
    this.status = 'busy';
    this.lastActivityAt = new Date().toISOString();
    this.isProcessing = true;
    this.currentPromptOutput = [];
    this.jsonBuffer = '';

    // Log the prompt
    await this.savePromptToHistory({
      id: promptId,
      prompt,
      timestamp: new Date().toISOString(),
      status: 'pending'
    });

    // Notify watchers that processing started
    this.broadcastStatus('processing', { promptId, prompt: prompt.slice(0, 100) });

    try {
      const claudePath = getClaudePath();
      const args = ['--print', '--dangerously-skip-permissions', '--output-format', 'json'];
      if (this.model) {
        args.push('--model', this.model);
      }

      // Conversation continuity: resume existing Claude session or create new one
      if (this.claudeSessionId) {
        args.push('--resume', this.claudeSessionId);
      } else {
        const newSessionId = randomUUID();
        args.push('--session-id', newSessionId);
      }

      const proc = spawn(claudePath, args, {
        cwd: this.workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.process = proc;

      proc.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.jsonBuffer += text;
        this.handleOutput(text);
      });

      proc.stderr?.on('data', (chunk: Buffer) => {
        this.handleOutput(chunk.toString());
      });

      proc.on('exit', (code) => {
        // Parse JSON output before handling exit to extract session_id and structured result
        this.parseClaudeJsonOutput(this.jsonBuffer);
        this.handleProcessExit(code);
      });

      proc.on('error', (error) => {
        this.handleProcessError(error);
      });

      // Write prompt and close stdin
      proc.stdin?.write(prompt);
      proc.stdin?.end();
    } catch (error) {
      this.isProcessing = false;
      this.status = 'idle';
      this.emit('prompt.error', { promptId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private parseClaudeJsonOutput(jsonStr: string): void {
    try {
      const parsed = JSON.parse(jsonStr.trim());
      // Extract and store Claude's session ID for conversation continuity
      if (parsed.session_id) {
        this.claudeSessionId = parsed.session_id;
      }
      // Store structured result for richer notifications
      this.lastStructuredResult = {
        result: parsed.result || '',
        durationMs: parsed.duration_ms || 0,
        costUsd: parsed.total_cost_usd || 0,
        numTurns: parsed.num_turns || 0,
        isError: parsed.is_error || false,
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

  private notifyCompletion(code: number | null): void {
    const sessionLabel = this.name || this.id;
    const isSuccess = code === 0 || code === null;
    const status = isSuccess ? 'completed' : `failed (exit ${code})`;
    const viewCmd = `cb -l`;

    const durationStr = this.lastStructuredResult?.durationMs
      ? `${(this.lastStructuredResult.durationMs / 1000).toFixed(1)}s`
      : '';
    const costStr = this.lastStructuredResult?.costUsd
      ? `$${this.lastStructuredResult.costUsd.toFixed(4)}`
      : '';

    const resultPreview = this.lastStructuredResult?.result?.slice(0, 200)
      || this.lastOutput?.slice(0, 200)
      || '';

    // Channel 1: Terminal bell
    try { process.stdout.write('\x07'); } catch { /* ignore */ }

    // Channel 2: notify-send (desktop, fails silently)
    try {
      const desktopMsg = `${sessionLabel}: ${status}\nView: ${viewCmd}`;
      const proc = spawn('notify-send', ['Claude-B', desktopMsg], { detached: true, stdio: 'ignore' });
      proc.on('error', () => {});
      proc.unref();
    } catch { /* ignore */ }

    // Full result (capped at 50KB)
    const fullResult = this.lastStructuredResult?.result || this.lastOutput || '';
    const resultFull = fullResult.slice(0, 50000);

    // Channel 3: Emit structured notification event (daemon writes to inbox)
    this.emit('notification', {
      sessionId: this.id,
      sessionName: this.name,
      type: isSuccess ? 'prompt.completed' as const : 'prompt.error' as const,
      goal: this.goal,
      exitCode: code,
      durationMs: this.lastStructuredResult?.durationMs,
      costUsd: this.lastStructuredResult?.costUsd,
      resultPreview,
      resultFull,
      claudeSessionId: this.claudeSessionId,
      viewCommand: viewCmd,
    });

    // Channel 4: Daemon log with copy-paste command
    const logParts = [`[Claude-B] ${sessionLabel} ${status}`];
    if (durationStr) logParts.push(durationStr);
    if (costStr) logParts.push(costStr);
    logParts.push(`| View: ${viewCmd}`);
    console.log(logParts.join(' | '));
  }

  getLastOutput(): string {
    // Return parsed result if available (from --output-format json)
    if (this.lastStructuredResult?.result) {
      return this.lastStructuredResult.result;
    }
    // Fall back to raw output, attempting JSON parse
    const raw = this.lastOutput || this.outputBuffer.join('');
    try {
      const parsed = JSON.parse(raw.trim());
      if (parsed.result !== undefined) return parsed.result;
    } catch { /* not JSON */ }
    return raw;
  }

  getLastRawOutput(): string {
    return this.lastOutput || this.outputBuffer.join('');
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
        (this.process as pty.IPty).write(data);
      } else if ((this.process as ChildProcess).stdin?.writable) {
        // Regular process
        (this.process as ChildProcess).stdin?.write(data);
      }
    }
  }

  resize(cols: number, rows: number): void {
    if (this.process && 'resize' in this.process) {
      (this.process as pty.IPty).resize(cols, rows);
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      if ('kill' in this.process && typeof this.process.kill === 'function') {
        if ('pid' in this.process) {
          // PTY
          (this.process as pty.IPty).kill();
        } else {
          // ChildProcess
          (this.process as ChildProcess).kill('SIGTERM');
        }
      }

      // Wait for exit with timeout
      await Promise.race([
        new Promise<void>((resolve) => {
          const checkInterval = setInterval(() => {
            if (!this.process) {
              clearInterval(checkInterval);
              resolve();
            }
          }, 100);
        }),
        new Promise<void>((resolve) => setTimeout(() => {
          // Force kill after 5 seconds
          if (this.process && 'kill' in this.process) {
            try {
              if ('pid' in this.process) {
                process.kill((this.process as pty.IPty).pid, 'SIGKILL');
              } else {
                (this.process as ChildProcess).kill('SIGKILL');
              }
            } catch {
              // Already dead
            }
          }
          this.process = null;
          resolve();
        }, 5000))
      ]);

      this.process = null;
    }

    // Close all sockets
    for (const socket of this.attachedSockets) {
      socket.end();
    }
    for (const socket of this.watchingSockets) {
      socket.end();
    }

    this.attachedSockets.clear();
    this.watchingSockets.clear();

    // Remove all external event listeners to prevent memory leaks
    this.removeAllListeners();
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

// Type augmentation for node-pty
declare namespace pty {
  interface IPty {
    pid: number;
    cols: number;
    rows: number;
    process: string;
    onData(callback: (data: string) => void): void;
    onExit(callback: (e: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  }

  function spawn(
    file: string,
    args: string[],
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    }
  ): IPty;
}
