import { homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const KNOWN_KEYS = [
  // Claude Code
  'ANTHROPIC_API_KEY',
  'CLAUDE_PATH',
  // Voice pipeline
  'OPENAI_API_KEY',
  'SPEECHMATICS_API_KEY',
  'DEEPGRAM_API_KEY',
  'OPENROUTER_API_KEY',
  // Telegram
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_CHAT_IDS',
  // Claude-B infra
  'CB_DATA_DIR',
  'CB_REST_HOST',
  'CB_REST_PORT',
  'CB_REST_API_KEY',
  // Legacy aliases
  'REST_HOST',
  'REST_PORT',
] as const;

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = readFileSync(path, 'utf-8');
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip matching surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load environment variables with precedence:
 *   process.env  >  ~/.claude-b/.env  >  ./.env
 *
 * Only populates variables that are not already set in process.env.
 * Safe to call multiple times. Missing files are silently ignored.
 */
export function loadEnv(): void {
  const dataDir = process.env.CB_DATA_DIR || join(homedir(), '.claude-b');
  const sources = [
    join(dataDir, '.env'),
    join(process.cwd(), '.env'),
  ];

  for (const path of sources) {
    if (!existsSync(path)) continue;
    try {
      const parsed = parseEnvFile(path);
      for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // Unreadable .env — ignore, continue to next source
    }
  }

  // Legacy → CB_* aliases (don't clobber explicit CB_* values)
  if (process.env.CB_REST_HOST === undefined && process.env.REST_HOST) {
    process.env.CB_REST_HOST = process.env.REST_HOST;
  }
  if (process.env.CB_REST_PORT === undefined && process.env.REST_PORT) {
    process.env.CB_REST_PORT = process.env.REST_PORT;
  }
}

export function getDataDir(): string {
  return process.env.CB_DATA_DIR || join(homedir(), '.claude-b');
}

export function envTemplate(): string {
  return `# Claude-B configuration
# Precedence: process env > ~/.claude-b/.env > ./.env
# Uncomment and fill the vars you need.

# --- Required for Claude Code ---
# ANTHROPIC_API_KEY=sk-ant-...

# --- Optional: voice pipeline (Telegram voice notes) ---
# OPENAI_API_KEY=sk-...
# SPEECHMATICS_API_KEY=
# DEEPGRAM_API_KEY=

# --- Optional: Telegram integration ---
# TELEGRAM_BOT_TOKEN=123456:ABC...
# TELEGRAM_ALLOWED_CHAT_IDS=123456789,987654321

# --- Optional: Claude-B infrastructure ---
# CB_DATA_DIR=~/.claude-b
# CB_REST_HOST=127.0.0.1
# CB_REST_PORT=3847
# CB_REST_API_KEY=
`;
}

export { KNOWN_KEYS };
