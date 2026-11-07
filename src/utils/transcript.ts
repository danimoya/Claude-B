import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export interface TranscriptTurn { role: 'user' | 'assistant'; text: string }
type Row = Record<string, unknown>;
function row(value: unknown): Row | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap(item => {
    const part = row(item);
    return part && ['text', 'input_text', 'output_text'].includes(String(part.type)) &&
      !part.synthetic && typeof part.text === 'string' ? [part.text] : [];
  }).join('\n');
}

function extract(value: unknown): TranscriptTurn[] {
  if (Array.isArray(value)) return value.flatMap(extract);
  const item = row(value);
  if (!item) return [];
  if (Array.isArray(item.messages)) return item.messages.flatMap(extract);
  if (item.type === 'event_msg') {
    const payload = row(item.payload);
    const role = payload?.type === 'user_message' ? 'user' : payload?.type === 'agent_message' ? 'assistant' : undefined;
    return role && typeof payload?.message === 'string' ? [{ role, text: payload.message }] : [];
  }
  let message: Row | undefined;
  let text = '';
  if (item.type === 'response_item') {
    message = row(item.payload);
    if (message?.type !== 'message') return [];
    text = contentText(message.content);
  } else if (row(item.info)) {
    // OpenCode session.messages/export envelope: {info:{role},parts:[...]}.
    message = row(item.info);
    text = contentText(item.parts);
  } else {
    message = row(item.message) || item;
    text = contentText(message.content);
  }
  const role = message?.role || item.type;
  return role === 'user' || role === 'assistant' ? [{ role, text }] : [];
}

/** Parse native text envelopes; tool results, reasoning and synthetic context are excluded. */
export function parseTranscript(raw: string, turns = 3): TranscriptTurn[] {
  const limit = Math.max(0, Math.min(20, Math.floor(turns)));
  if (limit === 0) return [];
  let collected: TranscriptTurn[] = [];
  try { collected = extract(JSON.parse(raw)); }
  catch {
    for (const line of raw.split('\n')) {
      try { collected.push(...extract(JSON.parse(line))); } catch { /* partial/corrupt records are isolated */ }
    }
  }
  const normalized: TranscriptTurn[] = [];
  for (const turn of collected) {
    const text = turn.text.trim();
    if (!text || (turn.role === 'user' && /^<(?:environment_context|system-reminder|task-notification|tool_result|developer_instructions|user_instructions)\b/.test(text))) continue;
    const previous = normalized.at(-1);
    // Codex often records the same visible text in event_msg and response_item.
    if (previous?.role === turn.role && previous.text === text) continue;
    normalized.push({ role: turn.role, text });
  }
  const counts = { user: 0, assistant: 0 };
  const result: TranscriptTurn[] = [];
  for (let i = normalized.length - 1; i >= 0; i--) {
    const turn = normalized[i];
    if (counts[turn.role] >= limit) continue;
    counts[turn.role]++;
    result.push({ role: turn.role, text: turn.text.slice(0, 600) });
    if (counts.user === limit && counts.assistant === limit) break;
  }
  return result.reverse();
}

/** Bounded synchronous tail read, suitable for the daemon's synchronous context getter. */
export function readLastTurnsFromTranscript(path: string, turns = 3, maxBytes = 1024 * 1024): string {
  const fd = openSync(path, 'r');
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw new Error('Transcript must be a regular file');
    const length = Math.min(metadata.size, Math.max(1, Math.min(maxBytes, 4 * 1024 * 1024)));
    const bytes = Buffer.alloc(length);
    const offset = Math.max(0, metadata.size - length);
    const read = readSync(fd, bytes, 0, length, offset);
    let raw = bytes.subarray(0, read).toString('utf8');
    if (offset > 0) {
      const newline = raw.indexOf('\n');
      raw = newline < 0 ? '' : raw.slice(newline + 1);
    }
    return parseTranscript(raw, turns).map(turn => `${turn.role.toUpperCase()}: ${turn.text}`).join('\n\n');
  } finally { closeSync(fd); }
}
