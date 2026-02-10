#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { DaemonClient } from '../daemon/client.js';
import { version } from '../utils/version.js';
import { detectClaude } from '../utils/claude-detector.js';

// Type definitions for API responses
interface SessionInfo {
  id: string;
  name?: string;
  status: string;
  selected: boolean;
}

interface SessionListData {
  sessions: SessionInfo[];
}

interface SessionData {
  sessionId: string;
  name?: string;
  status?: string;
  output?: string;
}

interface StatusData {
  pid: number;
  uptime: string;
  sessionCount: number;
  memoryUsage: string;
}

interface PromptData {
  promptId: string;
}

interface RestData {
  success?: boolean;
  running?: boolean;
  address?: string;
  port?: number;
  host?: string;
  apiKey?: string;
}

interface ShellHookData {
  id: string;
  event: string;
  command: string;
  sessionFilter?: string;
  enabled: boolean;
  createdAt: string;
}

interface WebhookData {
  id: string;
  event: string;
  url: string;
  sessionFilter?: string;
  enabled: boolean;
  createdAt: string;
}

interface HookListData {
  hooks?: ShellHookData[];
  webhooks?: WebhookData[];
}

interface HookStatsData {
  shellHooks: number;
  webhooks: number;
  enabledShellHooks: number;
  enabledWebhooks: number;
  eventCount: number;
}

interface RemoteHostData {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  priority: number;
}

interface HealthStatus {
  overall: { healthy: boolean; healthyPercentage: number };
  hosts: Array<{
    hostId: string;
    healthy: boolean;
    uptime: number;
    avgLatency: number;
    p99Latency: number;
    successRate: number;
    consecutiveFailures: number;
    lastCheck?: string;
    lastError?: string;
  }>;
}

interface OrchestrationStats {
  hosts: { total: number; healthy: number; unhealthy: number };
  requests: { total: number; successful: number; failed: number; failovers: number };
  pipelines: { total: number; completed: number; failed: number; partial: number };
  circuitBreakers: Record<string, { state: string; failures: number }>;
}

interface RemotePromptResult {
  sessionId: string;
  promptId: string;
  status: string;
  output?: string;
  error?: string;
  host: string;
  latency: number;
}

const program = new Command();

program
  .name('cb')
  .description('Claude-B: Background Claude Code with async workflows')
  .version(version);

