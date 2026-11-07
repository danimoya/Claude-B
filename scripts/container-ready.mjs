import { createConnection } from 'node:net';
import { join } from 'node:path';

const mode = process.argv[2] || 'health';
const dataDir = process.env.CB_DATA_DIR || '/home/node/.claude-b';
const port = Number(process.env.CB_REST_PORT || 3847);
const budget = Number(process.env.CB_STARTUP_TIMEOUT_MS || 15_000);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(budget) || budget < 100 || budget > 120_000) {
  throw new Error('Invalid container port or readiness timeout');
}
const deadline = Date.now() + (mode === 'start' ? budget : 1500);
const remaining = () => Math.max(1, Math.min(1000, deadline - Date.now()));

function ipc(method, params) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(join(dataDir, 'daemon.sock'));
    let buffer = '';
    const timer = setTimeout(() => finish(new Error('IPC readiness request timed out')), remaining());
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.error) finish(new Error(response.error)); else finish(undefined, response.data);
      } catch (error) { finish(error); }
    });
    socket.once('error', finish);
    socket.once('end', () => finish(new Error('IPC readiness connection ended')));
  });
}

async function health() {
  const status = await ipc('daemon.status');
  if (!status?.pid) throw new Error('IPC status is missing the daemon PID');
  if (process.env.CB_EXPECTED_DAEMON_PID && String(status.pid) !== process.env.CB_EXPECTED_DAEMON_PID) {
    throw new Error('IPC socket belongs to a different daemon');
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(remaining()) });
  if (!response.ok || (await response.json()).status !== 'ok') throw new Error('REST health check failed');
}

try {
  if (mode === 'start') {
    let lastError;
    while (Date.now() < deadline) {
      if (process.env.CB_EXPECTED_DAEMON_PID) {
        try { process.kill(Number(process.env.CB_EXPECTED_DAEMON_PID), 0); }
        catch (error) {
          if (error.code === 'ESRCH') throw new Error('Daemon exited before readiness');
          throw error;
        }
      }
      try {
        const status = await ipc('daemon.status');
        if (!status?.pid || String(status.pid) !== process.env.CB_EXPECTED_DAEMON_PID) throw new Error('IPC daemon identity mismatch');
        try { await ipc('rest.start', { port, host: process.env.CB_REST_HOST || '0.0.0.0' }); }
        catch (error) { if (!error.message.includes('already running')) throw error; }
        await health();
        console.log('Claude-B IPC and REST are ready');
        process.exit(0);
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
    }
    throw new Error(`Claude-B readiness deadline expired: ${lastError?.message || 'not ready'}`);
  }
  if (mode !== 'health') throw new Error('Expected start or health mode');
  await health();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
