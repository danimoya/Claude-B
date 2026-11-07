import { createConnection } from 'net';
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from 'fs/promises';
import type { Stats } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export function parseDaemonPid(value: string): number | undefined {
  if (!/^[1-9]\d*\s*$/.test(value)) return undefined;
  const pid = Number(value.trim());
  return Number.isSafeInteger(pid) && pid <= 2147483647 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    // EPERM still proves that a process owns this PID. Unknown failures are
    // likewise not evidence that deleting its state would be safe.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function socketIsActive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(() => finish(new Error('Cannot establish socket ownership: probe timed out')), 1000);
    const finish = (error?: Error, active = false) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(active);
    };
    socket.once('connect', () => finish(undefined, true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish();
      else finish(error);
    });
  });
}

async function statOrMissing(path: string): Promise<Stats | undefined> {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

function sameFile(left: Stats | undefined, right: Stats | undefined): boolean {
  return !!left && !!right && left.ino === right.ino && left.dev === right.dev;
}

export interface InstanceLockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  socketActive?: (path: string) => Promise<boolean>;
}

/** Exclusive daemon ownership; every destructive cleanup requires proof. */
export class DaemonInstanceLock {
  private readonly lockPath: string;
  private readonly pidPath: string;
  private readonly socketPath: string;
  private readonly pid: number;
  private readonly isAlive: (pid: number) => boolean;
  private readonly socketActive: (path: string) => Promise<boolean>;
  private identity?: Stats;
  private socketIdentity?: Stats;

  constructor(private readonly configDir: string, options: InstanceLockOptions = {}) {
    this.lockPath = join(configDir, 'daemon.lock');
    this.pidPath = join(configDir, 'daemon.pid');
    this.socketPath = join(configDir, 'daemon.sock');
    this.pid = options.pid ?? process.pid;
    this.isAlive = options.isAlive ?? processIsAlive;
    this.socketActive = options.socketActive ?? socketIsActive;
    if (parseDaemonPid(String(this.pid)) !== this.pid) throw new Error('Invalid daemon PID');
  }

  private async owner(path: string): Promise<number | undefined> {
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe daemon ownership file: ${path}`);
      if (process.getuid && stat.uid !== process.getuid()) throw new Error(`Daemon ownership file belongs to another user: ${path}`);
      const pid = parseDaemonPid(await readFile(path, 'utf8'));
      if (pid === undefined) throw new Error(`Malformed daemon ownership file: ${path}`);
      return pid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  async acquire(): Promise<void> {
    if (this.identity) throw new Error('Daemon lock already acquired');
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.configDir);
    if (!directory.isDirectory() || (process.getuid && directory.uid !== process.getuid())) throw new Error('Daemon state directory must be owned by the current user');
    await chmod(this.configDir, 0o700);
    const claim = join(this.configDir, `.daemon-claim-${this.pid}-${randomUUID()}`);
    await writeFile(claim, `${this.pid}\n`, { flag: 'wx', mode: 0o600 });
    try {
      try {
        await link(claim, this.lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // Serialize stale-lock recovery. Never guess at an unreadable or
        // orphaned recovery guard: it fails closed for explicit inspection.
        const recovery = `${this.lockPath}.recovery`;
        try { await link(claim, recovery); }
        catch (failure) {
          if ((failure as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Daemon lock recovery is already in progress');
          throw failure;
        }
        try {
          const owner = await this.owner(this.lockPath);
          if (owner !== undefined && this.isAlive(owner)) throw new Error(`Daemon already running (PID: ${owner})`);
          if (owner !== undefined) await unlink(this.lockPath);
          // Another ordinary acquirer may have won after stale removal. An
          // exclusive link cannot overwrite its lock, even in that race.
          await link(claim, this.lockPath);
        } finally {
          if (sameFile(await statOrMissing(recovery), await statOrMissing(claim))) await unlink(recovery);
        }
      }
      this.identity = await lstat(claim);
      const existingPid = await this.owner(this.pidPath);
      if (existingPid !== undefined && this.isAlive(existingPid)) throw new Error(`Daemon PID file belongs to a live process (${existingPid})`);
      const socket = await statOrMissing(this.socketPath);
      if (socket) {
        if (!socket.isSocket()) throw new Error('Daemon socket path is not a socket');
        if (await this.socketActive(this.socketPath)) throw new Error('Daemon socket is already accepting connections');
        await unlink(this.socketPath);
      }
      await writeFile(this.pidPath, `${this.pid}\n`, { mode: 0o600 });
      await chmod(this.pidPath, 0o600);
    } catch (error) {
      await this.release();
      throw error;
    } finally {
      await unlink(claim).catch(() => {});
    }
  }

  /** Call after the IPC listener binds, before accepting startup as complete. */
  async recordSocket(): Promise<void> {
    if (!sameFile(this.identity, await statOrMissing(this.lockPath))) throw new Error('Daemon lock ownership was lost');
    this.socketIdentity = await statOrMissing(this.socketPath);
    if (!this.socketIdentity?.isSocket()) throw new Error('Daemon listener did not create a socket');
    if (process.getuid && this.socketIdentity.uid !== process.getuid()) throw new Error('Daemon socket belongs to another user');
    await chmod(this.socketPath, 0o600);
  }

  /** Call only after closing the IPC server; foreign state is always preserved. */
  async release(): Promise<void> {
    if (!sameFile(this.identity, await statOrMissing(this.lockPath))) return;
    let owner: number | undefined;
    try { owner = await this.owner(this.pidPath); } catch { /* preserve malformed PID/socket */ }
    if (owner === this.pid) {
      if (sameFile(this.socketIdentity, await statOrMissing(this.socketPath))) await unlink(this.socketPath);
      await unlink(this.pidPath).catch(() => {});
    }
    await unlink(this.lockPath);
    this.identity = undefined;
    this.socketIdentity = undefined;
  }
}
