import { createInterface, Interface as ReadlineInterface } from 'readline';
import { writeFile, mkdir, readFile, chmod } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { envTemplate, getDataDir } from '../config/env.js';
import { TelegramConfigManager } from '../telegram/config.js';

interface Prompts {
  ask(question: string, opts?: { mask?: boolean; default?: string }): Promise<string>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  close(): void;
}

function createPrompts(): Prompts {
  const rl: ReadlineInterface = createInterface({ input: process.stdin, output: process.stdout });

  function ask(question: string, opts: { mask?: boolean; default?: string } = {}): Promise<string> {
    const suffix = opts.default ? chalk.gray(` [${opts.default}]`) : '';
    return new Promise((resolve) => {
      rl.question(`${question}${suffix} `, (answer) => {
        resolve(answer.trim() || opts.default || '');
      });
    });
  }

  async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = (await ask(`${question} ${chalk.gray(`(${hint})`)}`)).toLowerCase();
    if (!answer) return defaultYes;
    return answer.startsWith('y');
  }

  return { ask, confirm, close: () => rl.close() };
}

async function pingTelegramBot(token: string): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
      description?: string;
    };
    if (!json.ok) return { ok: false, error: json.description || 'Invalid token' };
    return { ok: true, username: json.result?.username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Polls getUpdates until the user sends /start (or any message) to the bot,
 * returning the chat id of the first private chat seen. Resolves to null
 * on timeout. Uses long-polling so we don't burn API quota.
 */
async function waitForFirstChat(token: string, timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;

  // Drain any old updates so we only react to fresh /start messages
  try {
    const drain = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`);
    const drainJson = (await drain.json()) as { ok: boolean; result?: Array<{ update_id: number }> };
    if (drainJson.ok && drainJson.result && drainJson.result.length > 0) {
      offset = drainJson.result[drainJson.result.length - 1].update_id + 1;
    }
  } catch {
    // Network blip — continue with offset 0
  }

  while (Date.now() < deadline) {
    const remaining = Math.max(1, Math.floor((deadline - Date.now()) / 1000));
    const pollSeconds = Math.min(25, remaining);
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=${pollSeconds}`
      );
      const json = (await res.json()) as {
        ok: boolean;
        result?: Array<{
          update_id: number;
          message?: { chat?: { id: number; type: string } };
        }>;
      };
      if (!json.ok || !json.result) continue;
      for (const update of json.result) {
        offset = update.update_id + 1;
        const chat = update.message?.chat;
        if (chat && (chat.type === 'private' || chat.type === 'group' || chat.type === 'supergroup')) {
          return String(chat.id);
        }
      }
    } catch {
      // Ignore transient errors, keep polling until deadline
    }
  }
  return null;
}

async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch {
    // Non-fatal — user will discover via /start reply anyway
  }
}

function printBanner(): void {
  console.log('');
  console.log(chalk.bold.cyan('  ╭──────────────────────────────────╮'));
  console.log(chalk.bold.cyan('  │       Claude-B setup wizard      │'));
  console.log(chalk.bold.cyan('  ╰──────────────────────────────────╯'));
  console.log('');
  console.log(chalk.gray('  Writes config to ~/.claude-b/.env and optionally'));
  console.log(chalk.gray('  configures a Telegram bot for remote control.'));
  console.log('');
}

function printBotFatherScript(): void {
  console.log('');
  console.log(chalk.bold('  Step 1: create a Telegram bot'));
  console.log('');
  console.log(`    1. Open Telegram and message ${chalk.cyan('@BotFather')}`);
  console.log(`    2. Send ${chalk.yellow('/newbot')}`);
  console.log(`    3. Pick a name, e.g. ${chalk.gray('"My Claude-B"')}`);
  console.log(`    4. Pick a username ending in ${chalk.gray('"bot"')}, e.g. ${chalk.gray('"my_claude_b_bot"')}`);
  console.log(`    5. BotFather replies with a token — copy it (looks like ${chalk.gray('123456:ABC...')})`);
  console.log('');
}

