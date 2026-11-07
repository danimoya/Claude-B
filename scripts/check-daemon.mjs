import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer as createNetServer, createConnection } from 'node:net';
import { createServer } from 'node:http';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const terminal = new Set(['completed', 'error', 'cancelled', 'interrupted']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const daemonEntry = fileURLToPath(new URL('../dist/daemon/index.js', import.meta.url));
const cliEntry = fileURLToPath(new URL('../bin/cb', import.meta.url));
const artifactRoot = fileURLToPath(new URL('../dist/', import.meta.url));

async function artifactHashes(directory = artifactRoot) {
  const hashes = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await artifactHashes(path));
    else if (entry.isFile()) hashes[`dist/${relative(artifactRoot, path).split('\\').join('/')}`] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return Object.fromEntries(Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)));
}

/** Real built daemon/CLI acceptance, using only owned temporary state and fake Claude. */
export async function checkDaemonArtifact() {
  const root = await mkdtemp(join(tmpdir(), 'cb-daemon-artifact-'));
  const state = join(root, 'state');
  const home = join(root, 'home');
  const workspace = join(root, 'repository');
  const otherWorkspace = join(root, 'other-repository');
  const trace = join(root, 'fake-claude.jsonl');
  for (const path of [state, home, workspace, otherWorkspace]) await mkdir(path, { mode: 0o700 });
  const fixture = join(root, 'claude-fixture');
  await writeFile(fixture, `#!${process.execPath}
+const fs=require('node:fs');
+if(process.argv.includes('--version')) { console.log('0.0.0 (artifact fixture)'); }
+else {
+ let prompt='';process.stdin.setEncoding('utf8');
+ process.stdin.on('data', chunk=>prompt+=chunk);
+ process.stdin.on('end',()=>{
+  fs.appendFileSync(process.env.CB_FIXTURE_TRACE,JSON.stringify({pid:process.pid,prompt,cwd:process.cwd(),args:process.argv.slice(2)})+'\\n',{mode:0o600});
+  if(prompt.startsWith('slow:')) { console.log('partial:'+prompt);setInterval(()=>{},1000); }
+  else console.log(JSON.stringify({result:JSON.stringify({prompt,cwd:process.cwd(),args:process.argv.slice(2)}),session_id:'00000000-0000-0000-0000-000000000001',duration_ms:1,total_cost_usd:0,num_turns:1,is_error:false}));
+ });
+}
+`.replace(/^\+/gm, ''), { mode: 0o700 });
  // Construct a minimal environment: provider/bot credentials and host startup
  // hooks are never inherited by a candidate or its fake child.
  const env = {
    PATH: process.env.PATH || '', HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
    LANG: 'C.UTF-8', TZ: 'UTC', CB_DATA_DIR: state, CLAUDE_PATH: fixture,
    CLAUDE_CONFIG_DIR: join(home, '.claude'), CB_FIXTURE_TRACE: trace,
    CB_REST_HOST: '127.0.0.1',
  };
  let daemon;
  const ownedChildren = new Set();
  let receiver;
  let rejectWebhook = true;
  const webhookBodies = [];
  const webhookSockets = new Set();

  async function traceEntries() {
    try { return (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  function fixtureStillRunning(entry) {
    if (!Number.isSafeInteger(entry?.pid) || entry.pid <= 0 || !entry.prompt.startsWith('slow:')) return false;
    try {
      const current = execFileSync('ps', ['-p', String(entry.pid), '-o', 'command='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return current.includes(fixture);
    } catch { return false; }
  }
  async function cleanupFixtureChildren() {
    for (const entry of await traceEntries()) {
      if (!fixtureStillRunning(entry)) continue;
      // Restrict every signal to a trace-verified private fixture group. Keep
      // this failure cleanup even when recovery itself is expected to reap it.
      try { process.kill(process.platform === 'win32' ? entry.pid : -entry.pid, 'SIGKILL'); }
      catch { /* the owned fixture process/group already exited */ }
    }
  }
  async function ipc(method, params) {
    return new Promise((resolve, reject) => {
      const socket = createConnection(join(state, 'daemon.sock'));
      let buffer = '';
      const finish = (error, data) => {
        clearTimeout(timer);socket.destroy();
        if (error) reject(error); else resolve(data);
      };
      const timer = setTimeout(() => finish(new Error(`Candidate IPC timed out: ${method}`)), 2500);
      socket.once('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
      socket.once('error', error => finish(error));
      socket.once('end', () => finish(new Error(`Candidate IPC ended: ${method}`)));
      socket.on('data', chunk => {
        buffer += chunk.toString();
        if (buffer.length > 4 * 1024 * 1024) return finish(new Error('Candidate IPC response is too large'));
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (response.error) finish(new Error(`Candidate IPC rejected ${method}: ${response.error}`));
          else finish(undefined, response.data);
        } catch (error) { finish(error); }
      });
    });
  }
  async function waitFor(check, label, timeout = 8000) {
    const deadline = Date.now() + timeout;
    let failure;
    while (Date.now() < deadline) {
      try { const result = await check(); if (result) return result; }
      catch (error) { failure = error; }
      await delay(30);
    }
    throw new Error(`Candidate acceptance timed out: ${label}${failure ? ` (${failure.message})` : ''}`);
  }
  async function start() {
    daemon = spawn(process.execPath, [daemonEntry], { env, cwd: otherWorkspace, stdio: ['ignore', 'pipe', 'pipe'] });
    ownedChildren.add(daemon);
    // Keep logs private and bounded; assertion output never dumps credentials.
    let logs = '';
    const capture = chunk => { logs = (logs + chunk.toString()).slice(-64000); };
    daemon.stdout.on('data', capture);daemon.stderr.on('data', capture);
    daemon.once('error', () => {});
    await waitFor(async () => {
      if (daemon.exitCode !== null || daemon.signalCode) throw new Error('Candidate daemon exited');
      const status = await ipc('daemon.status');
      return status?.pid === daemon.pid;
    }, 'owned IPC daemon startup');
    return () => writeFile(join(root, 'candidate-private.log'), logs, { mode: 0o600 });
  }
  async function stop(signal = 'SIGTERM') {
    if (!daemon || daemon.exitCode !== null || daemon.signalCode) return;
    const child = daemon;
    const ended = new Promise(resolve => child.once('close', (code, received) => resolve({ code, received })));
    child.kill(signal);
    let timer;
    const result = await Promise.race([ended, new Promise((_, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Candidate daemon did not stop')); }, 8000);
    })]).finally(() => clearTimeout(timer));
    if (signal === 'SIGTERM') assert.equal(result.code, 0, 'Candidate graceful shutdown failed');
    ownedChildren.delete(child);
  }
  async function task(id) { return (await ipc('task.get', { taskId: id })).task; }
  async function completed(id) {
    const receipt = await waitFor(async () => { const current = await task(id); return current && terminal.has(current.status) ? current : null; }, `terminal receipt ${id}`);
    assert.equal(receipt.status, 'completed', 'Candidate task did not complete');
    return receipt;
  }
  async function cli(args, promptInput) {
    const child = spawn(process.execPath, [cliEntry, ...args], { env, cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    ownedChildren.add(child);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });child.stderr.on('data', chunk => { output += chunk; });
    child.stdin.end(promptInput);
    let timer;
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Built CLI failed to terminate')); }, 8000);
      child.once('error', reject);child.once('close', resolve);
    }).finally(() => clearTimeout(timer));
    ownedChildren.delete(child);
    assert.equal(code, 0, 'Built CLI returned an error');
    return output;
  }
  async function readOutbox(id) {
    let files;
    try { files = await readdir(join(state, 'outbox')); } catch { return null; }
    for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      const record = JSON.parse(await readFile(join(state, 'outbox', file), 'utf8'));
      if (record.notification.promptId === id) return record;
    }
    return null;
  }
  async function freePort() {
    const probe = createNetServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
  }

  try {
    await start();
    const created = await ipc('session.create', { name: 'artifact', workingDir: workspace, executionPolicy: 'default' });
    const literal = '  --help stays literal\n"quoted" $(literal) été ✓\n';
    const sent = await ipc('prompt.send', { sessionId: created.sessionId, workingDir: workspace, prompt: literal });
    const firstId = sent.taskId || sent.promptId;
    const first = await completed(firstId);
    const rendered = JSON.parse(first.output);
    assert.equal(rendered.prompt, literal);assert.equal(rendered.cwd, workspace);
    assert.equal(first.executionPolicy, 'default');assert(!rendered.args.includes('--dangerously-skip-permissions'));
    assert((await ipc('task.list')).tasks.some(receipt => receipt.id === firstId));
    await ipc('session.policy', { sessionId: created.sessionId, executionPolicy: 'bypass' });
    const optedIn = await ipc('prompt.send', { sessionId: created.sessionId, workingDir: workspace, executionPolicy: 'bypass', prompt: 'explicit fixture bypass' });
    const bypass = await completed(optedIn.taskId || optedIn.promptId);
    assert.equal(bypass.executionPolicy, 'bypass');
    assert(JSON.parse(bypass.output).args.includes('--dangerously-skip-permissions'));
    await ipc('session.policy', { sessionId: created.sessionId, executionPolicy: 'default' });

    const slow = await ipc('prompt.send', { sessionId: created.sessionId, workingDir: workspace, prompt: `slow:cancel:${randomUUID()}` });
    const slowId = slow.taskId || slow.promptId;
    await waitFor(async () => (await task(slowId))?.status === 'running', 'running cancellation task');
    const cancelled = (await ipc('task.cancel', { taskId: slowId })).task;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await task(slowId)).status, 'cancelled');

    const restPort = await freePort();
    await ipc('rest.start', { port: restPort, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${restPort}`;
    const apiKey = (await readFile(join(state, 'api.key'), 'utf8')).trim();
    const auth = await fetch(`${base}/api/auth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: apiKey }), signal: AbortSignal.timeout(2500) });
    assert.equal(auth.status, 200);
    const { access_token: token } = await auth.json();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const restPrompt = 'REST accepted task';
    const response = await fetch(`${base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ prompt: restPrompt, workingDir: workspace, executionPolicy: 'default', idempotencyKey: `artifact-${randomUUID()}` }), signal: AbortSignal.timeout(2500) });
    assert.equal(response.status, 202, 'REST must distinguish acceptance from completion');
    const accepted = await response.json();
    assert.equal(accepted.status, 'accepted');assert(accepted.taskId && accepted.sessionId);
    const receipt = await completed(accepted.taskId);
    assert.equal(JSON.parse(receipt.output).prompt, restPrompt);
    const status = await fetch(`${base}/api/tasks/${accepted.taskId}`, { headers, signal: AbortSignal.timeout(2500) });
    assert.equal(status.status, 200);assert.equal((await status.json()).task.status, 'completed');

    receiver = createServer((request, response) => {
      let body = '';request.on('data', chunk => { body += chunk; });
      request.on('end', () => { webhookBodies.push(JSON.parse(body));response.writeHead(rejectWebhook ? 503 : 204);response.end(); });
    });
    receiver.on('connection', socket => { webhookSockets.add(socket);socket.on('close', () => webhookSockets.delete(socket)); });
    await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = receiver.address().port;
    const register = await fetch(`${base}/api/hooks/webhook`, { method: 'POST', headers,
      body: JSON.stringify({ event: 'prompt.completed', url: `http://127.0.0.1:${receiverPort}/record`, retries: 1, timeout: 500 }), signal: AbortSignal.timeout(2500) });
    assert.equal(register.status, 200);
    const delivery = await ipc('prompt.send', { sessionId: created.sessionId, workingDir: workspace, prompt: 'outbox retry fixture' });
    const deliveryId = delivery.taskId || delivery.promptId;
    await completed(deliveryId);
    await waitFor(() => webhookBodies.length > 0, 'first webhook attempt');
    const before = await waitFor(async () => {
      const record = await readOutbox(deliveryId);
      return record && record.attempts > 0 && !record.delivered.includes('hooks') ? record : null;
    }, 'durable failed webhook receipt');
    await stop();
    rejectWebhook = false;
    await start();
    const after = await waitFor(async () => {
      const record = await readOutbox(deliveryId);
      return record?.delivered.includes('hooks') ? record : null;
    }, 'outbox restart replay', 10000);
    assert.equal(after.eventId, before.eventId);assert.equal(after.timestamp, before.timestamp);
    assert(webhookBodies.length >= 2);assert.equal(webhookBodies[0].id, webhookBodies.at(-1).id);
    assert.equal((await task(firstId)).output, first.output);

    const interrupted = await ipc('prompt.send', { sessionId: created.sessionId, workingDir: workspace, prompt: `slow:interrupted:${randomUUID()}` });
    const interruptedId = interrupted.taskId || interrupted.promptId;
    await waitFor(async () => (await task(interruptedId))?.rawOutput.includes('partial:'), 'persisted running output');
    const interruptedTrace = (await traceEntries()).findLast(entry => entry.prompt.startsWith('slow:interrupted:'));
    assert(interruptedTrace && fixtureStillRunning(interruptedTrace), 'Interrupted fixture executor was not alive before daemon crash');
    await stop('SIGKILL');
    const executions = (await traceEntries()).length;
    await start();
    await waitFor(() => !fixtureStillRunning(interruptedTrace), 'recovery termination of the owned orphan executor');
    const recovered = await task(interruptedId);
    assert.equal(recovered.status, 'interrupted');assert(recovered.error);assert(recovered.rawOutput.includes('partial:'));
    await delay(150);assert.equal((await traceEntries()).length, executions, 'Restart replayed a prompt');
    // Normal CLI submission must finish even if completion beats subscription.
    const output = await cli(['--model', 'fixture-model'], 'normal CLI literal $(still literal)\n');
    assert(output.includes('normal CLI literal'), 'Built CLI omitted its exact task result');

    await stop();
    // Rehearse state rollback only while the disposable candidate is stopped.
    // The backup contains fixture-generated credentials and is deleted below.
    const backup = join(root, 'rollback-backup');
    await cp(state, backup, { recursive: true, errorOnExist: true, force: false });
    const receiptPath = join(state, 'tasks', `${firstId}.json`);
    const altered = JSON.parse(await readFile(receiptPath, 'utf8'));
    altered.output = 'deliberate isolated rollback rehearsal mutation';
    await writeFile(receiptPath, JSON.stringify(altered), { mode: 0o600 });
    assert.notEqual(JSON.parse(await readFile(receiptPath, 'utf8')).output, first.output);
    await rm(state, { recursive: true });
    await cp(backup, state, { recursive: true, errorOnExist: true, force: false });
    const rollbackExecutions = (await traceEntries()).length;
    await start();
    assert.equal((await task(firstId)).output, first.output, 'Restored receipt differed from the stopped-state backup');
    assert.equal((await readOutbox(deliveryId)).eventId, after.eventId, 'Rollback lost durable delivery identity');
    await delay(150);assert.equal((await traceEntries()).length, rollbackExecutions, 'Rollback replayed fixture work');
    await stop();
    const proof = {
      kind: 'claude-b-isolated-acceptance', version: 1, timestamp: new Date().toISOString(),
      node: process.versions.node, platform: process.platform, arch: process.arch,
      artifacts: await artifactHashes(),
      outcomes: {
        ipcTasks: 'passed', restAcceptanceAndResults: 'passed', callerDirectory: 'passed',
        defaultAndExplicitPolicy: 'passed', cancellation: 'passed', exactCliResultAndExit: 'passed',
        durableOutboxRestart: 'passed', interruptedRecovery: 'passed', ownedOrphanTermination: 'passed',
        noExecutionReplay: 'passed', isolatedStateRollback: 'passed',
      },
      liveServicesChanged: false, liveConfigurationChanged: false, externalProvidersUsed: false, publicationPerformed: false,
    };
    const bytes = JSON.stringify(proof, null, 2) + '\n';
    if (process.env.CB_ACCEPTANCE_PROOF) await writeFile(resolve(process.env.CB_ACCEPTANCE_PROOF), bytes, { mode: 0o600 });
    console.log('Built daemon acceptance passed: IPC/REST/CLI tasks, cancellation, restart recovery, durable outbox and isolated rollback');
    console.log(bytes.trim());
    return proof;
  } finally {
    for (const child of ownedChildren) { try { child.kill('SIGKILL'); } catch {} }
    await cleanupFixtureChildren();
    for (const socket of webhookSockets) socket.destroy();
    if (receiver) await new Promise(resolve => receiver.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await checkDaemonArtifact();
