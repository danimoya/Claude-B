import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { RemoteClient } from './remote-client.js';

const tokens = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600 };
const completed = { promptId: 'prompt-test', status: 'completed', output: 'done' };

function json(response: ServerResponse, body: unknown) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

describe('remote request wall-clock deadline', () => {
  let server: Server;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  async function initialize(handler: (request: IncomingMessage, response: ServerResponse) => void) {
    server = createServer(handler);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback address');
    return new RemoteClient({
      id: 'test-host', name: 'test-host', url: `http://127.0.0.1:${address.port}`,
      apiKey: 'test-key', enabled: true, priority: 1,
      healthCheck: { timeout: 100, interval: 0, unhealthyThreshold: 1 }
    });
  }

  it('bounds stalled authentication and never submits the prompt afterwards', async () => {
    const paths: string[] = [];
    const client = await initialize(request => { paths.push(request.url!); });
    const result = await client.sendPrompt('session-test', 'prompt', { timeout: 100 });
    expect(result).toMatchObject({ status: 'error', error: 'Remote request timed out after 100ms' });
    expect(result.latency).toBeLessThan(1000);
    expect(paths).toEqual(['/api/auth/token']);
    expect(client.getStatus()).toMatchObject({ healthy: false, consecutiveFailures: 1 });
  });

  it('bounds a stalled authentication response body', async () => {
    const paths: string[] = [];
    const client = await initialize((request, response) => {
      paths.push(request.url!);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{');
    });
    const result = await client.sendPrompt('session-test', 'prompt', { timeout: 100 });
    expect(result.error).toBe('Remote request timed out after 100ms');
    expect(paths).toEqual(['/api/auth/token']);
  });

  it('bounds stalled refresh and does not fall back to new authentication after expiry', async () => {
    const paths: string[] = [];
    const client = await initialize((request, response) => {
      paths.push(request.url!);
      if (request.url === '/api/auth/token') json(response, { ...tokens, expires_in: 0 });
      else if (request.url === '/api/auth/refresh') return;
      else json(response, completed);
    });
    expect((await client.sendPrompt('session-test', 'first', { timeout: 1000 })).status).toBe('completed');
    const result = await client.sendPrompt('session-test', 'second', { timeout: 100 });
    expect(result.error).toBe('Remote request timed out after 100ms');
    expect(paths).toEqual(['/api/auth/token', '/api/sessions/session-test/prompt', '/api/auth/refresh']);
  });

  it('shares the remaining budget between failed refresh, reauthentication and submission', async () => {
    let authCount = 0;
    const paths: string[] = [];
    const client = await initialize((request, response) => {
      paths.push(request.url!);
      if (request.url === '/api/auth/token') {
        authCount++;
        if (authCount === 1) json(response, { ...tokens, expires_in: 0 });
        else return; // The fallback authentication stalls under the existing deadline.
      } else if (request.url === '/api/auth/refresh') {
        response.writeHead(401);
        response.end('expired');
      } else json(response, completed);
    });
    await client.sendPrompt('session-test', 'first', { timeout: 1000 });
    const result = await client.sendPrompt('session-test', 'second', { timeout: 100 });
    expect(result.error).toBe('Remote request timed out after 100ms');
    expect(paths).toEqual([
      '/api/auth/token', '/api/sessions/session-test/prompt', '/api/auth/refresh', '/api/auth/token'
    ]);
  });

  it('bounds the submitted POST response body without retrying uncertain work', async () => {
    let submissions = 0;
    const client = await initialize((request, response) => {
      if (request.url === '/api/auth/token') return json(response, tokens);
      submissions++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"promptId":"accepted-but-response-incomplete"');
    });
    const result = await client.sendPrompt('session-test', 'once', { timeout: 100 });
    expect(result.error).toBe('Remote request timed out after 100ms');
    expect(submissions).toBe(1);
    expect(result.promptId).toBe('');
  });

  it('honors the configured health-check budget during authentication', async () => {
    const client = await initialize(() => {});
    const start = Date.now();
    await expect(client.healthCheck()).rejects.toThrow('Remote request timed out after 100ms');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('clears the deadline timer on success and authentication failure', async () => {
    const cleared = vi.spyOn(globalThis, 'clearTimeout');
    let authenticate = true;
    const client = await initialize((request, response) => {
      if (request.url === '/api/auth/token') {
        if (authenticate) return json(response, tokens);
        response.writeHead(401);
        return response.end('invalid key');
      }
      return json(response, completed);
    });
    const result = await client.sendPrompt('session-test', 'prompt', { timeout: 1000 });
    expect(result.status).toBe('completed');
    const afterSuccess = cleared.mock.calls.length;
    expect(afterSuccess).toBeGreaterThan(0);
    authenticate = false;
    const failed = new RemoteClient({
      id: 'other-host', name: 'other-host', url: client.getStatus().url,
      apiKey: 'test-key', enabled: true, priority: 1
    });
    expect((await failed.sendPrompt('session-test', 'prompt', { timeout: 1000 })).error)
      .toBe('Authentication failed: 401');
    expect(cleared.mock.calls.length).toBeGreaterThan(afterSuccess);
  });
});