function mergeEnvFile(existing: string, updates: Record<string, string>): string {
  const lines = existing.split(/\r?\n/);
  const seen = new Set<string>();

  const out = lines.map((line) => {
    const match = line.match(/^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in updates)) return line;
    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  const missing = Object.entries(updates).filter(([k]) => !seen.has(k));
  if (missing.length > 0) {
    if (out.length && out[out.length - 1] !== '') out.push('');
    out.push('# Added by `cb init`');
    for (const [k, v] of missing) out.push(`${k}=${v}`);
    out.push('');
  }
  return out.join('\n');
}

export async function runInit(): Promise<void> {
  printBanner();

  const dataDir = getDataDir();
  await mkdir(dataDir, { recursive: true });
  const envPath = join(dataDir, '.env');
  const firstRun = !existsSync(envPath);

  if (!firstRun) {
    console.log(chalk.yellow(`  ~/.claude-b/.env already exists — updating in place.`));
    console.log('');
  }

  const prompts = createPrompts();
  const collected: Record<string, string> = {};

  try {
    // ---- Anthropic API key ----
    const existingAnthropic = process.env.ANTHROPIC_API_KEY;
    if (existingAnthropic) {
      console.log(chalk.green(`  ✓ ANTHROPIC_API_KEY already set (${existingAnthropic.slice(0, 8)}…)`));
    } else {
      console.log(chalk.bold('  Anthropic API key'));
      console.log(chalk.gray('    Get one at https://console.anthropic.com/settings/keys'));
      const key = await prompts.ask('    Paste ANTHROPIC_API_KEY (or empty to skip):');
      if (key) collected.ANTHROPIC_API_KEY = key;
      console.log('');
    }

    // ---- Telegram ----
    const wantTelegram = await prompts.confirm('  Set up Telegram bot for remote control?', true);
    console.log('');

    let telegramToken: string | undefined;
    let telegramChatId: string | undefined;

    if (wantTelegram) {
      printBotFatherScript();
      while (true) {
        const token = await prompts.ask('    Paste bot token:');
        if (!token) {
          console.log(chalk.yellow('    Skipped.'));
          break;
        }
        console.log(chalk.gray('    Verifying token...'));
        const ping = await pingTelegramBot(token);
        if (!ping.ok) {
          console.log(chalk.red(`    ✗ ${ping.error}`));
          const retry = await prompts.confirm('    Try another token?', true);
          if (!retry) break;
          continue;
        }
        console.log(chalk.green(`    ✓ Connected as @${ping.username}`));
        telegramToken = token;

        console.log('');
        console.log(chalk.bold('  Step 2: register your chat'));
        console.log(chalk.gray(`    Open @${ping.username} in Telegram and send ${chalk.yellow('/start')}.`));
        console.log(chalk.gray('    Waiting up to 3 minutes for your first message...'));
        console.log('');
        const chatId = await waitForFirstChat(token, 3 * 60 * 1000);
        if (!chatId) {
          console.log(chalk.yellow('    Timed out waiting for /start.'));
          console.log(chalk.gray('    You can run `cb --telegram <token>` later to retry.'));
          break;
        }
        telegramChatId = chatId;
        console.log(chalk.green(`    ✓ Registered chat id ${chatId}`));
        await sendTelegramMessage(
          token,
          chatId,
          '<b>Claude-B</b> is connected 🎉\nRun <code>cb --telegram-status</code> locally to confirm.'
        );
        break;
      }
      console.log('');
    }

    // ---- Voice pipeline (OpenAI) ----
    if (wantTelegram) {
      const wantVoice = await prompts.confirm(
        '  Enable voice notes (Whisper STT + TTS playback)?',
        false
      );
      console.log('');
      if (wantVoice) {
        const existingOpenAI = process.env.OPENAI_API_KEY;
        if (existingOpenAI) {
          console.log(chalk.green(`  ✓ OPENAI_API_KEY already set`));
        } else {
          const key = await prompts.ask('    Paste OPENAI_API_KEY (or empty to skip):');
          if (key) collected.OPENAI_API_KEY = key;
        }
        console.log('');
      }
    }

    // ---- Persist Telegram config ----
    if (telegramToken) {
      const tgConfig = new TelegramConfigManager(dataDir);
      await tgConfig.load();
      await tgConfig.setToken(telegramToken);
      if (telegramChatId) await tgConfig.addChatId(telegramChatId);
      if (collected.OPENAI_API_KEY || process.env.OPENAI_API_KEY) {
        const openaiKey = collected.OPENAI_API_KEY || process.env.OPENAI_API_KEY!;
        await tgConfig.setSTTProvider({ provider: 'openai', apiKey: openaiKey });
        await tgConfig.setAIProvider({ provider: 'anthropic', apiKey: collected.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '' });
      }
      collected.TELEGRAM_BOT_TOKEN = telegramToken;
      if (telegramChatId) collected.TELEGRAM_ALLOWED_CHAT_IDS = telegramChatId;
    }

    // ---- Write .env ----
    let existingEnv = '';
    if (existsSync(envPath)) {
      existingEnv = await readFile(envPath, 'utf-8');
    } else {
      existingEnv = envTemplate();
    }
    const merged = mergeEnvFile(existingEnv, collected);
    await writeFile(envPath, merged);
    await chmod(envPath, 0o600);

    console.log(chalk.bold.green(`  ✓ Wrote ${envPath}`));
    console.log('');
    console.log(chalk.bold('  Next steps'));
    console.log(`    • Start the daemon:  ${chalk.yellow('cb')} ${chalk.gray('"hello"')}   ${chalk.gray('(auto-starts on first use)')}`);
    if (telegramToken) {
      console.log(`    • Telegram bot:      ${chalk.yellow('cb --telegram-status')}`);
    }
    console.log(`    • REST API:          ${chalk.yellow('cb -r')}`);
    console.log('');
  } finally {
    prompts.close();
  }
}
