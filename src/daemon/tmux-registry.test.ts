import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TmuxRegistry, type ForegroundIdentity, type TmuxRegistryOptions } from './tmux-registry.js';
import type { TmuxRunner } from '../tmux/targets.js';

function fixture(command = 'node', extra: Partial<TmuxRegistryOptions> = {}) {
  const pane = { id: '%7', shellPid: 100, command, alias: 'work:2.0', title: '✳ project' };
  let foreground: ForegroundIdentity = { pid: 200, startedAt: 'Sat Nov 7 00:00:00 2026' };
  let now = 0;
  const effects: string[][] = [];
  const line = () => `${pane.id}\t${pane.shellPid}\t0\t${pane.command}\t${pane.alias}\t${pane.title}`;
  const runSync = vi.fn((args: string[]) => {
    if (args[0] === 'display-message' && ![pane.id, pane.alias].includes(args[args.indexOf('-t') + 1])) throw new Error('Unknown pane');
    return line();
  });
  const runAsync: TmuxRunner = vi.fn(async (args) => {
    if (args[0] === 'display-message') return line().split('\t').slice(0, 4).join('\t');
    effects.push(args);
    return '';
  });
  const options: TmuxRegistryOptions = { runSync, runAsync, processIdentity: () => foreground, now: () => now, ttlMs: 100, settleMs: 0, ...extra };
  const registry = new TmuxRegistry(options);
  return { registry, options, pane, effects, runSync, runAsync, setForeground: (next: ForegroundIdentity) => { foreground = next; }, setNow: (next: number) => { now = next; } };
}

describe('registered tmux invocation identity', () => {
  it('discovers Claude under stable pane/foreground IDs and sends only to that recorded pane', async () => {
    const { registry, pane, effects } = fixture('claude');
    const [first] = registry.discover();
    expect(first).toMatchObject({ status: 'idle', agent: 'claude' });
    expect(first.id).toMatch(/^tmux:%7@200-[a-f0-9]{8}$/);
    pane.alias = 'renamed:5.1';
    expect(registry.discover()[0].id).toBe(first.id);
    await registry.send(first.id, 'literal\n$HOME');
    expect(effects.find((args) => args[0] === 'paste-buffer')).toContain('%7');
    expect(effects.find((args) => args[0] === 'send-keys')).toEqual(['send-keys', '-t', '%7', 'Enter']);
  });

  it('registers Codex/OpenCode wrappers but rejects shells, unknown wrappers and ambiguous aliases', () => {
    const { registry, pane, runSync } = fixture();
    const codex = registry.register('tmux:work:2.0', 'codex work', 'codex');
    expect(codex).toBeTruthy();
    expect(registry.aliveSessions()[0]).toMatchObject({ id: codex, agent: 'codex' });
    expect(registry.register('tmux:work:2.0', undefined, 'unknown-agent')).toBeUndefined();
    expect(registry.register('tmux:work:2.0', 'opencode work', 'opencode')).toBe(codex);
    pane.command = 'bash';
    expect(registry.register('tmux:work:2.0', undefined, 'codex')).toBeUndefined();
    pane.command = 'node';
    runSync.mockImplementation(() => '%7\t100\t0\tnode\tdifferent:2.0\ttitle');
    expect(registry.register('tmux:work:2.0', undefined, 'codex')).toBeUndefined();
    expect(registry.register('tmux:--malicious', undefined, 'codex')).toBeUndefined();
  });

  it('rejects a replacement agent with the same pane shell PID and current command', async () => {
    const { registry, setForeground, effects } = fixture();
    const id = registry.register('tmux:work:2.0', undefined, 'codex')!;
    setForeground({ pid: 300, startedAt: 'Sat Nov 7 00:01:00 2026' });
    await expect(registry.send(id, 'must not arrive')).rejects.toThrow('invocation changed');
    expect(effects.filter((args) => ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0]))).toHaveLength(0);
    const next = registry.register('tmux:work:2.0', undefined, 'codex');
    expect(next).not.toBe(id);
    await expect(registry.send(id, 'old selection')).rejects.toThrow('no longer registered');
  });

  it('binds IDs to process start identity even when a foreground PID is recycled', async () => {
    const { registry, setForeground } = fixture();
    const old = registry.register('tmux:work:2.0', undefined, 'codex')!;
    setForeground({ pid: 200, startedAt: 'Sat Nov 7 00:02:00 2026' });
    expect(registry.register(old, undefined, 'codex')).toBeUndefined();
    const current = registry.register('tmux:work:2.0', undefined, 'codex');
    expect(current).not.toBe(old);
    await expect(registry.send(old, 'old generation')).rejects.toThrow('no longer registered');
  });

  it('creates a distinct selection when a registered process changes its executable', async () => {
    const { registry, pane } = fixture();
    const old = registry.register('tmux:work:2.0', undefined, 'codex')!;
    pane.command = 'opencode';
    const current = registry.register('tmux:work:2.0', undefined, 'opencode');
    expect(current).not.toBe(old);
    await expect(registry.send(old, 'old command')).rejects.toThrow('no longer registered');
  });

  it('verifies foreground identity again after loading the buffer and before paste or Enter', async () => {
    const { registry, setForeground, runAsync, effects } = fixture();
    const id = registry.register('tmux:work:2.0', undefined, 'codex')!;
    const original = vi.mocked(runAsync).getMockImplementation()!;
    vi.mocked(runAsync).mockImplementation(async (args, input) => {
      const result = await original(args, input);
      if (args[0] === 'load-buffer') setForeground({ pid: 300, startedAt: 'changed' });
      return result;
    });
    await expect(registry.send(id, 'data')).rejects.toThrow('invocation changed');
    expect(effects.some((args) => args[0] === 'paste-buffer' || args[0] === 'send-keys')).toBe(false);
    expect(effects.at(-1)?.[0]).toBe('delete-buffer');
  });

  it('expires registrations and never routes unknown opaque IDs by resolving their current alias', async () => {
    const { registry, setNow } = fixture();
    const id = registry.register('tmux:work:2.0', undefined, 'codex')!;
    await expect(registry.send('tmux:work:2.0', 'unregistered alias')).rejects.toThrow('no longer registered');
    setNow(101);
    expect(registry.aliveSessions()).toEqual([]);
    await expect(registry.send(id, 'expired')).rejects.toThrow('no longer registered');
  });
});

