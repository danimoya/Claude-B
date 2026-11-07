import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createEvent } from './events.js';
import { executeWebhook, type Webhook } from './webhooks.js';

const webhook: Webhook = {
  id: 'hook-1', event: 'prompt.completed', url: 'https://receiver.invalid/hooks',
  enabled: true, createdAt: '2026-11-07T00:00:00.000Z'
};

const event = () => createEvent('prompt.completed', {
  sessionId: 'tmux:test', promptId: 'prompt-1', status: 'completed', output: 'Done ✓'
});

describe('webhook delivery', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-07T00:00:00.000Z'));
    fetchMock = vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('signs the actual transformed UTF-8 bytes and includes stable replay metadata', async () => {
    const original = event();
    await executeWebhook({ ...webhook, secret: 'test-only-secret', transform: 'output' }, original);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    const body = options.body as string;
    const headers = options.headers as Headers;
    expect(JSON.parse(body)).toEqual({
      data: 'Done ✓', eventId: original.id, timestamp: original.timestamp
    });
    expect(headers.get('x-claude-b-event-id')).toBe(original.id);
    expect(headers.get('x-claude-b-timestamp')).toBe(original.timestamp);
    expect(headers.get('x-claude-b-signature')).toBe(
      `sha256=${createHmac('sha256', 'test-only-secret').update(body).digest('hex')}`
    );
    expect(options.redirect).toBe('manual');
  });

  it('overrides reserved headers case insensitively and omits signatures without a secret', async () => {
    const original = event();
    await executeWebhook({ ...webhook, headers: {
      'x-claude-b-event-id': 'forged', 'x-claude-b-timestamp': 'forged',
      'x-claude-b-signature': 'static-is-not-signing', 'X-Custom': 'preserved'
    } }, original);
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('x-claude-b-event-id')).toBe(original.id);
    expect(headers.get('x-claude-b-timestamp')).toBe(original.timestamp);
    expect(headers.has('x-claude-b-signature')).toBe(false);
    expect(headers.get('x-custom')).toBe('preserved');
  });

  it.each([429, 500, 503])('retries HTTP %s with default bounded exponential backoff', async status => {
    fetchMock.mockImplementation(async () => new Response('unavailable', { status }));
    const pending = executeWebhook({ ...webhook, secret: 'test-only-secret' }, event());
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ success: false, statusCode: status, retryCount: 2 });
    const requests = fetchMock.mock.calls.map(call => call[1]);
    expect(new Set(requests.map(request => request.body)).size).toBe(1);
    expect(new Set(requests.map(request => request.headers.get('x-claude-b-signature'))).size).toBe(1);
  });

  it('retries network errors and reports successful retry count', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection reset'));
    const pending = executeWebhook(webhook, event());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ success: true, statusCode: 200, retryCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports the final network failure after exhausting retries', async () => {
    fetchMock.mockRejectedValue(new Error('connection reset'));
    const pending = executeWebhook(webhook, event());
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      success: false, statusCode: null, response: 'connection reset', retryCount: 2
    });
  });

  it.each([400, 401, 404, 422, 302])('does not retry HTTP %s', async status => {
    fetchMock.mockResolvedValue(new Response('rejected', { status }));
    const result = await executeWebhook(webhook, event());
    expect(result).toMatchObject({ success: false, statusCode: status, retryCount: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['network', 'status'])('allows explicit zero retries for %s failures', async failure => {
    if (failure === 'network') fetchMock.mockRejectedValue(new Error('offline'));
    else fetchMock.mockResolvedValue(new Response('busy', { status: 503 }));
    expect(await executeWebhook({ ...webhook, retries: 0 }, event())).toMatchObject({
      success: false, retryCount: 0
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['seconds', 'date'])('honors Retry-After using %s', async format => {
    const retryAfter = format === 'seconds' ? '3' : new Date(Date.now() + 3000).toUTCString();
    fetchMock.mockResolvedValueOnce(new Response('busy', {
      status: 429, headers: { 'Retry-After': retryAfter }
    }));
    const pending = executeWebhook(webhook, event());
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ success: true, retryCount: 1 });
  });

  it('caps Retry-After delay and retry count even for unchecked stored config', async () => {
    fetchMock.mockImplementation(async () => new Response('busy', {
      status: 503, headers: { 'Retry-After': '999999' }
    }));
    const pending = executeWebhook({ ...webhook, retries: 1000 }, event());
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ success: false, retryCount: 5, duration: 50000 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('keeps timeout active while consuming the response body', async () => {
    fetchMock.mockImplementation(async (_url: string, options: RequestInit) => ({
      status: 200,
      headers: new Headers(),
      text: () => new Promise((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(new Error('body timed out')));
      })
    }));
    const pending = executeWebhook({ ...webhook, timeout: 25, retries: 0 }, event());
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toMatchObject({ success: false, response: 'body timed out', retryCount: 0 });
  });

  it('assigns unique IDs to separate events', () => {
    expect(event().id).not.toBe(event().id);
  });
});
