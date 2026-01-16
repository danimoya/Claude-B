#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { DaemonClient } from '../daemon/client.js';
import { version } from '../utils/version.js';

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
  enabled: boolean;
  createdAt: string;
}

interface WebhookData {
  id: string;
  event: string;
  url: string;
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
  .option('-k, --kill <id>', 'Kill/terminate session')
  .option('-w, --watch', 'Watch live output (tail -f style)')
  .option('-x, --select <id>', 'Select session for subsequent commands')
  .option('-c, --current', 'Show current selected session')
  .option('-r, --rest [port]', 'Start REST API server')
  .option('--rest-stop', 'Stop REST API server')
  .option('--status', 'Daemon status and health')
  .option('--logs', 'View daemon logs')
  .option('--hook <event> <cmd>', 'Register shell hook for event')
  .option('--unhook <id>', 'Remove a shell hook')
  .option('--hooks', 'List all shell hooks')
  .option('--webhook <url>', 'Register webhook for notifications')
  .option('--webhook-event <event>', 'Event type for webhook (default: *)')
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
        await createSession(client, name);
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
          return;
        }
        const event = options.hook;
        const command = args.join(' ');
        await addShellHook(client, event, command);
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
        await addWebhook(client, event, options.webhook);
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

      // If we have a prompt, send it
      if (promptParts.length > 0) {
        const prompt = promptParts.join(' ');
        await sendPrompt(client, prompt);
        return;
      }

      // No arguments - show help
      program.help();
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('ECONNREFUSED') || error.message.includes('ENOENT')) {
          console.error(chalk.yellow('Daemon not running. Starting daemon...'));
          await startDaemon();
          // Retry the command
          console.log(chalk.green('Daemon started. Please retry your command.'));
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

async function createSession(client: DaemonClient, name?: string): Promise<void> {
  const result = await client.send({ method: 'session.create', params: { name } });
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
  client.on('output', (outputData: { content: string }) => {
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

// Hook management functions
async function addShellHook(client: DaemonClient, event: string, command: string): Promise<void> {
  const result = await client.send({
    method: 'hook.shell.add',
    params: { event, command }
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
  }
  process.exit(0);
}

async function addWebhook(client: DaemonClient, event: string, url: string): Promise<void> {
  const result = await client.send({
    method: 'hook.webhook.add',
    params: { event, url }
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
