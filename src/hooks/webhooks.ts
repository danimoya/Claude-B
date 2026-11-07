// Webhook HTTP calls

import { createHmac, randomUUID } from 'node:crypto';
import { HookEvent, HookEventType } from './events.js';

export interface Webhook {
  id: string;
  event: HookEventType | '*';  // '*' matches all events
  url: string;
  method?: 'POST' | 'PUT';  // default POST
  headers?: Record<string, string>;
  timeout?: number;  // milliseconds, default 10000
  retries?: number;  // default 2, maximum 5
  secret?: string;  // optional per-webhook HMAC-SHA256 signing secret
  transform?: string;  // JavaScript expression to transform payload
  sessionFilter?: string;  // only trigger for this sessionId
  enabled: boolean;
  createdAt: string;
}

export interface WebhookResult {
  retryable?: boolean;
  retryAfterMs?: number;
  webhookId: string;
  success: boolean;
  statusCode: number | null;
  response: string;
  duration: number;
  retryCount: number;
}

// Transform payload using a simple expression
function transformPayload(event: HookEvent, transform?: string): Record<string, unknown> {
  if (!transform) {
    return {
      event: event.type,
      timestamp: event.timestamp,
      ...event.payload
    };
  }

  try {
    // Create a safe context for transformation
    // Format: "payload.field" or "{ custom: payload.field }"
    const payload = event.payload as Record<string, unknown>;

    // Simple field access: "output" -> payload.output
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(transform)) {
      return { data: payload[transform] };
    }

    // Object literal: "{ prompt: payload.output }"
    if (transform.startsWith('{') && transform.endsWith('}')) {
      // Very limited safe eval - only allow object literals with payload access
      const inner = transform.slice(1, -1).trim();
      const result: Record<string, unknown> = {};

      // Parse simple key: value pairs
      const pairs = inner.split(',').map(p => p.trim());
      for (const pair of pairs) {
        const [key, value] = pair.split(':').map(s => s.trim());
        if (key && value) {
          // Handle payload.field syntax
          if (value.startsWith('payload.')) {
            const field = value.slice(8);
            result[key] = payload[field];
          } else if (value.startsWith('"') && value.endsWith('"')) {
            // String literal
            result[key] = value.slice(1, -1);
          } else if (value === 'event.type') {
            result[key] = event.type;
          } else if (value === 'event.timestamp') {
            result[key] = event.timestamp;
          } else {
            result[key] = value;
          }
        }
      }
      return result;
    }

    // Default: wrap original payload
    return {
      event: event.type,
      timestamp: event.timestamp,
      ...payload
    };
  } catch {
    // On error, return original payload
    return {
      event: event.type,
      timestamp: event.timestamp,
      ...event.payload
    };
  }
}

const MAX_RETRIES = 5;
const MAX_BACKOFF_MS = 10000;

function retryDelay(retryAfter: string | null, attempt: number): number {
  let delay = 1000 * Math.pow(2, attempt);
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    const requested = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(requested) && requested >= 0) delay = Math.max(delay, requested);
  }
  return Math.min(delay, MAX_BACKOFF_MS);
}

async function makeRequest(
  webhook: Webhook,
  body: string,
  headers: Headers,
  timeout: number,
  signal?: AbortSignal
): Promise<{ statusCode: number; response: string; retryAfter: string | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  try {
    const response = await fetch(webhook.url, {
      method: webhook.method || 'POST',
      headers,
      body,
      signal: controller.signal,
      // Do not forward payloads or signing credentials to redirect destinations.
      redirect: 'manual'
    });

    // Keep the deadline active while consuming the response body too.
    let responseText: string;
    try { responseText = await response.text(); }
    catch (error) {
      // A known terminal HTTP rejection stays terminal even if reading its
      // diagnostic body fails. Never turn HTTP 400 into a network retry.
      if (response.status >= 300 && response.status < 500 && response.status !== 429) responseText = 'Response body unavailable';
      else throw error;
    }
    if (responseText.length > 10000) {
      responseText = responseText.slice(0, 10000) + '...(truncated)';
    }

    return {
      statusCode: response.status,
      response: responseText,
      retryAfter: response.headers.get('retry-after')
    };
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abort);
  }
}

function waitForRetry(delay: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Webhook delivery aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('Webhook delivery aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function executeWebhook(
  webhook: Webhook,
  event: HookEvent,
  signal?: AbortSignal
): Promise<WebhookResult> {
  const startTime = Date.now();
  const timeout = Number.isFinite(webhook.timeout) && webhook.timeout! > 0
    ? Math.min(webhook.timeout!, 60000) : 10000;
  const requestedRetries = webhook.retries ?? 2;
  const maxRetries = Number.isFinite(requestedRetries)
    ? Math.max(0, Math.min(MAX_RETRIES, Math.floor(requestedRetries))) : 2;

  // Serialize once: metadata, signature and exact transmitted bytes stay stable
  // across attempts, including when a payload transform is configured.
  const eventId = event.id ?? randomUUID();
  const body = JSON.stringify({
    ...transformPayload(event, webhook.transform),
    eventId,
    timestamp: event.timestamp
  });
  const headers = new Headers(webhook.headers);
  headers.set('Content-Type', 'application/json');
  headers.set('User-Agent', 'Claude-B/0.7.0');
  headers.set('X-Claude-B-Event-Id', eventId);
  headers.set('X-Claude-B-Timestamp', event.timestamp);
  // Reserved metadata cannot be overridden through custom headers, even with
  // differently cased names. Unsigned webhooks never carry a static signature.
  headers.delete('X-Claude-B-Signature');
  if (webhook.secret) {
    headers.set('X-Claude-B-Signature',
      `sha256=${createHmac('sha256', webhook.secret).update(body).digest('hex')}`);
  }

  const aborted = (attempt: number): WebhookResult => ({ webhookId: webhook.id,
    success: false, retryable: true, statusCode: null, response: 'Webhook delivery aborted',
    duration: Date.now() - startTime, retryCount: attempt });
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) return aborted(attempt);
    let retryAfter: string | null = null;
    try {
      const result = await makeRequest(webhook, body, headers, timeout, signal);
      const retryable = result.statusCode === 429 || result.statusCode >= 500;
      if (!retryable || attempt === maxRetries) {
        return {
          webhookId: webhook.id,
          success: result.statusCode >= 200 && result.statusCode < 300,
          retryable,
          retryAfterMs: retryable ? retryDelay(result.retryAfter, attempt) : undefined,
          statusCode: result.statusCode,
          response: result.response,
          duration: Date.now() - startTime,
          retryCount: attempt
        };
      }
      retryAfter = result.retryAfter;
    } catch (error) {
      if (signal?.aborted) return aborted(attempt);
      if (attempt === maxRetries) {
        return {
          webhookId: webhook.id,
          success: false,
          retryable: true,
          retryAfterMs: retryDelay(null, attempt),
          statusCode: null,
          response: error instanceof Error ? error.message : String(error),
          duration: Date.now() - startTime,
          retryCount: attempt
        };
      }
    }

    try { await waitForRetry(retryDelay(retryAfter, attempt), signal); }
    catch { return aborted(attempt); }
  }
}
