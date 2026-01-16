// Webhook HTTP calls

import { HookEvent, HookEventType } from './events.js';

export interface Webhook {
  id: string;
  event: HookEventType | '*';  // '*' matches all events
  url: string;
  method?: 'POST' | 'PUT';  // default POST
  headers?: Record<string, string>;
  timeout?: number;  // milliseconds, default 10000
  retries?: number;  // default 0
  transform?: string;  // JavaScript expression to transform payload
  sessionFilter?: string;  // only trigger for this sessionId
  enabled: boolean;
  createdAt: string;
}

export interface WebhookResult {
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

async function makeRequest(
  webhook: Webhook,
  body: Record<string, unknown>,
  timeout: number
): Promise<{ statusCode: number; response: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(webhook.url, {
      method: webhook.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Claude-B/0.1.0',
        ...webhook.headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    let responseText = '';
    try {
      responseText = await response.text();
      // Limit response size
      if (responseText.length > 10000) {
        responseText = responseText.slice(0, 10000) + '...(truncated)';
      }
    } catch {
      responseText = '';
    }

    return {
      statusCode: response.status,
      response: responseText
    };
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export async function executeWebhook(
  webhook: Webhook,
  event: HookEvent
): Promise<WebhookResult> {
  const startTime = Date.now();
  const timeout = webhook.timeout || 10000;
  const maxRetries = webhook.retries || 0;

  const body = transformPayload(event, webhook.transform);

  let lastError: Error | null = null;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const { statusCode, response } = await makeRequest(webhook, body, timeout);

      // Consider 2xx and 3xx as success
      const success = statusCode >= 200 && statusCode < 400;

      return {
        webhookId: webhook.id,
        success,
        statusCode,
        response,
        duration: Date.now() - startTime,
        retryCount
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      retryCount = attempt;

      // Wait before retry (exponential backoff)
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, Math.min(1000 * Math.pow(2, attempt), 10000)));
      }
    }
  }

  return {
    webhookId: webhook.id,
    success: false,
    statusCode: null,
    response: lastError?.message || 'Unknown error',
    duration: Date.now() - startTime,
    retryCount
  };
}
