import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Exercise the built CLI against disposable IPC fixtures, never a daemon. */
export async function checkStdinArtifact() {
  const stateDir = await mkdtemp(join(tmpdir(), 'cb-stdin-artifact-'));
  const requests = [];
  const sockets = new Set();
  const failing = new WeakSet();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        requests.push(request);
        let data = {};
        if (request.method === 'prompt.send' && request.params?.prompt === 'failure fixture') failing.add(socket);
        if (request.method === 'prompt.send' || request.method === 'prompt.fire') {
          data = { promptId: 'fixture-prompt', sessionId: 'fixture-session', goal: 'fixture-goal' };
        } else if (request.method === 'orchestration.prompt') {
          data = { ...data, host: 'fixture-host', status: 'completed', latency: 0, output: 'fixture-output' };
        } else if (request.method === 'orchestration.fire') {
          data = { trackingId: 'fixture-tracking', goal: 'fixture-goal' };
        } else if (request.method === 'notification.count') {
          data = { unread: 0, total: 0 };
        }
        socket.write(JSON.stringify({ id: request.id, data }) + '\n');
        if (request.method === 'session.watch') setTimeout(() => {
          if (failing.has(socket)) socket.write(JSON.stringify({ type: 'status', data: {
            status: 'error', promptId: 'fixture-prompt', error: 'fixture provider failure'
          } }) + '\n');
          else socket.end();
        }, 20);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(join(stateDir, 'daemon.sock'), resolve);
  });

  async function run(args, input = '', leaveInputOpen = false, expectedCode = 0) {
    const first = requests.length;
    const env = { ...process.env, HOME: stateDir, CB_DATA_DIR: stateDir, CLAUDE_PATH: process.execPath };
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPEECHMATICS_API_KEY',
      'DEEPGRAM_API_KEY', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_ALLOWED_CHAT_IDS', 'CB_REST_API_KEY']) delete env[key];
    const child = spawn(process.execPath, ['bin/cb', ...args], {
      env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    // Administrative commands must exit with stdin still open and unread.
    if (!leaveInputOpen) child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, expectedCode, `CLI failed or waited for stdin: ${args.join(' ')}\n${output}`);
    return { output, requests: requests.slice(first) };
  }

  try {
    const prompt = '  --help is literal input\n"quoted" $(literal) été ✓\n\n';
    let result = await run(['--model', 'fixture-model'], prompt);
    assert.deepEqual(result.requests.find(r => r.method === 'prompt.send')?.params,
      { prompt, model: 'fixture-model', workingDir: process.cwd() });

    result = await run(['-x', 'target-session', '-m', 'fixture-model'], prompt);
    assert.equal(result.requests[0]?.method, 'session.select');
    assert.deepEqual(result.requests[0]?.params, { sessionId: 'target-session' });
    assert.deepEqual(result.requests[1]?.params, { prompt, model: 'fixture-model', workingDir: process.cwd(), sessionId: 'target-session' });

    result = await run(['-x', 'target-session']);
    assert.deepEqual(result.requests.map(r => r.method), ['session.select']);

    result = await run(['-f', '-m', 'fixture-model', '--goal', 'fixture-goal'], prompt);
    assert.deepEqual(result.requests.find(r => r.method === 'prompt.fire')?.params,
      { prompt, model: 'fixture-model', goal: 'fixture-goal', workingDir: process.cwd() });

    result = await run(['--remote', 'fixture-host'], prompt);
    assert.deepEqual(result.requests.find(r => r.method === 'orchestration.prompt')?.params,
      { hostId: 'fixture-host', prompt });

    result = await run(['--remote-fire', 'fixture-host', '--goal', 'fixture-goal'], prompt);
    assert.deepEqual(result.requests.find(r => r.method === 'orchestration.fire')?.params,
      { hostId: 'fixture-host', prompt, goal: 'fixture-goal' });

    result = await run(['-f', 'positional prompt'], 'ignored stdin');
    assert.equal(result.requests.find(r => r.method === 'prompt.fire')?.params.prompt, 'positional prompt');

    result = await run(['--model', 'fixture-model'], 'failure fixture', false, 1);
    assert(result.output.includes('fixture provider failure'), 'Failed prompt explanation missing');

    await writeFile(join(stateDir, 'daemon.log'), 'fixture log\n');
    for (const args of [['--logs'], ['--help'], ['--version']]) {
      result = await run(args, '', true);
      assert.equal(result.requests.length, 0, `Administrative option contacted IPC: ${args}`);
    }
    result = await run(['--inbox-count'], '', true);
    assert.deepEqual(result.requests.map(r => r.method), ['notification.count']);
    result = await run(['--watch'], '', true);
    assert.deepEqual(result.requests.map(r => r.method), ['session.watch']);
    console.log('Built CLI stdin/flags checks passed against disposable IPC');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
}
