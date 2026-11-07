import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ClaudeBNotify } from '../../bin/opencode-notify.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: vi.fn(), appendFileSync: vi.fn() }));

describe('OpenCode plugin visible turn context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('TMUX', 'fixture-server');
    vi.stubEnv('TMUX_PANE', '%42');
    vi.mocked(execFileSync).mockReturnValue('project:1.0');
    vi.mocked(readFileSync).mockReturnValue('fixture-api-key');
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('includes only the last three visible turns for each role, bounded to 600 characters', async () => {
    const messages = [];
    for (let i = 0; i < 4; i++) {
      messages.push({ info: { role: 'user' }, parts: [{ type: 'text', text: `question-${i}` }] });
      messages.push({ info: { role: 'assistant' }, parts: [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'tool', state: { output: 'private tool output' } },
        { type: 'text', synthetic: true, text: 'synthetic summary' },
        { type: 'text', text: `answer-${i} ` + 'x'.repeat(700) }
      ] });
    }
    const client = { session: {
      get: vi.fn().mockResolvedValue({ data: { title: 'fixture', directory: '/fixture' } }),
      messages: vi.fn().mockResolvedValue({ data: messages })
    } };
    const receiver = vi.fn().mockImplementation(async () => new Response('ok'));
    vi.stubGlobal('fetch', receiver);
    const plugin = await ClaudeBNotify({ client, directory: '/fixture' });
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'native-session' } } });
    expect(receiver).toHaveBeenCalledOnce();
    const body = JSON.parse(receiver.mock.calls[0][1].body);
    expect(body.agent).toBe('opencode');
    expect(body.contextTurns).toHaveLength(6);
    expect(body.contextTurns.map(turn => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(body.contextTurns[0].text).toBe('question-1');
    expect(body.contextTurns.every(turn => turn.text.length <= 600)).toBe(true);
    expect(JSON.stringify(body.contextTurns)).not.toMatch(/private|synthetic/);
    expect(body.resultPreview).toContain('answer-3');
  });

  it('does not notify for child sessions or non-tmux events', async () => {
    const receiver = vi.fn(); vi.stubGlobal('fetch', receiver);
    const client = { session: { get: vi.fn().mockResolvedValue({ data: { parentID: 'parent' } }), messages: vi.fn() } };
    const plugin = await ClaudeBNotify({ client, directory: '/fixture' });
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'child' } } });
    vi.stubEnv('TMUX', '');
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'native' } } });
    expect(receiver).not.toHaveBeenCalled();
    expect(client.session.messages).not.toHaveBeenCalled();
  });

  it('drops synthetic user wrappers without dropping legitimate markup and preserves Unicode boundaries', async () => {
    const messages = [
      { info: { role: 'user' }, parts: [{ type: 'text', text: '<system-reminder>hidden</system-reminder>' }] },
      { info: { role: 'user' }, parts: [{ type: 'text', text: '<div>fix this component</div>' }] },
      { info: { role: 'assistant' }, parts: [{ type: 'text', text: '✓'.repeat(800) }] }
    ];
    const client = { session: { get: vi.fn().mockResolvedValue({ data: {} }), messages: vi.fn().mockResolvedValue({ data: messages }) } };
    const receiver = vi.fn().mockImplementation(async () => new Response('ok')); vi.stubGlobal('fetch', receiver);
    const plugin = await ClaudeBNotify({ client, directory: '/fixture' });
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'native' } } });
    expect(JSON.parse(receiver.mock.calls[0][1].body).contextTurns).toEqual([
      { role: 'user', text: '<div>fix this component</div>' }, { role: 'assistant', text: '✓'.repeat(600) }
    ]);
  });
});
