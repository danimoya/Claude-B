import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TmuxRegistry } from './tmux-registry.js';
import { runTmux, type TmuxRunner } from '../tmux/targets.js';

const native = process.env.CB_NATIVE_TMUX === '1' ? describe : describe.skip;
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

native('tmux registry foreground identity in a private server', () => {
  let dir: string;
  let prefix: string[];
  let runner: TmuxRunner;
  let registry: TmuxRegistry;
  let fixture: string;
  beforeEach(async () => {
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    dir = await mkdtemp(join(tmpdir(), 'cb-registry-native-'));
    prefix = ['-L', `cb-registry-${randomUUID().slice(0, 12)}`, '-f', '/dev/null'];
    runner = (args, input) => runTmux([...prefix, ...args], input);
    registry = new TmuxRegistry({ runSync: args => execFileSync('tmux', [...prefix, ...args], { encoding: 'utf8', timeout: 2000 }), runAsync: runner, settleMs: 0 });
    fixture = join(dir, 'agent.cjs');
    await writeFile(fixture, `const fs = require('node:fs');
process.stdin.setRawMode(true); process.stdin.resume(); process.stdout.write('\\x1b[?2004h');
fs.writeFileSync(process.argv[2]+'.ready', String(process.pid));
let text=''; process.stdin.on('data', chunk=>{ text+=chunk.toString(); if(text.endsWith('\\r'))fs.writeFileSync(process.argv[2],JSON.stringify(text.replace(/\\x1b\\[20[01]~/g,''))); });
`);
    await runner(['new-session', '-d', '-s', 'fixture', 'bash --noprofile --norc -i']);
  });
  afterEach(async () => {
    if (runner) await runner(['kill-server']).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  async function waitFor<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { return await operation(); } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    throw new Error('Private tmux agent fixture did not become ready');
  }
  async function launch(path: string) {
    await runner(['send-keys', '-l', '-t', 'fixture:0.0', `${quote(process.execPath)} ${quote(fixture)} ${quote(path)}`]);
    await runner(['send-keys', '-t', 'fixture:0.0', 'Enter']);
    return Number(await waitFor(() => readFile(`${path}.ready`, 'utf8')));
  }
  it('rejects a fresh node agent in the same shell/pane while permitting explicit fresh registration', async () => {
    const first = join(dir, 'first.json');
    const next = join(dir, 'next.json');
    const firstPid = await launch(first);
    const before = await runner(['display-message', '-p', '-t', 'fixture:0.0', '#{pane_id}\t#{pane_pid}\t#{pane_current_command}']);
    const oldId = registry.register('tmux:fixture:0.0', 'first agent', 'codex');
    expect(oldId).toBeTruthy();
    process.kill(firstPid, 'SIGTERM');
    await waitFor(async () => { const command = (await runner(['display-message', '-p', '-t', 'fixture:0.0', '#{pane_current_command}'])).trim(); if (command !== 'bash') throw new Error('old agent is running'); return command; });
    await launch(next);
    expect(await runner(['display-message', '-p', '-t', 'fixture:0.0', '#{pane_id}\t#{pane_pid}\t#{pane_current_command}'])).toBe(before);
    await expect(registry.send(oldId!, 'must not arrive')).rejects.toThrow('invocation changed');
    await expect(readFile(next, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const current = registry.register('tmux:fixture:0.0', 'next agent', 'codex');
    expect(current).toBeTruthy(); expect(current).not.toBe(oldId);
    await registry.send(current!, 'literal\n$HOME');
    expect(JSON.parse(await waitFor(() => readFile(next, 'utf8')))).toBe('literal\n$HOME\r');
  });
});