// Default command: send prompt
program
  .argument('[prompt...]', 'Prompt to send to Claude')
  .option('-l, --last', 'Show status and output of last prompt')
  .option('-s, --sess', 'List all sessions')
  .option('-a, --attach <id>', 'Attach to session (foreground mode)')
  .option('-d, --detach', 'Detach from current session')
  .option('-n, --new [name]', 'Create new session')
  .option('-m, --model <model>', 'Claude model to use (with --new)')
  .option('-k, --kill <id>', 'Kill/terminate session')
  .option('-w, --watch', 'Watch live output (tail -f style)')
  .option('-x, --select <id>', 'Select session for subsequent commands')
  .option('-c, --current', 'Show current selected session')
  .option('-r, --rest [port]', 'Start REST API server')
  .option('--rest-stop', 'Stop REST API server')
  .option('--status', 'Daemon status and health')
  .option('--logs', 'View daemon logs')
  .option('--hook <event> <cmd>', 'Register shell hook for event')
  .option('--hook-session <id>', 'Only trigger hook for this session (use with --hook)')
  .option('--unhook <id>', 'Remove a shell hook')
  .option('--hooks', 'List all shell hooks')
  .option('--webhook <url>', 'Register webhook for notifications')
  .option('--webhook-event <event>', 'Event type for webhook (default: *)')
  .option('--webhook-session <id>', 'Only trigger webhook for this session (use with --webhook)')
  .option('--unwebhook <id>', 'Remove a webhook')
  .option('--webhooks', 'List all webhooks')
  .option('--hook-stats', 'Show hook statistics')
  .option('--api-key', 'Generate/show API key for REST access')
  .option('--config', 'Edit configuration')
  .option('--export <id>', 'Export session transcript')
  .option('--import <file>', 'Import session from file')
  // Orchestration options
  .option('--remote-add <url>', 'Add a remote Claude-B host')
  .option('--remote-key <apiKey>', 'API key for remote host (use with --remote-add)')
  .option('--remote-name <name>', 'Name for remote host (use with --remote-add)')
  .option('--remote-priority <n>', 'Priority for remote host (use with --remote-add)')
  .option('--remote-remove <id>', 'Remove a remote host')
  .option('--remote-toggle <id>', 'Toggle remote host enabled/disabled')
  .option('--remote-hosts', 'List all remote hosts')
  .option('--remote-health', 'Show health status of remote hosts')
  .option('--remote-stats', 'Show orchestration statistics')
  .option('--remote <hostId>', 'Send prompt to specific remote host')
  // Fire-and-forget and notifications
  .option('-f, --fire', 'Fire and forget (launch task in background, no watching)')
  .option('-g, --goal <description>', 'Goal/objective for fire-and-forget task (use with -f)')
  .option('-i, --inbox', 'Show notification inbox (completed tasks)')
  .option('--inbox-clear', 'Mark all notifications as read')
  .option('--inbox-count', 'Show unread notification count')
  .option('--remote-fire <hostId>', 'Fire and forget to remote host')
  // Telegram integration
  .option('--telegram <token>', 'Set up Telegram bot with token')
  .option('--telegram-stop', 'Disable Telegram notifications')
  .option('--telegram-status', 'Show Telegram bot status')
  // Voice pipeline
  .option('--voice-setup <key>', 'Configure Speechmatics API key for voice')
  .option('--ai-provider <config>', 'Set AI provider: "anthropic <key>" or "openrouter <key>"')
  .option('--voice-status', 'Show voice pipeline status')
  .action(async (promptParts: string[], options) => {
    const client = new DaemonClient();

    try {
      // Handle flags first
      if (options.last) {
        await showLastOutput(client);
        return;
      }

      if (options.sess) {
        await listSessions(client);
        return;
      }

      if (options.attach) {
        await attachSession(client, options.attach);
        return;
      }

      if (options.detach) {
        await detachSession(client);
        return;
      }

      if (options.new !== undefined) {
        const name = typeof options.new === 'string' ? options.new : undefined;
        await createSession(client, name, options.model);
        return;
      }

      if (options.kill) {
        await killSession(client, options.kill);
        return;
      }

      if (options.watch) {
        await watchSession(client);
        return;
      }

      if (options.select) {
        await selectSession(client, options.select);
        return;
      }

      if (options.current) {
        await showCurrentSession(client);
        return;
      }

      if (options.rest !== undefined) {
        const port = typeof options.rest === 'string' ? parseInt(options.rest, 10) : 3847;
        await startRestServer(client, port);
        return;
      }

      if (options.restStop) {
        await stopRestServer(client);
        return;
      }

      if (options.apiKey) {
        await showApiKey(client);
        return;
      }

      if (options.status) {
        await showStatus(client);
        return;
      }

      if (options.logs) {
        await showLogs();
        return;
      }

      // Hook management
      if (options.hook) {
        // --hook expects two args but commander puts them together
        // Parse as: cb --hook "prompt.completed" "notify-send 'Done'"
        const args = promptParts;
        if (args.length < 1) {
          console.error(chalk.red('Usage: cb --hook <event> <command>'));
          console.error(chalk.gray('Events: session.created, session.destroyed, prompt.received, prompt.completed, prompt.error, daemon.started, daemon.stopped, rest.started, rest.stopped, * (all)'));
          console.error(chalk.gray('Use --hook-session <id> to filter by session'));
          return;
        }
        const event = options.hook;
        const command = args.join(' ');
        await addShellHook(client, event, command, options.hookSession);
        return;
      }

      if (options.unhook) {
        await removeShellHook(client, options.unhook);
        return;
      }

      if (options.hooks) {
        await listShellHooks(client);
        return;
      }

      if (options.webhook) {
        const event = options.webhookEvent || '*';
        await addWebhook(client, event, options.webhook, options.webhookSession);
        return;
      }

      if (options.unwebhook) {
        await removeWebhook(client, options.unwebhook);
        return;
      }

      if (options.webhooks) {
        await listWebhooks(client);
        return;
      }

      if (options.hookStats) {
        await showHookStats(client);
        return;
      }

      // Orchestration commands
      if (options.remoteAdd) {
        if (!options.remoteKey) {
          console.error(chalk.red('API key required. Use --remote-key <apiKey>'));
          return;
        }
        await addRemoteHost(client, options.remoteAdd, options.remoteKey, {
          name: options.remoteName,
          priority: options.remotePriority ? parseInt(options.remotePriority, 10) : undefined
        });
        return;
      }

      if (options.remoteRemove) {
        await removeRemoteHost(client, options.remoteRemove);
        return;
      }

      if (options.remoteToggle) {
        await toggleRemoteHost(client, options.remoteToggle);
        return;
      }

      if (options.remoteHosts) {
        await listRemoteHosts(client);
        return;
      }

      if (options.remoteHealth) {
        await showRemoteHealth(client);
        return;
      }

      if (options.remoteStats) {
        await showOrchestrationStats(client);
        return;
      }

      if (options.remote) {
        if (promptParts.length === 0) {
          console.error(chalk.red('Prompt required for remote execution'));
          return;
        }
        const prompt = promptParts.join(' ');
        await sendRemotePrompt(client, options.remote, prompt);
        return;
      }

      // Notification inbox commands
      if (options.inbox) {
        await showInbox(client);
        return;
      }

      if (options.inboxClear) {
        await clearInbox(client);
        return;
      }

      if (options.inboxCount) {
        await showInboxCount(client);
        return;
      }

      // Telegram commands
      if (options.telegram) {
        await setupTelegram(client, options.telegram);
        return;
      }

      if (options.telegramStop) {
        await stopTelegram(client);
        return;
      }

      if (options.telegramStatus) {
        await showTelegramStatus(client);
        return;
      }

      // Voice pipeline commands
      if (options.voiceSetup) {
        await setupVoicePipeline(client, options.voiceSetup);
        return;
      }

      if (options.aiProvider) {
        // Parse "anthropic <key>" or "openrouter <key>" from remaining args
        const provider = options.aiProvider;
        const apiKey = promptParts[0];
        const model = promptParts[1];
        if (!apiKey) {
          console.error(chalk.red('Usage: cb --ai-provider <anthropic|openrouter> <api-key> [model]'));
          process.exit(1);
        }
        await setupVoiceAI(client, provider, apiKey, model);
        return;
      }

      if (options.voiceStatus) {
        await showVoiceStatus(client);
        return;
      }

      // Remote fire-and-forget
      if (options.remoteFire) {
        if (promptParts.length === 0) {
          console.error(chalk.red('Prompt required for remote fire-and-forget'));
          return;
        }
        const prompt = promptParts.join(' ');
        await fireRemotePrompt(client, options.remoteFire, prompt, options.goal);
        return;
      }

      // If we have a prompt, send it (or fire-and-forget)
      if (promptParts.length > 0) {
        const prompt = promptParts.join(' ');
        if (options.fire) {
          await fireAndForgetPrompt(client, prompt, options.goal);
        } else {
          await sendPrompt(client, prompt);
        }
        return;
      }

      // No arguments - show help
      program.help();
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOENT')) {
          console.error(chalk.yellow('Daemon not running. Starting daemon...'));
          await startDaemon();
          await waitForDaemon();
          console.log(chalk.green('Daemon started. Retrying...'));
          // Re-run the command by re-parsing argv
          await program.parseAsync(process.argv);
          return;
        } else {
          console.error(chalk.red(`Error: ${error.message}`));
        }
      }
      process.exit(1);
    }
  });

