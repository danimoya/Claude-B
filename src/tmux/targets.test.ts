import { describe, expect, it, vi } from 'vitest';
import { pasteToTmuxPane, resolveTmuxPane, parseTmuxPaneIdentity } from './targets.js';

const identity = { paneId: '%42', pid: 1234, command: 'claude' };
const output = '%42\t1234\t0\tclaude\n';

describe('stable tmux pane delivery (platform independent fixtures)', () => {
  it.each([
    { platform: 'linux', wire: output, expected: identity },
    { platform: 'darwin', wire: '%7\t4321\t0\tnode\n', expected: { paneId: '%7', pid: 4321, command: 'node' } }
  ])('resolves the portable format envelope modeled for $platform', async ({ wire, expected }) => {
    const runner = vi.fn().mockResolvedValue(wire);
    expect(await resolveTmuxPane('project:1.0', runner)).toEqual(expected);
    expect(runner.mock.calls[0][0].slice(0, 4)).toEqual(['display-message', '-p', '-t', 'project:1.0']);
  });
  it.each(['', '-a', 'project', 'project:1.0;touch /tmp/unsafe'])('rejects incomplete or malformed targets before invoking tmux', async target => {
    const runner = vi.fn();
    await expect(resolveTmuxPane(target, runner)).rejects.toThrow('Invalid tmux target');
    expect(runner).not.toHaveBeenCalled();
  });
  it.each(['%42\t1234\t1\tclaude', '%42\tbad\t0\tclaude', 'project:1.0\t1234\t0\tclaude'])
  ('rejects dead or malformed pane identities', value => {
    expect(() => parseTmuxPaneIdentity(value)).toThrow('live identifiable');
  });
  it('pastes literal text through stdin and targets the stable ID for paste and Enter', async () => {
    const runner = vi.fn().mockResolvedValue(output);
    const text = '--literal\n$(never a shell command)\n';
    await pasteToTmuxPane(identity, text, runner, 0);
    const calls = runner.mock.calls;
    expect(calls.filter(([args]) => args[0] === 'display-message')).toHaveLength(3);
    expect(calls.find(([args]) => args[0] === 'load-buffer')?.[1]).toBe(text);
    expect(calls.find(([args]) => args[0] === 'paste-buffer')?.[0].slice(-2)).toEqual(['-t', '%42']);
    expect(calls.find(([args]) => args[0] === 'send-keys')?.[0]).toEqual(['send-keys', '-t', '%42', 'Enter']);
    expect(calls.at(-1)?.[0][0]).toBe('delete-buffer');
  });
  it('refuses a replaced process before pasting and cleans the staged buffer', async () => {
    let checks = 0;
    const runner = vi.fn().mockImplementation(async (args: string[]) => args[0] === 'display-message'
      ? ++checks === 1 ? output : '%42\t9999\t0\tclaude' : '');
    await expect(pasteToTmuxPane(identity, 'prompt', runner, 0)).rejects.toThrow('identity changed');
    expect(runner.mock.calls.some(([args]) => args[0] === 'paste-buffer')).toBe(false);
    expect(runner.mock.calls.at(-1)?.[0][0]).toBe('delete-buffer');
  });
  it('refuses Enter when the agent exits after paste, without automatic retry', async () => {
    let checks = 0;
    const runner = vi.fn().mockImplementation(async (args: string[]) => args[0] === 'display-message'
      ? ++checks < 3 ? output : '%42\t1234\t0\tbash' : '');
    await expect(pasteToTmuxPane(identity, 'prompt', runner, 0)).rejects.toThrow('identity changed');
    expect(runner.mock.calls.filter(([args]) => args[0] === 'paste-buffer')).toHaveLength(1);
    expect(runner.mock.calls.some(([args]) => args[0] === 'send-keys')).toBe(false);
  });
});
