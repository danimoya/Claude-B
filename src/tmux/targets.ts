import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface TmuxPaneIdentity { paneId: string; pid: number; command: string }
export type TmuxRunner = (args: string[], input?: string) => Promise<string>;
export const PANE_IDENTITY_FORMAT = '#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}';

export const runTmux: TmuxRunner = (args, input) => new Promise((resolve, reject) => {
  const child = spawn('tmux', args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let done = false;
  const finish = (error?: Error) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve(stdout);
  };
  const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error('Tmux operation timed out')); }, 2000);
  child.stdout?.on('data', (data: Buffer) => {
    stdout += data.toString();
    if (stdout.length > 1024 * 1024) { child.kill('SIGKILL'); finish(new Error('Tmux response exceeded its limit')); }
  });
  child.once('error', () => finish(new Error('Tmux is unavailable')));
  child.once('close', code => finish(code === 0 ? undefined : new Error('Tmux pane operation failed')));
  child.stdin?.on('error', () => finish(new Error('Tmux input failed')));
  child.stdin?.end(input);
});

export function parseTmuxPaneIdentity(output: string): TmuxPaneIdentity {
  const [paneId, pidText, dead, command] = output.trim().split('\t');
  const pid = Number(pidText);
  if (!/^%\d+$/.test(paneId || '') || !Number.isSafeInteger(pid) || pid <= 0 || dead !== '0' ||
      !command || /[\r\n\0]/.test(command)) throw new Error('Tmux pane is not a live identifiable process');
  return { paneId, pid, command };
}

export async function resolveTmuxPane(target: string, runner = runTmux): Promise<TmuxPaneIdentity> {
  if (!/^%\d+$/.test(target) && !/^[A-Za-z0-9_.-]+:\d+\.\d+$/.test(target)) throw new Error('Invalid tmux target');
  return parseTmuxPaneIdentity(await runner(['display-message', '-p', '-t', target, PANE_IDENTITY_FORMAT]));
}

async function verify(expected: TmuxPaneIdentity, runner: TmuxRunner) {
  const actual = await resolveTmuxPane(expected.paneId, runner);
  if (actual.paneId !== expected.paneId || actual.pid !== expected.pid || actual.command !== expected.command) {
    throw new Error('Tmux pane identity changed; select the live agent again');
  }
}

/** Target the recorded %pane ID, verifying process identity before every effect. */
export async function pasteToTmuxPane(expected: TmuxPaneIdentity, text: string,
  runner = runTmux, settleMs = 150): Promise<void> {
  const buffer = `cb-${randomUUID()}`;
  await verify(expected, runner);
  try {
    await runner(['load-buffer', '-b', buffer, '-'], text);
    await verify(expected, runner);
    await runner(['paste-buffer', '-r', '-p', '-d', '-b', buffer, '-t', expected.paneId]);
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, Math.min(settleMs, 1000)));
    await verify(expected, runner);
    await runner(['send-keys', '-t', expected.paneId, 'Enter']);
  } finally {
    await runner(['delete-buffer', '-b', buffer]).catch(() => {});
  }
}
