import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Exercise the built CLI against disposable IPC fixtures, never a daemon. */
export async function checkStdinArtifact() {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), 'cb-stdin-artifact-')));
  const workingDir = await realpath(process.cwd());
  const requests = [];
  const sockets = new Set();
  const failing = new WeakSet();
  const pending = new WeakSet();
  const server = createServer(socket => {
    socket.setEncoding('utf8');
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
        if (request.method === 'prompt.send' && request.params?.prompt === 'pending fixture') pending.add(socket);
        if (request.method === 'prompt.send' && request.params?.prompt === 'lost response fixture') { socket.destroy(); continue; }
        if (request.method === 'prompt.fire' && request.params?.prompt === 'stalled fire fixture') continue;
        if (request.method === 'prompt.send' || request.method === 'prompt.fire') {
          data = { promptId: 'fixture-prompt', sessionId: 'fixture-session', goal: 'fixture-goal' };
        } else if (request.method === 'orchestration.prompt') {
          if (request.params.prompt === 'lost remote response') { socket.destroy(); continue; }
          data = { host: 'fixture-host', status: 'accepted', taskId: 'fixture-remote-task', receiptId: 'fixture-remote-receipt' };
        } else if (request.method === 'orchestration.fire') {
          data = { host: 'fixture-host', status: 'accepted', taskId: 'fixture-remote-task', receiptId: 'fixture-remote-receipt' };
        } else if (request.method === 'orchestration.task.resume') {
          data = request.params.receiptId === 'fixture-pending-remote-receipt'
            ? { host: 'fixture-host', status: 'accepted', taskId: 'fixture-remote-task', receiptId: request.params.receiptId }
            : { host: 'fixture-host', status: 'completed', taskId: 'fixture-remote-task', receiptId: 'fixture-remote-receipt', output: 'fixture-remote-output' };
        } else if (request.method === 'notification.count') {
          data = { unread: 0, total: 0 };
        }
        if (request.method === 'task.get') data = { task: { id: request.params.taskId, sessionId: 'fixture-session', status: failing.has(socket) ? 'error' : pending.has(socket) ? 'running' : 'completed', output: 'fixture-output', ...(failing.has(socket) ? { error: 'fixture provider failure' } : {}) } };
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
      env, cwd: workingDir, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { output += data; stdout += data; });
    child.stderr.on('data', data => { output += data; stderr += data; });
    // Administrative commands must exit with stdin still open and unread.
    if (!leaveInputOpen) child.stdin.end(input);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    assert.equal(code, expectedCode, `CLI failed or waited for stdin: ${args.join(' ')}\n${output}`);
    return { output, stdout, stderr, requests: requests.slice(first) };
  }

  try {
    function executionParams(request) {
      const { taskId, idempotencyKey, ...params } = request?.params || {};
      assert(/^[a-f0-9-]{36}$/.test(taskId), 'CLI must choose a recoverable task ID before submission');
      assert.equal(idempotencyKey, `cli:${taskId}`);
      return params;
    }
    const prompt = '  --help is literal input\n"quoted" $(literal) été ✓\n\n';
    let result = await run(['--model', 'fixture-model'], prompt);
    assert.deepEqual(executionParams(result.requests.find(r => r.method === 'prompt.send')),
      { prompt, model: 'fixture-model', workingDir });

    result = await run(['-x', 'target-session', '-m', 'fixture-model'], prompt);
    assert.equal(result.requests[0]?.method, 'session.select');
    assert.deepEqual(result.requests[0]?.params, { sessionId: 'target-session' });
    assert.deepEqual(executionParams(result.requests[1]), { prompt, model: 'fixture-model', workingDir, sessionId: 'target-session' });

    result = await run(['--json', '-x', 'target-session'], prompt);
    assert.equal(JSON.parse(result.stdout).output, 'fixture-output', 'JSON stdout must contain only the task receipt');

    result = await run(['-x', 'target-session']);
    assert.deepEqual(result.requests.map(r => r.method), ['session.select']);

    result = await run(['-f', '-m', 'fixture-model', '--goal', 'fixture-goal'], prompt);
    assert.deepEqual(executionParams(result.requests.find(r => r.method === 'prompt.fire')),
      { prompt, model: 'fixture-model', goal: 'fixture-goal', workingDir });

    result = await run(['--remote', 'fixture-host'], prompt);
    assert.deepEqual(executionParams(result.requests.find(r => r.method === 'orchestration.prompt')),
      { hostId: 'fixture-host', prompt, timeout: 10000, waitForCompletion: false });
    assert.equal(result.requests.filter(r => r.method === 'orchestration.prompt').length, 1);
    assert.equal(result.requests.filter(r => r.method === 'orchestration.task.resume').length, 1);
    assert(result.output.includes('fixture-remote-output'));

    result = await run(['--remote-fire', 'fixture-host', '--goal', 'fixture-goal'], prompt);
    assert.deepEqual(executionParams(result.requests.find(r => r.method === 'orchestration.fire')),
      { hostId: 'fixture-host', prompt, timeout: 10000, waitForCompletion: false, goal: 'fixture-goal' });
    assert(result.output.includes('cb --remote-task fixture-remote-receipt'));

    result = await run(['--remote-fire', 'fixture-host', '--json'], prompt);
    assert.equal(JSON.parse(result.stdout).status, 'accepted');

    result = await run(['--remote-task', 'fixture-pending-remote-receipt', '--timeout', '80', '--json'], '', true, 2);
    assert.equal(JSON.parse(result.stdout).status, 'accepted');

    result = await run(['--remote', 'fixture-host'], 'lost remote response', false, 1);
    assert.equal(result.requests.filter(r => r.method === 'orchestration.prompt').length, 1);
    assert(result.output.includes('cb --remote-tasks'));

    result = await run(['--remote-task', 'fixture-remote-receipt'], '', true);
    assert.deepEqual(result.requests.map(r => r.method), ['orchestration.task.resume']);

    result = await run(['-f', 'positional prompt'], 'ignored stdin');
    assert.equal(result.requests.find(r => r.method === 'prompt.fire')?.params.prompt, 'positional prompt');

    result = await run(['-f', '--timeout', '0'], 'invalid timeout', false, 1);
    assert.equal(result.requests.length, 0, 'Invalid fire timeout must fail before submission');
    result = await run(['-f', '--timeout', '50'], 'stalled fire fixture', false, 1);
    assert.equal(result.requests.filter(r => r.method === 'prompt.fire').length, 1);
    assert(result.output.includes('cb --task '), 'Timed-out background acknowledgement must retain its identity');

    result = await run(['--json', '--timeout', '80'], 'pending fixture', false, 2);
    assert.equal(JSON.parse(result.stdout).status, 'running', 'Deadline JSON must retain the latest task receipt');
    assert.equal(result.requests.filter(r => r.method === 'prompt.send').length, 1);
    assert(!result.requests.some(r => r.method === 'task.cancel'), 'A wait deadline must not cancel execution');

    result = await run(['--model', 'fixture-model'], 'lost response fixture', false, 1);
    assert.equal(result.requests.filter(r => r.method === 'prompt.send').length, 1, 'Lost acknowledgement must not resubmit work');
    assert(result.output.includes('cb --task '), 'Uncertain submission must retain a recoverable task ID');

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
