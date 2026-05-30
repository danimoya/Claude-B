import { describe, it, expect } from 'vitest';
import { sanitizeForSpeech } from './tts-text.js';

describe('sanitizeForSpeech', () => {
  it('drops fenced code blocks but keeps surrounding prose', () => {
    const out = sanitizeForSpeech(
      'Here is the fix:\n\n```ts\nconst x = 1;\nconsole.log(x);\n```\n\nThat resolves it.',
    );
    expect(out).not.toContain('const x');
    expect(out).not.toContain('console.log');
    expect(out).toContain('Here is the fix');
    expect(out).toContain('That resolves it');
    expect(out.toLowerCase()).toContain('code block omitted');
  });

  it('keeps link text and removes URLs', () => {
    const out = sanitizeForSpeech('See [the docs](https://example.com/x) and https://raw.url/here now.');
    expect(out).toContain('the docs');
    expect(out).not.toContain('example.com');
    expect(out).not.toContain('raw.url');
  });

  it('flattens markdown tables and drops separator rows', () => {
    const out = sanitizeForSpeech('| Name | Role |\n|------|------|\n| Ada | Engineer |');
    expect(out).not.toContain('|');
    expect(out).not.toMatch(/----/);
    expect(out).toContain('Ada, Engineer');
  });

  it('strips headings, bullets, emphasis markers but keeps words', () => {
    const out = sanitizeForSpeech('## Summary\n\n- **Done** the _thing_\n- Fixed `bug`');
    expect(out).toContain('Summary');
    expect(out).toContain('Done the thing');
    expect(out).toContain('Fixed bug');
    expect(out).not.toContain('#');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`');
  });

  it('removes notification metadata and trailing Sources section', () => {
    const out = sanitizeForSpeech(
      'PWD: /home/app\nSource: ~/.codex/hooks.json\n\nThe capital of France is Paris.\n\nReply to follow up, or /select abc12345\n\nSources:\n- https://a.com\n- https://b.com',
    );
    expect(out).toContain('The capital of France is Paris.');
    expect(out).not.toMatch(/PWD:/);
    expect(out).not.toMatch(/Source:/);
    expect(out).not.toMatch(/Reply to follow up/);
    expect(out).not.toMatch(/a\.com/);
  });

  it('strips emoji so they are not read by name', () => {
    const out = sanitizeForSpeech('✅ Build passed 🎉 all good ✳');
    expect(out).toContain('Build passed');
    expect(out).toContain('all good');
    expect(out).not.toMatch(/[☀-➿\u{1F000}-\u{1FAFF}]/u);
  });

  it('returns empty string for code-only input', () => {
    expect(sanitizeForSpeech('```python\nprint(1)\n```')).toBe('(code block omitted)');
  });

  it('caps very long output', () => {
    const out = sanitizeForSpeech('word '.repeat(2000));
    expect(out.length).toBeLessThanOrEqual(4100);
    expect(out).toMatch(/truncated/);
  });
});
