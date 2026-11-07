import { describe, expect, it } from 'vitest';
import { homedir } from 'os';
import { execFileSync } from 'child_process';
import { getDataDir } from '../src/config/env.js';
import { getClaudePath } from '../src/utils/claude-detector.js';

describe('test isolation', () => {
  it('uses disposable state and a deterministic Claude executable', () => {
    expect(homedir()).toBe(process.env.CB_TEST_HOME);
    expect(getDataDir()).toBe(`${homedir()}/.claude-b`);
    expect(getClaudePath()).toBe(`${homedir()}/bin/claude`);
    const result = JSON.parse(execFileSync(getClaudePath(), ['--print'], {
      input: 'a literal test prompt', encoding: 'utf8',
    })) as { result: string; total_cost_usd: number };
    expect(result.result).toBe('fixture: a literal test prompt');
    expect(result.total_cost_usd).toBe(0);
  });

  it('rejects accidental external fetches before opening a connection', async () => {
    await expect(fetch('https://example.com/test')).rejects.toThrow('External network disabled');
  });
});