// Command handlers
async function showLastOutput(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'session.last' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as SessionData | undefined;
  if (!data) {
    console.log(chalk.gray('No output available'));
    process.exit(0);
  }
  console.log(chalk.bold(`Session: ${data.sessionId}`));
  console.log(chalk.gray(`Status: ${data.status}`));
  console.log('');
  console.log(data.output);
  process.exit(0);
}

async function listSessions(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'session.list' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as SessionListData | undefined;
  const sessions = data?.sessions || [];
  if (sessions.length === 0) {
    console.log(chalk.gray('No active sessions'));
    process.exit(0);
  }
  console.log(chalk.bold('Sessions:'));
  for (const session of sessions) {
    const marker = session.selected ? chalk.green('*') : ' ';
    const status = session.status === 'busy' ? chalk.yellow('busy') : chalk.gray('idle');
    console.log(`${marker} ${chalk.cyan(session.id)} ${session.name ? chalk.gray(`(${session.name})`) : ''} [${status}]`);
  }
  process.exit(0);
}

async function attachSession(client: DaemonClient, sessionId: string): Promise<void> {
  console.log(chalk.green(`Attaching to session ${sessionId}...`));
  console.log(chalk.gray('Press Ctrl+D to detach'));
  await client.attach(sessionId);
}

async function detachSession(client: DaemonClient): Promise<void> {
  await client.send({ method: 'session.detach' });
  client.close();
  console.log(chalk.green('Detached from session'));
  process.exit(0);
}

async function createSession(client: DaemonClient, name?: string, model?: string): Promise<void> {
  const result = await client.send({ method: 'session.create', params: { name, model } });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as SessionData | undefined;
  console.log(chalk.green(`Created session: ${data?.sessionId}`));
  if (name) {
    console.log(chalk.gray(`Name: ${name}`));
  }
  if (model) {
    console.log(chalk.gray(`Model: ${model}`));
  }
  process.exit(0);
}

async function killSession(client: DaemonClient, sessionId: string): Promise<void> {
  const result = await client.send({ method: 'session.kill', params: { sessionId } });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  console.log(chalk.green(`Killed session: ${sessionId}`));
  process.exit(0);
}

async function watchSession(client: DaemonClient): Promise<void> {
  console.log(chalk.gray('Watching session output (Ctrl+C to stop)...'));
  await client.watch();
}

async function selectSession(client: DaemonClient, sessionId: string): Promise<void> {
  const result = await client.send({ method: 'session.select', params: { sessionId } });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  console.log(chalk.green(`Selected session: ${sessionId}`));
  process.exit(0);
}

async function showCurrentSession(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'session.current' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as SessionData | undefined;
  if (!data?.sessionId) {
    console.log(chalk.gray('No session selected'));
    process.exit(0);
  }
  console.log(chalk.cyan(data.sessionId));
  if (data.name) {
    console.log(chalk.gray(`Name: ${data.name}`));
  }
  console.log(chalk.gray(`Status: ${data.status}`));
  process.exit(0);
}

async function startRestServer(client: DaemonClient, port: number): Promise<void> {
  console.log(chalk.gray(`Starting REST API server on port ${port}...`));
  const result = await client.send({ method: 'rest.start', params: { port } });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as RestData | undefined;
  console.log(chalk.green(`REST API server started!`));
  console.log(`  Address: ${chalk.cyan(data?.address)}`);
  console.log(`  API Key: ${chalk.cyan(data?.apiKey)}`);
  console.log('');
  console.log(chalk.gray('Example usage:'));
  console.log(chalk.gray(`  # Get token`));
  console.log(chalk.gray(`  curl -X POST http://localhost:${port}/api/auth/token \\`));
  console.log(chalk.gray(`    -H "Content-Type: application/json" \\`));
  console.log(chalk.gray(`    -d '{"api_key": "${data?.apiKey}"}'`));
  console.log('');
  console.log(chalk.gray(`  # List sessions`));
  console.log(chalk.gray(`  curl http://localhost:${port}/api/sessions \\`));
  console.log(chalk.gray(`    -H "Authorization: Bearer <token>"`));
  process.exit(0);
}

