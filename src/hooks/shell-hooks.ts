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
  event: HookEvent
): Promise<ShellHookResult> {
  const startTime = Date.now();
  const timeout = hook.timeout || 30000;

  // The operator-authored command is trusted shell source; payload values are
  // passed only through the environment and are never parsed as shell source.
  const command = hook.command;
  const env = buildHookEnv(event);

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const proc = spawn('sh', ['-c', command], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    // Set timeout
    const timeoutId = setTimeout(() => {
      killed = true;
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already dead
        }
      }, 1000);
    }, timeout);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Limit output size
      if (stdout.length > 100000) {
        stdout = stdout.slice(-100000);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 100000) {
        stderr = stderr.slice(-100000);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      resolve({
        hookId: hook.id,
        success: code === 0 && !killed,
        exitCode: killed ? null : code,
        stdout: stdout.trim(),
        stderr: killed ? `Hook timed out after ${timeout}ms` : stderr.trim(),
        duration: Date.now() - startTime
      });
    });

    proc.on('error', (error) => {
      clearTimeout(timeoutId);
      resolve({
        hookId: hook.id,
        success: false,
        exitCode: null,
        stdout: '',
        stderr: error.message,
        duration: Date.now() - startTime
      });
    });
  });
}
