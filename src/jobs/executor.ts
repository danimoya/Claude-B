import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { TaskExecutor } from './types.js';

export interface ExecutorProcess extends TaskExecutor { state: string }
export interface ExecutorRecovery {
  stopped: boolean;
  explanation: string;
}
export interface ExecutorRecoveryOptions {
  inspect?: (pid: number) => ExecutorProcess | null;
  groupMembers?: (processGroup: number) => ExecutorProcess[];
  signal?: (processGroup: number, signal: NodeJS.Signals) => void;
  uid?: number;
  ownPid?: number;
  ownGroup?: number;
  graceMs?: number;
}

function birthToken(pid: number, portableStart: string): string {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      if (/^[a-f0-9-]{36}$/.test(bootId) && /^\d+$/.test(fields[19] || '')) return `linux:${bootId}:${fields[19]}`;
    } catch { /* a process that disappeared cannot be proven owned */ }
  }
  return `ps:${portableStart}`;
}

function parseProcesses(output: string, onlyGroup?: number): ExecutorProcess[] {
  const processes: ExecutorProcess[] = [];
  for (const line of output.trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    const [pid, uid, processGroup] = fields.slice(0, 3).map(Number);
    const state = fields[3];
    const portableStart = fields.slice(4).join(' ');
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(uid) || uid < 0 ||
        !Number.isSafeInteger(processGroup) || processGroup <= 0 || !state || !portableStart) continue;
    if (onlyGroup !== undefined && processGroup !== onlyGroup) continue;
    processes.push({ pid, uid, processGroup, state, startedAt: birthToken(pid, portableStart) });
  }
  return processes;
}

function ps(args: string[]): string {
  const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error('Executor identity inspection failed');
  return result.stdout;
}
const PS_FIELDS = ['-o', 'pid=', '-o', 'uid=', '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='];

export function inspectExecutorProcess(pid: number): ExecutorProcess | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return parseProcesses(ps(['-p', String(pid), ...PS_FIELDS])).find(row => row.pid === pid) || null;
}

function groupMembers(processGroup: number): ExecutorProcess[] {
  return parseProcesses(ps(['-ax', ...PS_FIELDS]), processGroup);
}

export function captureTaskExecutor(pid: number): TaskExecutor {
  const owner = process.getuid?.();
  const actual = inspectExecutorProcess(pid);
  if (owner === undefined || !actual || actual.uid !== owner || actual.pid !== actual.processGroup || actual.state.startsWith('Z')) {
    throw new Error('Cannot prove ownership of the spawned executor group');
  }
  return { pid: actual.pid, processGroup: actual.processGroup, uid: actual.uid, startedAt: actual.startedAt };
}

function sameExecutor(expected: TaskExecutor, actual: ExecutorProcess | null): boolean {
  return !!actual && actual.pid === expected.pid && actual.processGroup === expected.processGroup &&
    actual.uid === expected.uid && actual.startedAt === expected.startedAt;
}

/** Signal only an exact same-UID executor group proven to belong to this receipt. */
export async function recoverTaskExecutor(executor: TaskExecutor | undefined,
  options: ExecutorRecoveryOptions = {}): Promise<ExecutorRecovery> {
  if (!executor) return { stopped: false, explanation: 'Executor ownership is unknown; no process was signalled.' };
  const inspect = options.inspect || inspectExecutorProcess;
  const members = options.groupMembers || groupMembers;
  const signal = options.signal || ((group: number, kind: NodeJS.Signals) => { process.kill(-group, kind); });
  const uid = options.uid ?? process.getuid?.();
  const ownPid = options.ownPid ?? process.pid;
  const grace = Math.max(0, Math.min(options.graceMs ?? 250, 2000));
  try {
    const ownGroup = options.ownGroup ?? inspect(ownPid)?.processGroup;
    if (uid === undefined || executor.uid !== uid || executor.pid !== executor.processGroup ||
        executor.pid === ownPid || executor.processGroup === ownGroup) {
      return { stopped: false, explanation: 'Executor ownership could not be verified; no process was signalled.' };
    }
    const leader = inspect(executor.pid);
    if (!leader) return { stopped: false, explanation: 'Recorded executor is no longer present; no process was signalled.' };
    if (!sameExecutor(executor, leader)) return { stopped: false, explanation: 'Executor identity changed; no process was signalled.' };
    const live = () => members(executor.processGroup).filter(member => !member.state.startsWith('Z'));
    const validate = () => {
      const current = inspect(executor.pid);
      if (current && !sameExecutor(executor, current)) throw new Error('Executor PID was reused');
      const group = live();
      if (group.some(member => member.uid !== uid)) throw new Error('Executor group owner changed');
      if (group.some(member => member.pid === executor.pid && !sameExecutor(executor, member))) throw new Error('Executor PID was reused');
      return group;
    };
    if (!validate().length) return { stopped: true, explanation: 'Recorded executor group has already stopped.' };
    signal(executor.processGroup, 'SIGTERM');
    let deadline = Date.now() + grace;
    while (validate().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (validate().length) signal(executor.processGroup, 'SIGKILL');
    deadline = Date.now() + grace;
    while (validate().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (validate().length) return { stopped: false, explanation: 'Verified executor group did not stop within the bounded recovery window.' };
    return { stopped: true, explanation: 'Verified owned executor group was terminated before restart recovery.' };
  } catch {
    return { stopped: false, explanation: 'Executor ownership or termination could not be verified; no further process signals were sent.' };
  }
}
