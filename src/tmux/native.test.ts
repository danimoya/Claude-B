import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pasteToTmuxPane, resolveTmuxPane, runTmux, type TmuxRunner } from './targets.js';

const native = process.env.CB_NATIVE_TMUX === '1' ? describe : describe.skip;
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

native('native tmux paste in a private server namespace', () => {
  let dir: string;
  let runner: TmuxRunner;
  let command: string;

  beforeEach(async () => {
    // Required mode fails when tmux is absent; local ordinary tests skip it.
    execFileSync('tmux', ['-V'], { stdio: 'pipe' });
    dir = await mkdtemp(join(tmpdir(), 'cb-native-tmux-'));
    const namespace = `cb-test-${randomUUID().slice(0, 12)}`;
    runner = (args, input) => runTmux(['-L', namespace, '-f', '/dev/null', ...args], input);
    const fixture = join(dir, 'terminal.cjs');
    await writeFile(fixture, `const fs = require('node:fs');
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\\x1b[?2004h');
fs.writeFileSync(process.argv[2]+'.ready', String(process.pid), {mode:0o600});
let input='';
process.stdin.on('data', chunk => {
 input+=chunk.toString();
 if(input.endsWith('\\r')) fs.writeFileSync(process.argv[2], JSON.stringify(input.replace(/\\x1b\\[20[01]~/g,'')), {mode:0o600});
});
`);
    command = `${quote(process.execPath)} ${quote(fixture)}`;
  });
  afterEach(async () => {
    if (runner) await runner(['kill-server']).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function waitFile(path: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      try { return await readFile(path, 'utf8'); } catch { /* child not ready */ }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Private tmux fixture did not become ready');
  }

  it('preserves multiline literal text and sends only to the selected pane', async () => {
    const target = join(dir, 'target.json');
    const other = join(dir, 'other.json');
    await runner(['new-session', '-d', '-s', 'fixture', '-x', '80', '-y', '24', `${command} ${quote(target)}`]);
    const pane = await resolveTmuxPane('fixture:0.0', runner);
    await runner(['split-window', '-d', '-t', pane.paneId, `${command} ${quote(other)}`]);
    await waitFile(`${target}.ready`);
    await waitFile(`${other}.ready`);
    const current = await resolveTmuxPane(pane.paneId, runner);
    const prompt = 'line one\n--literal $HOME $(not a shell) λ';
    await pasteToTmuxPane(current, prompt, runner, 10);
    expect(JSON.parse(await waitFile(target))).toBe(`${prompt}\r`);
    await expect(readFile(other, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a recycled pane before typing when its process identity changed', async () => {
    const first = join(dir, 'first.json');
    const replacement = join(dir, 'replacement.json');
    await runner(['new-session', '-d', '-s', 'fixture', `${command} ${quote(first)}`]);
    await waitFile(`${first}.ready`);
    const expected = await resolveTmuxPane('fixture:0.0', runner);
    await runner(['respawn-pane', '-k', '-t', expected.paneId, `${command} ${quote(replacement)}`]);
    await waitFile(`${replacement}.ready`);
    await expect(pasteToTmuxPane(expected, 'must not arrive', runner, 0)).rejects.toThrow('identity changed');
    await expect(readFile(replacement, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
