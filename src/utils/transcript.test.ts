import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscript, readLastTurnsFromTranscript } from './transcript.js';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/transcripts/${name}`, import.meta.url));
let temporary: string | undefined;
afterEach(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); temporary = undefined; });

describe('native agent transcript context', () => {
  it.each([
    ['claude.jsonl', ['Fix the fixture parser', 'I will inspect the parser.', 'The fixture parser is fixed.']],
    ['codex.jsonl', ['Test the deadline', 'The deadline test passes.']],
    ['opencode.json', ['Check session routing', 'Session routing is checked.']]
  ])('parses the %s fixture without tool or reasoning data', (name, expected) => {
    const turns = parseTranscript(readFileSync(fixture(name as string), 'utf8'));
    expect(turns.map(turn => turn.text)).toEqual(expected);
    expect(JSON.stringify(turns)).not.toMatch(/private|synthetic/);
  });

  it('selects recent user and assistant turns independently, bounds text, and skips corrupt records', () => {
    const rows = Array.from({ length: 5 }, (_, index) => JSON.stringify({ type: 'user', message: { role: 'user', content: `user-${index}` } }));
    rows.push('corrupt', JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(5000) } }));
    const turns = parseTranscript(rows.join('\n'), 2);
    expect(turns.map(turn => turn.role)).toEqual(['user', 'user', 'assistant']);
    expect(turns[0].text).toBe('user-3');
    expect(turns.at(-1)?.text).toHaveLength(600);
  });

  it('reads bounded file tails and never evaluates ESM require or transcript contents', () => {
    temporary = mkdtempSync(join(tmpdir(), 'cb-transcript-'));
    const path = join(temporary, 'fixture.jsonl');
    writeFileSync(path, 'x'.repeat(10000) + '\n' + readFileSync(fixture('codex.jsonl'), 'utf8'));
    const text = readLastTurnsFromTranscript(path, 3, 1500);
    expect(text).toBe('USER: Test the deadline\n\nASSISTANT: The deadline test passes.');
    expect(() => readLastTurnsFromTranscript(temporary!)).toThrow('regular file');
  });

  it('does not confuse legitimate angle-bracket user input with known context wrappers', () => {
    expect(parseTranscript(JSON.stringify({ role: 'user', content: '<div>Fix this component</div>' }))[0].text)
      .toBe('<div>Fix this component</div>');
  });
});
