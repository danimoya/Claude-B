import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server, type Socket } from 'net';
import { mkdtemp, mkdir, rm } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { DaemonClient } from './client.js';

describe('DaemonClient state targeting', () => {
  let dir: string;
  let server: Server | undefined;
  let client: DaemonClient | undefined;
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    server = undefined;
    client = undefined;
    dir = await mkdtemp(join(tmpdir(), 'cb-client-'));
    vi.stubEnv('CB_DATA_DIR', dir);
  });

  afterEach(async () => {
    client?.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function listen(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    server = createServer((socket) => {
      sockets.add(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const request = JSON.parse(line) as { id: number; method: string };
          if (request.method !== 'hold') socket.write(JSON.stringify({ id: request.id, data: { method: request.method } }) + '\n');
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(path, resolve);
    });
  }

  it('connects to the same CB_DATA_DIR socket as the daemon', async () => {
    await listen(join(dir, 'daemon.sock'));
    client = new DaemonClient();
    await expect(client.send({ method: 'status' })).resolves.toMatchObject({ data: { method: 'status' } });
  });

  it('honors an explicit socket override', async () => {
    const socketPath = join(dir, 'custom.sock');
    await listen(socketPath);
    vi.stubEnv('CB_DATA_DIR', join(dir, 'other'));
    client = new DaemonClient(socketPath);
    await expect(client.send({ method: 'status' })).resolves.toMatchObject({ data: { method: 'status' } });
  });

  it('uses the default state directory when CB_DATA_DIR is absent', async () => {
    vi.stubEnv('CB_DATA_DIR', undefined);
    await listen(join(homedir(), '.claude-b', 'daemon.sock'));
    client = new DaemonClient();
    await expect(client.send({ method: 'status' })).resolves.toMatchObject({ data: { method: 'status' } });
  });

  it('coalesces simultaneous sends onto one connection and clears completed timers', async () => {
    await listen(join(dir, 'daemon.sock'));
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    client = new DaemonClient();
    const responses = await Promise.all([client.send({ method: 'first' }), client.send({ method: 'second' })]);
    expect(responses.map(response => response.data?.method)).toEqual(['first', 'second']);
    expect(sockets.size).toBe(1);
    expect(cleared).toHaveBeenCalledTimes(4);
  });

  it('rejects all requests immediately when the peer closes', async () => {
    await listen(join(dir, 'daemon.sock'));
    client = new DaemonClient();
    const requests = Promise.allSettled([client.send({ method: 'hold' }), client.send({ method: 'hold' })]);
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    for (const socket of sockets) socket.destroy();
    const results = await requests;
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'Daemon connection closed' }) });
  });

  it('close rejects outstanding requests and permits a later fresh connection', async () => {
    await listen(join(dir, 'daemon.sock'));
    client = new DaemonClient();
    const request = client.send({ method: 'hold' });
    const rejected = expect(request).rejects.toThrow('Daemon client closed');
    await vi.waitFor(() => expect(sockets.size).toBe(1));
    client.close();
    await rejected;
    expect((await client.send({ method: 'again' })).data?.method).toBe('again');
  });

  it('times out an unanswered request without leaving its timer referenced', async () => {
    await listen(join(dir, 'daemon.sock'));
    const timers = vi.spyOn(globalThis, 'setTimeout');
    client = new DaemonClient(undefined, 30);
    const request = client.send({ method: 'hold' });
    await expect(request).rejects.toThrow('Request timeout');
    const timerIndex = timers.mock.calls.findIndex(([, delay]) => delay === 30);
    const requestTimer = timers.mock.results[timerIndex]?.value;
    // Node marks a fired timer destroyed; no timer may keep the CLI alive.
    expect(requestTimer).toBeDefined();
    expect(requestTimer.hasRef()).toBe(false);
  });

  it('honors a shorter per-call deadline and can read again without resubmitting', async () => {
    await listen(join(dir, 'daemon.sock'));
    client = new DaemonClient(undefined, 30000);
    await expect(client.send({ method: 'hold' }, 20)).rejects.toThrow('Request timeout');
    expect((await client.send({ method: 'read' })).data?.method).toBe('read');
  });

  it('drops an incomplete frame before reconnecting after peer failure', async () => {
    await listen(join(dir, 'daemon.sock'));
    let connections = 0;
    server!.on('connection', socket => {
      if (++connections === 1) {
        socket.write('{"incomplete":');
        setTimeout(() => socket.destroy(), 10);
      }
    });
    client = new DaemonClient(undefined, 200);
    await expect(client.send({ method: 'hold' })).rejects.toThrow('Daemon connection closed');
    expect((await client.send({ method: 'fresh' })).data?.method).toBe('fresh');
  });

  it('preserves UTF-8 task output split inside a multibyte socket chunk', async () => {
    await listen(join(dir, 'daemon.sock'));
    const output = 'exact été ✓ output\n';
    const bytes = Buffer.from(JSON.stringify({ id: 1, data: { output } }) + '\n');
    const boundary = bytes.indexOf(Buffer.from('é')) + 1;
    server!.once('connection', socket => {
      socket.write(bytes.subarray(0, boundary));
      setTimeout(() => socket.write(bytes.subarray(boundary)), 10);
    });
    client = new DaemonClient(undefined, 500);
    expect((await client.send({ method: 'hold' })).data?.output).toBe(output);
  });
});
