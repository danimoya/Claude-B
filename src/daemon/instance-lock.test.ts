import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'net';
import { execFileSync } from 'child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DaemonInstanceLock, parseDaemonPid } from './instance-lock.js';

describe('daemon instance ownership', () => {
  let dir: string;
  let server: Server | undefined;
  let locks: DaemonInstanceLock[];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-lock-'));
    locks = [];
    server = undefined;
  });
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    for (const lock of locks) await lock.release();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const path = (name: string) => join(dir, `daemon.${name}`);
  const lock = (pid: number, alive = (owner: number) => owner === pid) => {
    const instance = new DaemonInstanceLock(dir, { pid, isAlive: alive });
    locks.push(instance);
    return instance;
  };
  async function listen() {
    server = createServer(socket => socket.end());
    await new Promise<void>(resolve => server!.listen(path('sock'), resolve));
  }

  it.each(['123x', '0', '-1', '', ' 123', '999999999999999999', '123\n456'])('rejects the entire malformed PID %j', value => {
    expect(parseDaemonPid(value)).toBeUndefined();
  });

  it('elects only one owner during concurrent startup and protects its PID and lock', async () => {
    const first = lock(111, () => true);
    const second = lock(222, () => true);
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? 111 : 222;
    expect(await readFile(path('pid'), 'utf8')).toBe(`${winner}\n`);
    expect(await readFile(path('lock'), 'utf8')).toBe(`${winner}\n`);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(path('pid'))).mode & 0o777).toBe(0o600);
    expect((await stat(path('lock'))).mode & 0o777).toBe(0o600);
  });

  it('serializes concurrent stale-lock reclamation without removing the new winner', async () => {
    await writeFile(path('lock'), '999\n');
    await writeFile(path('pid'), '999\n');
    const alive = (pid: number) => pid === 111 || pid === 222;
    const first = lock(111, alive);
    const second = lock(222, alive);
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0].status === 'fulfilled' ? 111 : 222;
    expect(await readFile(path('lock'), 'utf8')).toBe(`${winner}\n`);
    expect(await readFile(path('pid'), 'utf8')).toBe(`${winner}\n`);
  });

  it('preserves every live-owner file and socket when a valid live PID is present', async () => {
    await writeFile(path('pid'), '999\n');
    await listen();
    await expect(lock(111, () => true).acquire()).rejects.toThrow('live process');
    expect(await readFile(path('pid'), 'utf8')).toBe('999\n');
    expect((await stat(path('sock'))).isSocket()).toBe(true);
  });

  it('fails closed for malformed locks and PID files instead of guessing their owner', async () => {
    await writeFile(path('lock'), '999trailing');
    await expect(lock(111).acquire()).rejects.toThrow('Malformed');
    expect(await readFile(path('lock'), 'utf8')).toBe('999trailing');
    await rm(path('lock'));
    await writeFile(path('pid'), '999trailing');
    await expect(lock(222).acquire()).rejects.toThrow('Malformed');
    expect(await readFile(path('pid'), 'utf8')).toBe('999trailing');
  });

  it('removes a proven dead socket and stale PID while taking ownership', async () => {
    execFileSync(process.execPath, ['-e', "require('net').createServer().listen(process.argv[1],()=>process.exit(0))", path('sock')]);
    await writeFile(path('pid'), '999\n');
    const instance = lock(111);
    await instance.acquire();
    await expect(stat(path('sock'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path('pid'), 'utf8')).toBe('111\n');
  });

  it('refuses an active socket even if the PID file is missing', async () => {
    await listen();
    await expect(lock(111).acquire()).rejects.toThrow('accepting connections');
    expect((await stat(path('sock'))).isSocket()).toBe(true);
  });

  it('cannot release a replacement lock or another live owner socket/PID', async () => {
    const instance = lock(111);
    await instance.acquire();
    await listen();
    await instance.recordSocket();
    expect((await stat(path('sock'))).mode & 0o777).toBe(0o600);
    await rm(path('lock'));
    await writeFile(path('lock'), '222\n');
    await writeFile(path('pid'), '222\n');
    await instance.release();
    expect(await readFile(path('lock'), 'utf8')).toBe('222\n');
    expect(await readFile(path('pid'), 'utf8')).toBe('222\n');
    expect((await stat(path('sock'))).isSocket()).toBe(true);
  });

  it('treats a permission-denied process probe as live ownership', async () => {
    await writeFile(path('lock'), '999\n');
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); });
    const instance = new DaemonInstanceLock(dir);
    locks.push(instance);
    await expect(instance.acquire()).rejects.toThrow('already running');
    expect(await readFile(path('lock'), 'utf8')).toBe('999\n');
  });
});
