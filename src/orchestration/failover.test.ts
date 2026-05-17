import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RestServer } from '../rest/server.js';
import { SessionManager } from '../daemon/session-manager.js';
import { HookEngine } from '../hooks/engine.js';
import { RemoteClientManager, type RemoteHost } from './remote-client.js';
import { FailoverHandler } from './failover.js';
import { rm, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

interface ServerCtx {
  server: RestServer;
  sm: SessionManager;
  he: HookEngine;
  dir: string;
  url: string;
  apiKey: string;
}

async function startServer(label: string): Promise<ServerCtx> {
  const dir = join(tmpdir(), `claude-b-failover-test-${label}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const sm = new SessionManager(dir);
  await sm.load();
  const he = new HookEngine(dir);
  await he.load();
  const server = new RestServer({
    host: '127.0.0.1',
    port: 0,
    sessionManager: sm,
    hookEngine: he,
    configDir: dir
  });
  const url = await server.start();
  const apiKey = server.getAuthManager().getApiKey();
  if (!apiKey) throw new Error('test setup: no API key');
  return { server, sm, he, dir, url, apiKey };
}

async function stopServer(ctx: ServerCtx) {
  await ctx.server.stop();
  await ctx.sm.stopAll();
  await rm(ctx.dir, { recursive: true, force: true });
}

describe('FailoverHandler — preferredHost routing', () => {
  let gb: ServerCtx;
  let ca: ServerCtx;
  let manager: RemoteClientManager;
  let failover: FailoverHandler;

  beforeEach(async () => {
    gb = await startServer('gb');
    ca = await startServer('ca');

    manager = new RemoteClientManager();
    const gbHost: RemoteHost = {
      id: 'JXqlNCzL', name: 'gb', url: gb.url, apiKey: gb.apiKey,
      enabled: true, priority: 1
    };
    const caHost: RemoteHost = {
      id: 'Yh2nw4Ze', name: 'ca', url: ca.url, apiKey: ca.apiKey,
      enabled: true, priority: 1
    };
    manager.addHost(gbHost);
    manager.addHost(caHost);

    failover = new FailoverHandler(manager, {
      strategy: 'priority',
      maxAttempts: 3,
      timeout: 5000,
      retry: { maxRetries: 0, initialDelay: 1, maxDelay: 1, backoffMultiplier: 1, jitter: false }
    });
  });

  afterEach(async () => {
    await stopServer(gb);
    await stopServer(ca);
  });

  it('resolves preferredHost by NAME, not just id (regression: cb --remote-fire <name>)', async () => {
    // Regression for `cb --remote-fire ca` routing every dispatch to gb.
    // The CLI passes the user-facing name ("ca"), but selectHosts() only
    // matched on id (`Yh2nw4Ze`), so the lookup missed and the failover
    // fell through to the default-ordered host (gb).
    const { host, attempts } = await failover.executeWithFailover(
      async (client) => client.getStatus().name,
      { preferredHost: 'ca' }
    );

    expect(host).toBe('Yh2nw4Ze');
    expect(attempts).toBe(1);
  });

  it('still resolves preferredHost by id (backwards compatibility)', async () => {
    const { host } = await failover.executeWithFailover(
      async (client) => client.getStatus().name,
      { preferredHost: 'JXqlNCzL' }
    );

    expect(host).toBe('JXqlNCzL');
  });

  it('routes by name to gb when preferredHost="gb"', async () => {
    const { host } = await failover.executeWithFailover(
      async (client) => client.getStatus().name,
      { preferredHost: 'gb' }
    );

    expect(host).toBe('JXqlNCzL');
  });

  it('falls back to default ordering when preferredHost matches nothing', async () => {
    // Unknown name should not blow up — just fall through to strategy-based
    // selection. With priority strategy and tied priorities, order is
    // insertion order (gb added first).
    const { host } = await failover.executeWithFailover(
      async (client) => client.getStatus().name,
      { preferredHost: 'nonexistent-host' }
    );

    expect(['JXqlNCzL', 'Yh2nw4Ze']).toContain(host);
  });
});
