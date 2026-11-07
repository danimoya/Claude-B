import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createIpcServer, type Server as IpcServer, type Socket } from 'node:net';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const readyScript = fileURLToPath(new URL('../../scripts/container-ready.mjs', import.meta.url));
const launcher = fileURLToPath(new URL('../../scripts/docker-launcher.sh', import.meta.url));
const installer = fileURLToPath(new URL('../../scripts/install.sh', import.meta.url));

describe('container readiness and persistent launcher', () => {
  let dir: string;
  let ipc: IpcServer | undefined;
  let http: Server | undefined;
  const sockets = new Set<Socket>();
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-container-'));
    ipc = undefined;
    http = undefined;
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (ipc) await new Promise<void>(resolve => ipc!.close(() => resolve()));
    if (http) { http.closeAllConnections(); await new Promise<void>(resolve => http!.close(() => resolve())); }
    await rm(dir, { recursive: true, force: true });
  });

  async function fixture(options: { pid?: number; health?: number } = {}) {
    const methods: string[] = [];
    ipc = createIpcServer(socket => {
      sockets.add(socket);
      socket.on('data', chunk => {
        const request = JSON.parse(chunk.toString());
        methods.push(request.method);
        socket.write(JSON.stringify({ id: request.id, data: request.method === 'daemon.status' ? { pid: options.pid ?? process.pid } : { success: true } }) + '\n');
      });
    });
    await new Promise<void>(resolve => ipc!.listen(join(dir, 'daemon.sock'), resolve));
    http = createServer((request, response) => {
      expect(request.url).toBe('/api/health');
      response.writeHead(options.health ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok' }));
    });
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP fixture port');
    return { methods, env: { ...process.env, CB_DATA_DIR: dir, CB_REST_PORT: String(address.port), CB_EXPECTED_DAEMON_PID: String(process.pid), CB_STARTUP_TIMEOUT_MS: '250' } };
  }

  it('requires the expected IPC daemon and starts REST before declaring readiness', async () => {
    const { methods, env } = await fixture();
    const result = await execute(process.execPath, [readyScript, 'start'], { env, timeout: 3000 });
    expect(result.stdout).toContain('IPC and REST are ready');
    expect(methods).toEqual(['daemon.status', 'rest.start', 'daemon.status']);
  });

  it('fails a bounded startup when the socket is absent', async () => {
    const start = Date.now();
    await expect(execute(process.execPath, [readyScript, 'start'], {
      env: { ...process.env, CB_DATA_DIR: dir, CB_EXPECTED_DAEMON_PID: String(process.pid), CB_STARTUP_TIMEOUT_MS: '150' }, timeout: 2000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('deadline expired') });
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it('does not start REST on a socket belonging to another daemon', async () => {
    const { methods, env } = await fixture({ pid: 999 });
    await expect(execute(process.execPath, [readyScript, 'start'], { env, timeout: 2000 })).rejects.toMatchObject({ code: 1 });
    expect(methods).not.toContain('rest.start');
  });

  it('health fails on a non-success REST response', async () => {
    const { env } = await fixture({ health: 503 });
    await expect(execute(process.execPath, [readyScript, 'health'], { env, timeout: 2000 })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('REST health check failed') });
  });

  it('fails immediately when the expected daemon exits before readiness', async () => {
    await expect(execute(process.execPath, [readyScript, 'start'], {
      env: { ...process.env, CB_DATA_DIR: dir, CB_EXPECTED_DAEMON_PID: '2147483647', CB_STARTUP_TIMEOUT_MS: '10000' }, timeout: 2000,
    })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('exited before readiness') });
  });

  async function fakeDocker(existing = true) {
    const bin = join(dir, 'bin');
    const workspace = join(dir, 'workspace with spaces');
    await mkdir(bin);
    await mkdir(join(workspace, 'subdir'), { recursive: true });
    const trace = join(dir, 'docker-args.jsonl');
    await writeFile(join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CB_DOCKER_TRACE, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') {
  if (args[2].includes('Labels')) {
    if (process.env.CB_FAKE_EXISTING !== '1') process.exit(1);
    const label = args[2];
    if (label.includes('workspace')) console.log(process.env.CB_DOCKER_WORKSPACE);
    else if (label.includes('state')) console.log(process.env.CB_FAKE_STATE || process.env.CB_DOCKER_DATA_DIR);
    else if (label.includes('image')) console.log(process.env.CB_DOCKER_IMAGE);
    else if (label.includes('user')) console.log(process.getuid() + ':' + process.getgid());
  } else console.log('true');
}
if (args[0] === 'exec' && args.includes('cb')) console.log(JSON.stringify(args));
`, { mode: 0o700 });
    return { workspace, trace, env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, CB_DOCKER_TRACE: trace,
      CB_DOCKER_WORKSPACE: workspace, CB_DOCKER_CONTAINER: 'disposable-fixture',
      CB_DOCKER_IMAGE: 'claude-b:local-fixture',
      CB_DOCKER_DATA_DIR: join(dir, 'state'), CB_FAKE_EXISTING: existing ? '1' : '0',
    } };
  }

  it('enters the caller repository subdirectory and preserves literal CLI arguments', async () => {
    const { workspace, env } = await fakeDocker();
    const { stdout } = await execute('bash', [launcher, '--model', 'sonnet', 'literal $HOME $(no shell)'], { env, cwd: join(workspace, 'subdir') });
    expect(JSON.parse(stdout)).toEqual(['exec', '-i', '--workdir', '/workspace/subdir', 'disposable-fixture', 'cb', '--model', 'sonnet', 'literal $HOME $(no shell)']);
  });

  it('creates one persistent container with explicit state and workspace bind mounts', async () => {
    const { workspace, trace, env } = await fakeDocker(false);
    await mkdir(env.CB_DOCKER_DATA_DIR);
    await writeFile(join(env.CB_DOCKER_DATA_DIR, '.env'), 'CB_DATA_DIR=/host/state\nCB_REST_PORT=9999\nCLAUDE_CONFIG_DIR=/host/claude\n');
    await execute('bash', [launcher, '--version'], { env, cwd: workspace });
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]);
    const run = calls.find(call => call[0] === 'run')!;
    expect(run).toContain('--detach');
    expect(run).not.toContain('--rm');
    expect(run).toContain(`type=bind,source=${workspace},target=/workspace`);
    expect(run).toContain(`type=bind,source=${env.CB_DOCKER_DATA_DIR},target=/home/node/.claude-b`);
    expect(run).toContain('--env-file');
    for (const value of ['CB_DATA_DIR=/home/node/.claude-b', 'CB_REST_HOST=0.0.0.0', 'CB_REST_PORT=3847', 'CLAUDE_CONFIG_DIR=/home/node/.claude-b/claude']) expect(run).toContain(value);
  });

  it('rejects reuse when recorded state ownership differs', async () => {
    const { workspace, env } = await fakeDocker();
    await expect(execute('bash', [launcher, '--version'], { env: { ...env, CB_FAKE_STATE: '/another-owner/state' }, cwd: workspace })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('metadata differs or is incomplete') });
  });

  it('installs a usable pinned Docker launcher into the selected user bin directory', async () => {
    const { env } = await fakeDocker();
    const binDir = join(dir, 'installed');
    await execute('bash', [installer, '--method=docker', '--skip-init'], { env: { ...env, CLAUDE_B_BIN_DIR: binDir } });
    const script = await readFile(join(binDir, 'cb'), 'utf8');
    expect(script).toContain('export CB_DOCKER_IMAGE=claude-b:local-fixture');
    expect(script).toContain('exec docker exec');
    await execute('bash', ['-n', join(binDir, 'cb')]);
  });
});
