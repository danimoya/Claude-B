// Shell hook execution

import { spawn } from 'child_process';
import { HookEvent, HookEventType } from './events.js';

export interface ShellHook {
  id: string;
  event: HookEventType | '*';  // '*' matches all events
  command: string;
  timeout?: number;  // milliseconds, default 30000
  sessionFilter?: string;  // only trigger for this sessionId
  enabled: boolean;
  createdAt: string;
}

export interface ShellHookResult {
  retryable?: boolean;
  hookId: string;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
}

// Environment variables available in shell hooks
function buildHookEnv(event: HookEvent): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  // Flatten payload into environment variables
  const payload = event.payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    // Payload names are data too. Only valid identifiers can become variables.
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    const envKey = `CLAUDE_B_${key.toUpperCase()}`;
    let serialized: string | undefined;
    if (typeof value === 'string') serialized = value;
    else if (typeof value === 'number' || typeof value === 'boolean') serialized = String(value);
    else if (value !== null && value !== undefined) serialized = JSON.stringify(value);
    if (serialized === undefined) continue;
    env[envKey] = serialized;

    // Preserve historical $sessionId/$output aliases through shell expansion,
    // never by inserting values into the command's source. Upper-case names
    // cannot become aliases: PATH, ENV and BASH_ENV affect shell execution.
    if (/^[a-z][a-zA-Z0-9_]*$/.test(key)) env[key] = serialized;
  }

  // Assign metadata last so payload keys cannot override it.
  env.CLAUDE_B_EVENT_ID = event.id || '';
  env.EVENT_ID = event.id || '';
  env.CLAUDE_B_EVENT = event.type;
  env.CLAUDE_B_TIMESTAMP = event.timestamp;
  env.EVENT = event.type;
  env.TIMESTAMP = event.timestamp;

  // Also provide full payload as JSON
  env.CLAUDE_B_PAYLOAD = JSON.stringify(event.payload);

  return env;
}

export async function executeShellHook(
  hook: ShellHook,
  event: HookEvent,
  signal?: AbortSignal
): Promise<ShellHookResult> {
  const startTime = Date.now();
  const timeout = Number.isFinite(hook.timeout) && hook.timeout! > 0 ? Math.min(hook.timeout!, 60000) : 30000;
  if (signal?.aborted) return { hookId: hook.id, success: false, retryable: false, exitCode: null, stdout: '', stderr: 'Hook delivery aborted', duration: 0 };
  const env = buildHookEnv(event);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stopped: string | undefined;
    let finished = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const proc = spawn('sh', ['-c', hook.command], {
      env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32'
    });
    const finish = (code: number | null, error?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      if (stopped) kill('SIGKILL');
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', abort);
      resolve({ hookId: hook.id, success: code === 0 && !stopped && !error, retryable: false,
        exitCode: stopped ? null : code, stdout: stdout.trim(),
        stderr: stopped || error || stderr.trim(), duration: Date.now() - startTime });
    };
    const kill = (kind: NodeJS.Signals) => {
      if (process.platform !== 'win32' && proc.pid) {
        try { process.kill(-proc.pid, kind); return; } catch { /* process group already gone */ }
      }
      try { proc.kill(kind); } catch { /* already closed */ }
    };
    const stop = (reason: string) => {
      if (finished || stopped) return;
      stopped = reason;
      killTimer = setTimeout(() => { kill('SIGKILL'); finish(null); }, 250);
      kill('SIGTERM');
    };
    const abort = () => stop('Hook delivery aborted');
    const timeoutId = setTimeout(() => stop(`Hook timed out after ${timeout}ms`), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    proc.stdout?.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-100000); });
    proc.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-100000); });
    proc.once('close', code => finish(code));
    proc.on('error', error => finish(null, error.message));
  });
}
