import { describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { createPromptReader } from './stdin.js';

describe('literal piped prompts', () => {
  it('retains whitespace, newlines, quotes and leading option-like text', async () => {
    const literal = '  --model not-a-flag\n"quoted" $(literal)\n\n';
    expect(await createPromptReader(Readable.from([literal]))([])).toBe(literal);
  });

  it('decodes UTF-8 split between chunks without corrupting characters', async () => {
    const bytes = Buffer.from('été ✓\n');
    const input = new PassThrough();
    const pending = createPromptReader(input)([]);
    for (const byte of bytes) input.write(Buffer.from([byte]));
    input.end();
    expect(await pending).toBe('été ✓\n');
  });

  it('preserves whitespace-only prompts as literal input', async () => {
    expect(await createPromptReader(Readable.from([' \n\t']))([])).toBe(' \n\t');
  });

  it('does not wait for stdin when positional arguments are supplied', async () => {
    const input = new PassThrough(); // deliberately never ended
    expect(await createPromptReader(input)(['explicit', 'prompt'])).toBe('explicit prompt');
    expect(input.readableFlowing).toBeNull();
    input.destroy();
  });

  it('does not read from an interactive terminal', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    expect(await createPromptReader(input)([])).toBeUndefined();
    expect(input.readableFlowing).toBeNull();
    input.destroy();
  });

  it('returns no prompt for an empty redirected stream', async () => {
    expect(await createPromptReader(Readable.from([]))([])).toBeUndefined();
  });

  it('reuses literal input on daemon-start retry', async () => {
    const reader = createPromptReader(Readable.from([' --literal\n']));
    expect(await reader([])).toBe(' --literal\n');
    expect(await reader([])).toBe(' --literal\n');
  });

  it('propagates a pipe read error without submitting partial input', async () => {
    const input = new PassThrough();
    const pending = createPromptReader(input)([]);
    input.write('partial');
    input.destroy(new Error('broken input'));
    await expect(pending).rejects.toThrow('broken input');
  });
});
