import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { executeShellHook, type ShellHook } from './shell-hooks.js';
import { createEvent, type HookEvent } from './events.js';

const hook: ShellHook = {
  id: 'hook-test', event: 'prompt.completed', command: '', enabled: true,
  createdAt: '2026-11-07T00:00:00.000Z'
};

function eventWithOutput(output: string) {
  return createEvent('prompt.completed', {
    sessionId: 'session-test', promptId: 'prompt-test', status: 'success', output
  });
}

describe('shell hook payload handling', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-shell-payload-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each(['command substitution', 'backticks', 'quotes', 'newline'])
  ('passes %s as literal data without executing it', async kind => {
    const sentinel = join(dir, 'executed');
    const payloads: Record<string, string> = {
      'command substitution': `$(touch ${sentinel})`,
      backticks: `\`touch ${sentinel}\``,
      quotes: `"; touch ${sentinel}; printf "`,
      newline: `first\n$(touch ${sentinel})\nlast`
    };
    const value = payloads[kind];
    const result = await executeShellHook({ ...hook, command: 'printf "%s" "$output"' }, eventWithOutput(value));
    expect(result).toMatchObject({ success: true, stdout: value });
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not reparse unquoted variable contents as command syntax', async () => {
    const sentinel = join(dir, 'executed');
    const result = await executeShellHook({ ...hook, command: 'printf "%s" $output' },
      eventWithOutput(`$(touch ${sentinel});`));
    expect(result.success).toBe(true);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves legacy aliases and CLAUDE_B metadata through normal shell expansion', async () => {
    const event = eventWithOutput('result with spaces');
    const result = await executeShellHook({ ...hook, command:
      'printf "%s\\n" "$EVENT" "$TIMESTAMP" "$sessionId" "$promptId" "$output" "$CLAUDE_B_SESSIONID" "$CLAUDE_B_PAYLOAD"'
    }, event);
    expect(result.success).toBe(true);
    const lines = result.stdout.split('\n');
    expect(lines.slice(0, 6)).toEqual([
      event.type, event.timestamp, 'session-test', 'prompt-test', 'result with spaces', 'session-test'
    ]);
    expect(JSON.parse(lines[6])).toEqual(event.payload);
  });

  it('uses shell quoting rules instead of interpolating inside single quotes', async () => {
    const result = await executeShellHook({ ...hook, command: "printf '%s' '$output'" }, eventWithOutput('value'));
    expect(result).toMatchObject({ success: true, stdout: '$output' });
  });

  it('keeps shell control variables and event metadata out of payload alias overrides', async () => {
    const event = eventWithOutput('result');
    const payload = event.payload as unknown as Record<string, unknown>;
    payload.PATH = '/not-a-real-command-path';
    payload.ENV = '/not-a-real-shell-init-file';
    payload.EVENT = 'forged';
    payload.TIMESTAMP = 'forged';
    payload['bad-name'] = 'invalid identifier';
    const result = await executeShellHook({ ...hook, command:
      'printf "%s\\n" "$EVENT" "$TIMESTAMP" "$CLAUDE_B_EVENT" "$CLAUDE_B_TIMESTAMP"; command -v sh'
    }, event as HookEvent);
    expect(result.success).toBe(true);
    expect(result.stdout.split('\n').slice(0, 4)).toEqual([
      event.type, event.timestamp, event.type, event.timestamp
    ]);
    expect(result.stdout).not.toContain('/not-a-real-command-path');
  });

  it('exposes scalar and structured values without string evaluation', async () => {
    const event = createEvent('tool.called', {
      sessionId: 'session-test', toolName: 'tool-test', args: { text: '$(do-not-run)', count: 3 }
    });
    const result = await executeShellHook({ ...hook, command: 'printf "%s" "$args"' }, event);
    expect(result.success).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(event.payload.args);
  });
  it('exposes the stable event ID without allowing payload override', async () => {
    const event = eventWithOutput('fixture');
    (event.payload as unknown as Record<string, unknown>).EVENT_ID = 'forged';
    expect(await executeShellHook({ ...hook, command: 'printf "%s|%s" "$EVENT_ID" "$CLAUDE_B_EVENT_ID"' }, event))
      .toMatchObject({ success: true, stdout: `${event.id}|${event.id}` });
  });

  it('does not launch an already aborted shell hook', async () => {
    const controller = new AbortController(); controller.abort();
    const sentinel = join(dir, 'not-started');
    expect(await executeShellHook({ ...hook, command: `touch '${sentinel}'` }, eventWithOutput('fixture'), controller.signal))
      .toMatchObject({ success: false, stderr: 'Hook delivery aborted' });
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('aborts the shell process group so descendants cannot execute delayed work', async () => {
    const sentinel = join(dir, 'descendant-ran');
    const controller = new AbortController();
    const pending = executeShellHook({ ...hook, command: `trap '' TERM; (sleep 0.6; printf x > '${sentinel}') & wait` }, eventWithOutput('fixture'), controller.signal);
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    expect(await pending).toMatchObject({ success: false, exitCode: null, stderr: 'Hook delivery aborted' });
    await new Promise(resolve => setTimeout(resolve, 450));
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });

});
