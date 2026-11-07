import { afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Each test file has its own worker environment and disposable state. Never
// discover the developer's real Claude executable, credentials or daemon state.
const testHome = mkdtempSync(join(tmpdir(), 'claude-b-vitest-'));
const testBin = join(testHome, 'bin');
mkdirSync(testBin);
process.env.CB_TEST_HOME = testHome;
process.env.CB_DATA_DIR = join(testHome, '.claude-b');
process.env.CLAUDE_PATH = join(testBin, 'claude');
process.env.PATH = `${testBin}:${process.env.PATH || ''}`;

for (const key of [
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SPEECHMATICS_API_KEY',
  'DEEPGRAM_API_KEY', 'OPENROUTER_API_KEY', 'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS', 'CB_REST_API_KEY',
]) {
  delete process.env[key];
}

writeFileSync(process.env.CLAUDE_PATH, `#!${process.execPath}
if (process.argv.includes('--version')) {
  console.log('0.0.0 (Claude-B test fixture)');
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => {
    console.log(JSON.stringify({
      result: 'fixture: ' + prompt,
      session_id: 'claude-b-test-session',
      duration_ms: 1,
      total_cost_usd: 0,
      num_turns: 1,
      is_error: false
    }));
  });
}
`, { mode: 0o700 });
writeFileSync(join(testBin, 'notify-send'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => process.env.CB_TEST_HOME! };
});

// Real integration requests stay on ephemeral loopback listeners. Individual
// tests can replace fetch with vi.stubGlobal when exercising HTTP failures.
const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return Promise.reject(new Error(`External network disabled in tests: ${url.origin}`));
  }
  return localFetch(input, init);
};

afterAll(() => {
  rmSync(testHome, { recursive: true, force: true });
});
