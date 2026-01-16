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

  // Common variables
  env.CLAUDE_B_EVENT = event.type;
  env.CLAUDE_B_TIMESTAMP = event.timestamp;

  // Flatten payload into environment variables
  const payload = event.payload as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    const envKey = `CLAUDE_B_${key.toUpperCase()}`;
    if (typeof value === 'string') {
      env[envKey] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      env[envKey] = String(value);
    } else if (value !== null && value !== undefined) {
      env[envKey] = JSON.stringify(value);
    }
  }

  // Also provide full payload as JSON
  env.CLAUDE_B_PAYLOAD = JSON.stringify(event.payload);

  return env;
}

// Substitute variables in command string
function substituteVariables(command: string, event: HookEvent): string {
  let result = command;
  const payload = event.payload as Record<string, unknown>;

  // Replace $EVENT, $TIMESTAMP, etc.
  result = result.replace(/\$EVENT/g, event.type);
  result = result.replace(/\$TIMESTAMP/g, event.timestamp);

  // Replace payload variables like $sessionId, $promptId, etc.
  for (const [key, value] of Object.entries(payload)) {
    const pattern = new RegExp(`\\$${key}`, 'g');
    if (typeof value === 'string') {
      result = result.replace(pattern, value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      result = result.replace(pattern, String(value));
    }
  }

  return result;
}

export async function executeShellHook(
  hook: ShellHook,
  event: HookEvent
): Promise<ShellHookResult> {
  const startTime = Date.now();
  const timeout = hook.timeout || 30000;

  // Substitute variables in command
  const command = substituteVariables(hook.command, event);
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
