import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHost, OrchestrationManager } from './manager.js';
import { RemoteClient, redactRemoteHost } from './remote-client.js';
import { registerOrchestrationRoutes } from '../rest/routes/orchestration.js';
import { TelegramConfigManager } from '../telegram/config.js';

describe('credential serialization', () => {
  let dir: string;
  let manager: OrchestrationManager;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-credentials-'));
    await writeFile(join(dir, 'orchestration.json'), JSON.stringify({
      hosts: [], healthCheck: { enabled: false, interval: 30000, timeout: 5000 }
    }), { mode: 0o666 });
    manager = new OrchestrationManager(dir);
    await manager.load();
    app = Fastify();
    app.decorate('authenticate', async () => {});
    await registerOrchestrationRoutes(app, manager);
  });

  afterEach(async () => {
    await app.close();
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('omits API keys from added/listed REST hosts and client health snapshots', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/orchestration/hosts', payload: {
      url: 'https://receiver.invalid', apiKey: 'private-test-api-key', name: 'remote'
    } });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private-test-api-key');
    expect(response.json().host).not.toHaveProperty('apiKey');
    const listed = await app.inject({ method: 'GET', url: '/api/orchestration/hosts' });
    expect(listed.json().hosts).toHaveLength(1);
    expect(listed.body).not.toContain('private-test-api-key');
    expect(manager.listHosts()[0]).not.toHaveProperty('apiKey');
    const stored = JSON.parse(await readFile(join(dir, 'orchestration.json'), 'utf8'));
    const client = new RemoteClient(stored.hosts[0]);
    expect(client.getStatus()).not.toHaveProperty('apiKey');
    expect((await stat(join(dir, 'orchestration.json'))).mode & 0o777).toBe(0o600);
  });

  it('removes legacy embedded URL credentials and known secrets from public errors', () => {
    const raw = { id: 'legacy', name: 'legacy', url: 'https://user:password@example.invalid/path?token=secret#fragment', apiKey: 'private-key', enabled: true, priority: 1 };
    const client = new RemoteClient(raw);
    (client as unknown as { status: { lastError: string } }).status.lastError =
      'HTTP failure private-key at https://user:password@example.invalid/path?token=secret';
    expect(redactRemoteHost(raw).url).toBe('https://example.invalid/path');
    const serialized = JSON.stringify(client.getStatus());
    for (const secret of ['private-key', 'password', 'token=secret', 'user:']) expect(serialized).not.toContain(secret);
  });

  it.each(['https://user:password@example.invalid', 'https://example.invalid?token=secret', 'file:///tmp/secret'])
  ('rejects new hosts with embedded credentials or unsupported URL shape', url => {
    expect(() => createHost(url, 'test-key')).toThrow('Remote URL must use HTTP(S)');
  });

  it('keeps Telegram bot/provider credentials owner readable on creation and legacy reload', async () => {
    const config = new TelegramConfigManager(dir);
    await config.load();
    await config.setToken('test-bot-token');
    await config.setSTTProvider({ provider: 'openai', apiKey: 'test-provider-key' });
    expect((await stat(join(dir, 'telegram.json'))).mode & 0o777).toBe(0o600);
    await writeFile(join(dir, 'telegram.json'), JSON.stringify(config.get()));
    await chmod(join(dir, 'telegram.json'), 0o666);
    await config.load();
    expect((await stat(join(dir, 'telegram.json'))).mode & 0o777).toBe(0o600);
  });
});
