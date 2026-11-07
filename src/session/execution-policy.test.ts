import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { Session } from './session.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../utils/claude-detector.js', () => ({ getClaudePath: () => 'fixture-claude' }));

describe('explicit execution policy and workspace', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.each(['default', 'bypass'] as const)('persists %s policy and uses it for execution', async (policy) => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cb-policy-')));
    dirs.push(dir);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn(), unref: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const session = Session.create('policy', dir, undefined, undefined, false, dir, policy);
    expect(session.getState()).toMatchObject({ workingDir: dir, executionPolicy: policy });
    await session.sendPrompt('work');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const [, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(args?.includes('--dangerously-skip-permissions')).toBe(policy === 'bypass');
    expect(options).toMatchObject({ cwd: dir });
    const done = new Promise<void>((resolve) => session.once('notification', () => resolve()));
    child.emit('close', 0);
    await done;
  });

  it('uses safe defaults for new and legacy sessions and rejects nonexistent workspaces', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'cb-policy-')));
    dirs.push(dir);
    const session = Session.create('safe', dir);
    expect(session.executionPolicy).toBe('default');
    const legacy = session.getState();
    delete legacy.executionPolicy;
    expect(new Session(legacy, dir).executionPolicy).toBe('default');
    expect(() => Session.create('missing', dir, undefined, undefined, false, join(dir, 'missing'))).toThrow();
  });
});
