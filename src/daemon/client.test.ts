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
  });

  async function listen(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString()) as { id: number; method: string };
        socket.write(JSON.stringify({ id: request.id, data: { method: request.method } }) + '\n');
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
});