async function stopRestServer(client: DaemonClient): Promise<void> {
  // First check if REST server is running
  const statusResult = await client.send({ method: 'rest.status' });
  const statusData = statusResult.data as RestData | undefined;

  if (!statusData?.running) {
    client.close();
    console.log(chalk.gray('REST server is not running.'));
    process.exit(0);
  }

  const result = await client.send({ method: 'rest.stop' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  console.log(chalk.green('REST API server stopped'));
  process.exit(0);
}

async function showApiKey(client: DaemonClient): Promise<void> {
  // First check if REST server is running
  const statusResult = await client.send({ method: 'rest.status' });
  const statusData = statusResult.data as RestData | undefined;

  if (!statusData?.running) {
    client.close();
    console.log(chalk.yellow('REST server is not running.'));
    console.log(chalk.gray('Start it with: cb -r [port]'));
    process.exit(0);
  }

  const result = await client.send({ method: 'rest.apikey' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as RestData | undefined;
  console.log(chalk.bold('API Key:'));
  console.log(chalk.cyan(data?.apiKey));
  process.exit(0);
}

async function showStatus(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'daemon.status' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as StatusData | undefined;
  if (!data) {
    console.error(chalk.red('No status data available'));
    process.exit(1);
  }
  console.log(chalk.bold('Daemon Status:'));
  console.log(`  PID: ${chalk.cyan(data.pid)}`);
  console.log(`  Uptime: ${chalk.cyan(data.uptime)}`);
  console.log(`  Sessions: ${chalk.cyan(data.sessionCount)}`);
  console.log(`  Memory: ${chalk.cyan(data.memoryUsage)}`);

  // Show Claude Code detection info
  const claude = detectClaude();
  if (claude) {
    const version = claude.version ? ` v${claude.version}` : '';
    console.log(`  Claude: ${chalk.green(claude.path)}${chalk.gray(version)} (${claude.type})`);
  } else {
    console.log(`  Claude: ${chalk.red('Not found')} - set CLAUDE_PATH or install Claude Code`);
  }
  process.exit(0);
}

async function showLogs(): Promise<void> {
  const { homedir } = await import('os');
  const logFile = `${homedir()}/.claude-b/daemon.log`;
  console.log(chalk.gray(`Log file: ${logFile}`));
  // In a real implementation, we'd tail the log file
  console.log(chalk.gray('(Log viewing implementation pending)'));
  process.exit(0);
}

async function sendPrompt(client: DaemonClient, prompt: string): Promise<void> {
  console.log(chalk.gray('Sending prompt...'));
  const result = await client.send({ method: 'prompt.send', params: { prompt } });
  if (result.error) {
    console.error(chalk.red(result.error));
    return;
  }
  const data = result.data as PromptData | undefined;
  console.log(chalk.green(`Prompt queued (ID: ${data?.promptId})`));
  console.log(chalk.gray('Watching output (Ctrl+C to detach)...\n'));

  // Start watching for output immediately
  await client.send({ method: 'session.watch' });

  // Listen for status updates
  client.on('status', (statusData: { status: string; promptId?: string }) => {
    if (statusData.status === 'processing') {
      console.log(chalk.yellow(`[Processing prompt ${statusData.promptId || ''}...]`));
    } else if (statusData.status === 'completed') {
      console.log(chalk.green(`\n[Completed]`));
    } else if (statusData.status === 'error') {
      console.log(chalk.red(`\n[Error]`));
    }
  });

  // Listen for output and display it
  // When using --output-format json, stdout is a JSON blob - extract the result field
  let jsonAccumulator = '';
  client.on('output', (outputData: { content: string }) => {
    jsonAccumulator += outputData.content;
    // Try to parse as complete JSON (from --output-format json)
    try {
      const parsed = JSON.parse(jsonAccumulator.trim());
      if (parsed.result !== undefined) {
        process.stdout.write(parsed.result);
        jsonAccumulator = '';
        return;
      }
    } catch {
      // Not complete JSON yet or not JSON at all - display raw for streaming
    }
    process.stdout.write(outputData.content);
  });

  // Handle Ctrl+C to detach
  process.on('SIGINT', () => {
    console.log(chalk.gray('\n\nDetaching... (use "cb -l" to check result or "cb -w" to resume watching)'));
    client.send({ method: 'session.unwatch' }).finally(() => {
      process.exit(0);
    });
  });

  // Wait for completion or connection close
  await new Promise<void>((resolve) => {
    client.on('close', resolve);
  });
}

async function startDaemon(): Promise<void> {
  const { spawn } = await import('child_process');
  const { homedir } = await import('os');
  const { mkdir } = await import('fs/promises');

  const configDir = `${homedir()}/.claude-b`;
  await mkdir(configDir, { recursive: true });

  const daemon = spawn('node', ['dist/daemon/index.js'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore'
  });
  daemon.unref();
}

async function waitForDaemon(maxWaitMs = 5000): Promise<void> {
  const interval = 200;
  const maxAttempts = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const testClient = new DaemonClient();
      const result = await testClient.send({ method: 'status' });
      testClient.close();
      if (result.data) return;
    } catch {
      // Not ready yet
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  throw new Error('Daemon failed to start within timeout');
}

// Hook management functions
async function addShellHook(client: DaemonClient, event: string, command: string, sessionFilter?: string): Promise<void> {
  const result = await client.send({
    method: 'hook.shell.add',
    params: { event, command, sessionFilter }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as { hook?: ShellHookData };
  console.log(chalk.green(`Shell hook added: ${data.hook?.id}`));
  console.log(chalk.gray(`  Event: ${event}`));
  console.log(chalk.gray(`  Command: ${command}`));
  if (sessionFilter) {
    console.log(chalk.gray(`  Session filter: ${sessionFilter}`));
  }
  process.exit(0);
}

async function removeShellHook(client: DaemonClient, id: string): Promise<void> {
  const result = await client.send({
    method: 'hook.shell.remove',
    params: { id }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  console.log(chalk.green(`Shell hook removed: ${id}`));
  process.exit(0);
}

async function listShellHooks(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'hook.shell.list' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as HookListData;
  const hooks = data.hooks || [];

  if (hooks.length === 0) {
    console.log(chalk.gray('No shell hooks registered'));
    process.exit(0);
  }

  console.log(chalk.bold('Shell Hooks:'));
  for (const hook of hooks) {
    const status = hook.enabled ? chalk.green('enabled') : chalk.gray('disabled');
    console.log(`  ${chalk.cyan(hook.id)} [${status}]`);
    console.log(`    Event: ${chalk.yellow(hook.event)}`);
    console.log(`    Command: ${chalk.gray(hook.command)}`);
    if (hook.sessionFilter) {
      console.log(`    Session: ${chalk.magenta(hook.sessionFilter)}`);
    }
  }
  process.exit(0);
}

async function addWebhook(client: DaemonClient, event: string, url: string, sessionFilter?: string): Promise<void> {
  const result = await client.send({
    method: 'hook.webhook.add',
    params: { event, url, sessionFilter }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as { webhook?: WebhookData };
  console.log(chalk.green(`Webhook added: ${data.webhook?.id}`));
  console.log(chalk.gray(`  Event: ${event}`));
  console.log(chalk.gray(`  URL: ${url}`));
  if (sessionFilter) {
    console.log(chalk.gray(`  Session filter: ${sessionFilter}`));
  }
  process.exit(0);
}

async function removeWebhook(client: DaemonClient, id: string): Promise<void> {
  const result = await client.send({
    method: 'hook.webhook.remove',
    params: { id }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  console.log(chalk.green(`Webhook removed: ${id}`));
  process.exit(0);
}

async function listWebhooks(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'hook.webhook.list' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as HookListData;
  const webhooks = data.webhooks || [];

  if (webhooks.length === 0) {
    console.log(chalk.gray('No webhooks registered'));
    process.exit(0);
  }

  console.log(chalk.bold('Webhooks:'));
  for (const webhook of webhooks) {
    const status = webhook.enabled ? chalk.green('enabled') : chalk.gray('disabled');
    console.log(`  ${chalk.cyan(webhook.id)} [${status}]`);
    console.log(`    Event: ${chalk.yellow(webhook.event)}`);
    console.log(`    URL: ${chalk.gray(webhook.url)}`);
    if (webhook.sessionFilter) {
      console.log(`    Session: ${chalk.magenta(webhook.sessionFilter)}`);
    }
  }
  process.exit(0);
}

async function showHookStats(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'hook.stats' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as unknown as HookStatsData;
  console.log(chalk.bold('Hook Statistics:'));
  console.log(`  Shell Hooks: ${chalk.cyan(data.enabledShellHooks)}/${data.shellHooks} enabled`);
  console.log(`  Webhooks: ${chalk.cyan(data.enabledWebhooks)}/${data.webhooks} enabled`);
  console.log(`  Events Processed: ${chalk.cyan(data.eventCount)}`);
  process.exit(0);
}

// Orchestration functions
async function addRemoteHost(
  client: DaemonClient,
  url: string,
  apiKey: string,
  options: { name?: string; priority?: number }
): Promise<void> {
  const result = await client.send({
    method: 'orchestration.host.add',
    params: { url, apiKey, name: options.name, priority: options.priority }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as { host?: RemoteHostData };
  console.log(chalk.green(`Remote host added: ${data.host?.id}`));
  console.log(chalk.gray(`  Name: ${data.host?.name}`));
  console.log(chalk.gray(`  URL: ${url}`));
  console.log(chalk.gray(`  Priority: ${data.host?.priority}`));
  process.exit(0);
}

async function removeRemoteHost(client: DaemonClient, hostId: string): Promise<void> {
  const result = await client.send({
    method: 'orchestration.host.remove',
    params: { hostId }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  console.log(chalk.green(`Remote host removed: ${hostId}`));
  process.exit(0);
}

async function toggleRemoteHost(client: DaemonClient, hostId: string): Promise<void> {
  // First get current state
  const listResult = await client.send({ method: 'orchestration.host.list' });
  if (listResult.error) {
    client.close();
    console.error(chalk.red(listResult.error));
    process.exit(1);
  }
  const hosts = (listResult.data as { hosts?: RemoteHostData[] }).hosts || [];
  const host = hosts.find(h => h.id === hostId);
  if (!host) {
    client.close();
    console.error(chalk.red('Host not found'));
    process.exit(1);
  }

  const newEnabled = !host.enabled;
  const result = await client.send({
    method: 'orchestration.host.toggle',
    params: { hostId, enabled: newEnabled }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  console.log(chalk.green(`Remote host ${hostId}: ${newEnabled ? 'enabled' : 'disabled'}`));
  process.exit(0);
}

async function listRemoteHosts(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'orchestration.host.list' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const hosts = (result.data as { hosts?: RemoteHostData[] }).hosts || [];

  if (hosts.length === 0) {
    console.log(chalk.gray('No remote hosts configured'));
    console.log(chalk.gray('Add one with: cb --remote-add <url> --remote-key <apiKey>'));
    process.exit(0);
  }

  console.log(chalk.bold('Remote Hosts:'));
  for (const host of hosts) {
    const status = host.enabled ? chalk.green('enabled') : chalk.gray('disabled');
    console.log(`  ${chalk.cyan(host.id)} [${status}] - ${chalk.yellow(host.name)}`);
    console.log(`    URL: ${chalk.gray(host.url)}`);
    console.log(`    Priority: ${chalk.gray(String(host.priority))}`);
  }
  process.exit(0);
}

async function showRemoteHealth(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'orchestration.health' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as unknown as HealthStatus;

  const overallStatus = data.overall.healthy ? chalk.green('HEALTHY') : chalk.red('UNHEALTHY');
  console.log(chalk.bold(`Overall Status: ${overallStatus}`));
  console.log(`  Healthy: ${chalk.cyan(data.overall.healthyPercentage.toFixed(1))}%`);
  console.log('');

  if (data.hosts.length === 0) {
    console.log(chalk.gray('No hosts to show'));
    process.exit(0);
  }

  console.log(chalk.bold('Host Health:'));
  for (const host of data.hosts) {
    const status = host.healthy ? chalk.green('healthy') : chalk.red('unhealthy');
    console.log(`  ${chalk.cyan(host.hostId)} [${status}]`);
    console.log(`    Uptime: ${chalk.gray(host.uptime.toFixed(1) + '%')}`);
    console.log(`    Avg Latency: ${chalk.gray(host.avgLatency.toFixed(0) + 'ms')}`);
    console.log(`    P99 Latency: ${chalk.gray(host.p99Latency.toFixed(0) + 'ms')}`);
    console.log(`    Success Rate: ${chalk.gray(host.successRate.toFixed(1) + '%')}`);
    if (host.lastError) {
      console.log(`    Last Error: ${chalk.red(host.lastError)}`);
    }
  }
  process.exit(0);
}

async function showOrchestrationStats(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'orchestration.stats' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as unknown as OrchestrationStats;

  console.log(chalk.bold('Orchestration Statistics:'));
  console.log('');
  console.log(chalk.bold('  Hosts:'));
  console.log(`    Total: ${chalk.cyan(data.hosts.total)}`);
  console.log(`    Healthy: ${chalk.green(data.hosts.healthy)}`);
  console.log(`    Unhealthy: ${data.hosts.unhealthy > 0 ? chalk.red(data.hosts.unhealthy) : chalk.gray('0')}`);
  console.log('');
  console.log(chalk.bold('  Requests:'));
  console.log(`    Total: ${chalk.cyan(data.requests.total)}`);
  console.log(`    Successful: ${chalk.green(data.requests.successful)}`);
  console.log(`    Failed: ${data.requests.failed > 0 ? chalk.red(data.requests.failed) : chalk.gray('0')}`);
  console.log(`    Failovers: ${chalk.yellow(data.requests.failovers)}`);
  console.log('');
  console.log(chalk.bold('  Pipelines:'));
  console.log(`    Total: ${chalk.cyan(data.pipelines.total)}`);
  console.log(`    Completed: ${chalk.green(data.pipelines.completed)}`);
  console.log(`    Failed: ${data.pipelines.failed > 0 ? chalk.red(data.pipelines.failed) : chalk.gray('0')}`);
  console.log(`    Partial: ${chalk.yellow(data.pipelines.partial)}`);

  const cbEntries = Object.entries(data.circuitBreakers);
  if (cbEntries.length > 0) {
    console.log('');
    console.log(chalk.bold('  Circuit Breakers:'));
    for (const [hostId, cb] of cbEntries) {
      const stateColor = cb.state === 'closed' ? chalk.green : cb.state === 'open' ? chalk.red : chalk.yellow;
      console.log(`    ${hostId}: ${stateColor(cb.state)} (${cb.failures} failures)`);
    }
  }
  process.exit(0);
}

async function sendRemotePrompt(client: DaemonClient, hostId: string, prompt: string): Promise<void> {
  console.log(chalk.gray(`Sending prompt to remote host ${hostId}...`));
  const result = await client.send({
    method: 'orchestration.prompt',
    params: { hostId, prompt }
  });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as unknown as RemotePromptResult;

  console.log(chalk.green(`Prompt completed on ${data.host}`));
  console.log(chalk.gray(`  Session: ${data.sessionId}`));
  console.log(chalk.gray(`  Status: ${data.status}`));
  console.log(chalk.gray(`  Latency: ${data.latency}ms`));

  if (data.output) {
    console.log('');
    console.log(chalk.bold('Output:'));
    console.log(data.output);
  }

  if (data.error) {
    console.log('');
    console.error(chalk.red(`Error: ${data.error}`));
  }
  process.exit(0);
}

// Fire-and-forget functions
async function fireAndForgetPrompt(client: DaemonClient, prompt: string, goal?: string): Promise<void> {
  const result = await client.send({
    method: 'prompt.fire',
    params: { prompt, goal }
  });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  const data = result.data as { sessionId: string; promptId: string; goal: string };
  console.log(chalk.green('Task launched in background'));
  console.log(`  Session: ${chalk.cyan(data.sessionId)}`);
  console.log(`  Goal: ${chalk.gray(data.goal)}`);
  console.log('');
  console.log(chalk.gray('Check status:'));
  console.log(`  ${chalk.yellow('cb -i')}          ${chalk.gray('# notification inbox')}`);
  console.log(`  ${chalk.yellow('cb -l')}          ${chalk.gray('# view output')}`);
  console.log(`  ${chalk.yellow('cb -w')}          ${chalk.gray('# watch live')}`);
  process.exit(0);
}

async function fireRemotePrompt(client: DaemonClient, hostId: string, prompt: string, goal?: string): Promise<void> {
  const result = await client.send({
    method: 'orchestration.fire',
    params: { hostId, prompt, goal }
  });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  const data = result.data as { trackingId: string; goal: string };
  console.log(chalk.green('Remote task dispatched'));
  console.log(`  Host: ${chalk.cyan(hostId)}`);
  console.log(`  Goal: ${chalk.gray(data.goal)}`);
  console.log('');
  console.log(`  ${chalk.yellow('cb -i')}  ${chalk.gray('# check when done')}`);
  process.exit(0);
}

// Notification inbox functions
interface InboxNotification {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionName?: string;
  type: string;
  goal?: string;
  exitCode: number | null;
  durationMs?: number;
  costUsd?: number;
  resultPreview?: string;
  resultFull?: string;
  claudeSessionId?: string;
  viewCommand: string;
  read: boolean;
}

// Markdown-to-terminal renderer (chalk only, no deps)
function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(inCodeBlock ? chalk.gray('  ┌─') : chalk.gray('  └─'));
      continue;
    }

    if (inCodeBlock) {
      result.push(chalk.gray(`  │ ${line}`));
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      result.push(chalk.bold.dim(line.slice(4)));
      continue;
    }
    if (line.startsWith('## ')) {
      result.push(chalk.bold(line.slice(3)));
      continue;
    }
    if (line.startsWith('# ')) {
      result.push(chalk.bold.underline(line.slice(2)));
      continue;
    }

    // Blockquotes
    if (line.startsWith('> ')) {
      result.push(chalk.gray(`  │ ${line.slice(2)}`));
      continue;
    }

    // Unordered list items
    if (/^[-*] /.test(line)) {
      result.push(`  • ${renderInline(line.slice(2))}`);
      continue;
    }

    // Ordered list items
    const orderedMatch = line.match(/^(\d+)\. (.*)$/);
    if (orderedMatch) {
      result.push(`  ${orderedMatch[1]}. ${renderInline(orderedMatch[2])}`);
      continue;
    }

    // Regular line
    result.push(`  ${renderInline(line)}`);
  }

  return result.join('\n');
}

function renderInline(text: string): string {
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, (_, m) => chalk.bold(m));
  // Italic
  text = text.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, (_, m) => chalk.italic(m));
  // Inline code
  text = text.replace(/`([^`]+?)`/g, (_, m) => chalk.cyan(m));
  return text;
}

async function showInbox(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'notification.list', params: { unreadOnly: false } });

  if (result.error) {
    client.close();
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  const data = result.data as { notifications: InboxNotification[] };
  const notifications = [...(data.notifications || [])].reverse(); // newest first

  if (notifications.length === 0) {
    client.close();
    console.log(chalk.gray('No notifications'));
    process.exit(0);
  }

  let currentIndex = 0;

  function render(): void {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 80;
    const n = notifications[currentIndex];
    const total = notifications.length;
    const unreadCount = notifications.filter(x => !x.read).length;

    // Clear screen + move cursor home
    process.stdout.write('\x1b[2J\x1b[H');

    // Header
    const headerLeft = `── Inbox (${currentIndex + 1}/${total})${n.read ? '' : ' * unread'}`;
    const headerRight = unreadCount > 0 ? `${unreadCount} unread ──` : '──';
    console.log(chalk.bold(headerLeft) + chalk.gray(` ${'─'.repeat(Math.max(2, cols - headerLeft.length - headerRight.length - 2))} ${headerRight}`));
    console.log('');

    // Status + name + meta
    const statusIcon = n.type === 'prompt.completed' ? chalk.green('OK') : chalk.red('ERR');
    const duration = n.durationMs ? `${(n.durationMs / 1000).toFixed(1)}s` : '';
    const cost = n.costUsd ? `$${n.costUsd.toFixed(4)}` : '';
    const time = new Date(n.timestamp).toLocaleTimeString();

    console.log(`  ${statusIcon}  ${chalk.cyan.bold(n.sessionName || n.sessionId)}  ${chalk.gray(time)}  ${chalk.gray(duration)}  ${chalk.gray(cost)}`);

    if (n.goal) {
      console.log(`  ${chalk.gray('Goal:')} ${n.goal}`);
    }
    console.log('');

    // Render body — full result with markdown, or preview
    const bodyText = n.resultFull || n.resultPreview || '';
    if (bodyText) {
      const rendered = renderMarkdown(bodyText);
      // Cap output to terminal height minus header/footer lines
      const maxBodyLines = rows - 10;
      const bodyLines = rendered.split('\n');
      if (bodyLines.length > maxBodyLines) {
        console.log(bodyLines.slice(0, maxBodyLines).join('\n'));
        console.log(chalk.gray(`  ... (${bodyLines.length - maxBodyLines} more lines)`));
      } else {
        console.log(rendered);
      }
    } else {
      console.log(chalk.gray('  (no output)'));
    }

    console.log('');

    // Resume command
    if (n.claudeSessionId) {
      console.log(`  ${chalk.gray('Resume:')} ${chalk.yellow('cb "your follow-up here"')}`);
    } else {
      console.log(`  ${chalk.gray('View:')} ${chalk.yellow('cb -l')}`);
    }

    console.log('');

    // Footer
    const footer = '── n=next  p=prev  r=read  d=delete  q=quit ──';
    console.log(chalk.gray(footer));
  }

  function cleanup(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write('\x1b[2J\x1b[H');
    client.close();
  }

  // Enter raw mode for key input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  render();

  process.stdin.on('data', async (key: string) => {
    switch (key) {
      case 'n': case 'j': case '\x1b[C': case '\x1b[B': // next (n, j, right, down)
        if (currentIndex < notifications.length - 1) {
          currentIndex++;
          render();
        }
        break;

      case 'p': case 'k': case '\x1b[D': case '\x1b[A': // prev (p, k, left, up)
        if (currentIndex > 0) {
          currentIndex--;
          render();
        }
        break;

      case 'r': { // mark read
        const n = notifications[currentIndex];
        if (!n.read) {
          await client.send({ method: 'notification.markRead', params: { id: n.id } });
          n.read = true;
          render();
        }
        break;
      }

      case 'd': { // delete
        const n = notifications[currentIndex];
        await client.send({ method: 'notification.delete', params: { id: n.id } });
        notifications.splice(currentIndex, 1);
        if (notifications.length === 0) {
          cleanup();
          console.log(chalk.gray('No more notifications'));
          process.exit(0);
        }
        if (currentIndex >= notifications.length) {
          currentIndex = notifications.length - 1;
        }
        render();
        break;
      }

      case 'q': case '\x03': // quit (q, Ctrl+C)
        cleanup();
        process.exit(0);
        break;

      default:
        // Ignore Esc alone and other keys
        if (key === '\x1b') {
          cleanup();
          process.exit(0);
        }
        break;
    }
  });

  // Keep alive until user quits
  await new Promise<void>(() => {});
}

async function clearInbox(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'notification.clear' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as { cleared: number };
  console.log(chalk.green(`Marked ${data.cleared} notification${data.cleared !== 1 ? 's' : ''} as read`));
  process.exit(0);
}

async function showInboxCount(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'notification.count' });
  client.close();
  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }
  const data = result.data as { total: number; unread: number };
  if (data.unread > 0) {
    console.log(chalk.yellow(`${data.unread} unread notification${data.unread !== 1 ? 's' : ''} (${data.total} total)`));
    console.log(chalk.gray('View with: cb -i'));
  } else {
    console.log(chalk.gray(`No unread notifications (${data.total} total)`));
  }
  process.exit(0);
}

// Telegram functions
async function setupTelegram(client: DaemonClient, token: string): Promise<void> {
  console.log(chalk.gray('Setting up Telegram bot...'));
  const result = await client.send({ method: 'telegram.setup', params: { token } });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  const data = result.data as { username?: string };
  console.log(chalk.green('Telegram bot started!'));
  if (data.username) {
    console.log(`  Bot: ${chalk.cyan(`@${data.username}`)}`);
  }
  console.log('');
  console.log(chalk.gray('Send /start to your bot in Telegram to register.'));
  process.exit(0);
}

async function stopTelegram(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'telegram.stop' });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  console.log(chalk.green('Telegram bot stopped and token cleared.'));
  process.exit(0);
}

async function showTelegramStatus(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'telegram.status' });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  const data = result.data as { running: boolean; enabled: boolean; chatIds: string[] };
  const status = data.running ? chalk.green('running') : chalk.gray('stopped');
  console.log(chalk.bold('Telegram Bot:'));
  console.log(`  Status: ${status}`);
  console.log(`  Enabled: ${data.enabled ? chalk.green('yes') : chalk.gray('no')}`);
  if (data.chatIds.length > 0) {
    console.log(`  Registered chats: ${chalk.cyan(data.chatIds.length.toString())}`);
  } else {
    console.log(chalk.gray('  No registered chats (send /start to your bot)'));
  }

  if (!data.running && !data.enabled) {
    console.log('');
    console.log(chalk.gray('Set up with: cb --telegram <token>'));
  }
  process.exit(0);
}

// Voice pipeline functions
async function setupVoicePipeline(client: DaemonClient, speechmaticsKey: string): Promise<void> {
  console.log(chalk.gray('Configuring Speechmatics API key...'));
  const result = await client.send({ method: 'voice.setup', params: { speechmaticsKey } });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  console.log(chalk.green('Speechmatics API key configured!'));
  console.log('');
  console.log(chalk.gray('Next: set up an AI provider for prompt optimization:'));
  console.log(chalk.gray('  cb --ai-provider anthropic <api-key>'));
  console.log(chalk.gray('  cb --ai-provider openrouter <api-key>'));
  process.exit(0);
}

async function setupVoiceAI(client: DaemonClient, provider: string, apiKey: string, model?: string): Promise<void> {
  console.log(chalk.gray(`Configuring AI provider (${provider})...`));
  const result = await client.send({ method: 'voice.ai', params: { provider, apiKey, model } });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  const data = result.data as { provider?: string; model?: string };
  console.log(chalk.green('AI provider configured!'));
  console.log(`  Provider: ${chalk.cyan(data.provider || provider)}`);
  console.log(`  Model: ${chalk.cyan(data.model || 'default')}`);
  console.log('');
  console.log(chalk.gray('Voice pipeline is ready. Send a voice message in Telegram!'));
  process.exit(0);
}

async function showVoiceStatus(client: DaemonClient): Promise<void> {
  const result = await client.send({ method: 'voice.status' });
  client.close();

  if (result.error) {
    console.error(chalk.red(result.error));
    process.exit(1);
  }

  const data = result.data as {
    speechmaticsConfigured?: boolean;
    aiProvider?: { provider: string; model: string } | null;
    pipelineActive?: boolean;
  };

  console.log(chalk.bold('Voice Pipeline:'));
  console.log(`  Speechmatics: ${data.speechmaticsConfigured ? chalk.green('configured') : chalk.gray('not configured')}`);

  if (data.aiProvider) {
    console.log(`  AI Provider: ${chalk.green(data.aiProvider.provider)} (${chalk.cyan(data.aiProvider.model)})`);
  } else {
    console.log(`  AI Provider: ${chalk.gray('not configured')}`);
  }

  console.log(`  Pipeline: ${data.pipelineActive ? chalk.green('active') : chalk.yellow('inactive')}`);

  if (!data.speechmaticsConfigured || !data.aiProvider) {
    console.log('');
    if (!data.speechmaticsConfigured) {
      console.log(chalk.gray('  Set up STT: cb --voice-setup <speechmatics-key>'));
    }
    if (!data.aiProvider) {
      console.log(chalk.gray('  Set up AI: cb --ai-provider <anthropic|openrouter> <api-key>'));
    }
  }
  process.exit(0);
}

// Handle stdin for piped input or parse arguments
const hasArgs = process.argv.length > 2;

if (!process.stdin.isTTY && !hasArgs) {
  // Piped input mode: read from stdin
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    if (input.trim()) {
      const client = new DaemonClient();
      sendPrompt(client, input.trim()).catch(console.error);
    } else {
      program.parse();
    }
  });
} else {
  // Normal mode: parse arguments
  program.parse();
}