describe('durable approved tmux registrations', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  async function statePath() {
    const dir = await mkdtemp(join(tmpdir(), 'cb-registry-state-')); dirs.push(dir);
    return join(dir, 'tmux-registry.json');
  }

  it('restores a still-live approved wrapper under the same canonical selection after restart', async () => {
    const stateFile = await statePath();
    const { registry, options, effects } = fixture('node', { stateFile });
    const id = registry.register('tmux:work:2.0', 'approved Codex', 'codex', 'work goal')!;
    await registry.flush();
    expect((await stat(stateFile)).mode & 0o777).toBe(0o600);
    const restored = new TmuxRegistry(options);
    await restored.restore();
    expect(restored.aliveSessions()).toEqual(registry.aliveSessions());
    await restored.send(id, 'reply after restart');
    await restored.flush();
    expect(effects.some(args => args[0] === 'paste-buffer')).toBe(true);
    const again = new TmuxRegistry(options); await again.restore();
    expect(again.aliveSessions()[0]).toMatchObject({ id, status: 'busy', name: 'approved Codex' });
  });

  it.each(['foreground PID', 'foreground start', 'shell PID', 'command'] as const)
  ('drops a saved registration when its %s changed without binding the old selection to the replacement', async kind => {
    const stateFile = await statePath();
    const { registry, options, pane, setForeground } = fixture('node', { stateFile });
    const old = registry.register('tmux:work:2.0', undefined, 'codex')!;
    await registry.flush();
    if (kind === 'foreground PID') setForeground({ pid: 300, startedAt: 'Sat Nov 7 00:00:00 2026' });
    if (kind === 'foreground start') setForeground({ pid: 200, startedAt: 'Sat Nov 7 00:01:00 2026' });
    if (kind === 'shell PID') pane.shellPid = 101;
    if (kind === 'command') pane.command = 'opencode';
    const restored = new TmuxRegistry(options); await restored.restore();
    expect(restored.aliveSessions()).toEqual([]);
    await expect(restored.send(old, 'must not arrive')).rejects.toThrow('no longer registered');
    expect(JSON.parse(await readFile(stateFile, 'utf8')).entries).toEqual([]);
  });

  it('preserves expired registrations as expired rather than extending their TTL during restart', async () => {
    const stateFile = await statePath();
    const { registry, options, setNow } = fixture('node', { stateFile });
    registry.register('tmux:work:2.0', undefined, 'opencode'); await registry.flush();
    setNow(101);
    const restored = new TmuxRegistry(options); await restored.restore();
    expect(restored.aliveSessions()).toEqual([]);
  });

  it('fails closed on corrupt JSON/schema and never overwrites the original bytes', async () => {
    const stateFile = await statePath();
    const { registry, options } = fixture('node', { stateFile });
    registry.register('tmux:work:2.0', undefined, 'codex'); await registry.flush();
    const valid = JSON.parse(await readFile(stateFile, 'utf8'));
    for (const bytes of ['{invalid original JSON', JSON.stringify({ version: 9, entries: [] }), JSON.stringify({ version: 1, entries: [{}] }), JSON.stringify({ ...valid, entries: [valid.entries[0], valid.entries[0]] })]) {
      await writeFile(stateFile, bytes);
      const restored = new TmuxRegistry(options);
      await expect(restored.restore()).rejects.toThrow('preserved');
      expect(restored.register('tmux:work:2.0', undefined, 'codex')).toBeUndefined();
      expect(restored.discover()).toEqual([]);
      await expect(restored.flush()).rejects.toThrow('preserved');
      expect(await readFile(stateFile, 'utf8')).toBe(bytes);
    }
  });
});
