import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotificationInbox, type NotificationInput } from './inbox.js';
import { NotificationOutbox } from './outbox.js';

const io = vi.hoisted(() => ({
  events: [] as string[], blockedPath: undefined as string | undefined,
  gate: undefined as Promise<void> | undefined, release: undefined as (() => void) | undefined,
  failPath: undefined as string | undefined, failures: 0,
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const file = await actual.open(...args);
    const sync = file.sync.bind(file);
    file.sync = async () => {
      const path = String(args[0]);
      io.events.push(`begin:${path}`);
      if (path === io.blockedPath && io.gate) await io.gate;
      if (path === io.failPath && io.failures-- > 0) throw new Error('simulated flush failure');
      await sync();
      io.events.push(`end:${path}`);
    };
    return file;
  } };
});

const notification = (id: string): NotificationInput => ({
  sessionId: 'session', promptId: id, deliveryId: `task:${id}`,
  type: 'prompt.completed', exitCode: 0, resultFull: id, viewCommand: `cb --task ${id}`,
});

describe('durable shared notification inbox', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-inbox-'));
    io.events = [];io.blockedPath = undefined;io.gate = undefined;
    io.failPath = undefined;io.failures = 0;io.release = undefined;
  });
  afterEach(async () => {
    io.release?.();
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('flushes appended data and its directory before resolving and atomically flushes rewrites', async () => {
    const inbox = new NotificationInbox(dir);
    const entry = await inbox.addNotification(notification('first'));
    const file = join(dir, 'notifications.jsonl');
    expect(io.events.indexOf(`end:${file}`)).toBeLessThan(io.events.indexOf(`end:${dir}`));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    io.events = [];
    await inbox.markRead(entry.id);
    expect(io.events.some(event => event.startsWith(`end:${dir}/.notifications.jsonl.`))).toBe(true);
    expect(io.events).toContain(`end:${dir}`);
    expect(JSON.parse((await readFile(file, 'utf8')).trim()).read).toBe(true);
  });

  it('deduplicates concurrent appends across separate objects sharing a directory', async () => {
    const first = new NotificationInbox(dir);
    const second = new NotificationInbox(join(dir, '.'));
    const records = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? first : second).addNotification(notification('same'))));
    expect(new Set(records.map(record => record.id)).size).toBe(1);
    expect(await first.getAll()).toHaveLength(1);
  });

  it('serializes rewrites with another object’s appends without dropping new entries', async () => {
    const first = new NotificationInbox(dir);
    const second = new NotificationInbox(dir);
    await Promise.all(Array.from({ length: 10 }, (_, index) => first.addNotification(notification(`old-${index}`))));
    await Promise.all([first.markAllRead(), ...Array.from({ length: 10 }, (_, index) => second.addNotification(notification(`new-${index}`)))]);
    await Promise.all([second.deleteAll({ onlyRead: true }), first.addNotification(notification('last'))]);
    const records = await second.getAll();
    expect(records).toHaveLength(11);
    expect(records.every(record => !record.read && !record.promptId?.startsWith('old-'))).toBe(true);
  });

  it('does not acknowledge outbox delivery before the append fsync finishes', async () => {
    const inbox = new NotificationInbox(dir);
    const box = new NotificationOutbox(dir, { inbox: { deliver: input => inbox.addNotification(input) } });
    io.blockedPath = join(dir, 'notifications.jsonl');
    io.gate = new Promise<void>(resolve => { io.release = resolve; });
    await box.enqueue(notification('flush-gated'));
    const draining = box.drain();
    try {
      await vi.waitFor(() => expect(io.events).toContain(`begin:${io.blockedPath}`));
      expect((await box.list())[0].delivered).not.toContain('inbox');
    } finally {
      io.release!();
      await draining;
    }
    expect((await box.list())[0].delivered).toContain('inbox');
  });

  it('reflushes an uncertain prior append before acknowledging its deduplicated retry', async () => {
    const inbox = new NotificationInbox(dir);
    const box = new NotificationOutbox(dir, { inbox: { deliver: input => inbox.addNotification(input) } });
    io.failPath = join(dir, 'notifications.jsonl');io.failures = 1;
    await box.enqueue(notification('uncertain'));
    await box.drain();
    expect((await box.list())[0].delivered).not.toContain('inbox');
    expect(await inbox.getAll()).toHaveLength(1);
    await box.drain(true);
    expect((await box.list())[0].delivered).toContain('inbox');
    expect(await inbox.getAll()).toHaveLength(1);
    expect(io.events.filter(event => event === `begin:${io.failPath}`)).toHaveLength(2);
    expect(io.events).toContain(`end:${dir}`);
  });

  it('isolates schema-corrupt JSON rows without logging private record contents', async () => {
    const inbox = new NotificationInbox(dir);
    const first = await inbox.addNotification(notification('good'));
    const path = join(dir, 'notifications.jsonl');
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeFile(path, JSON.stringify(first) + '\nnull\n[]\n' + JSON.stringify({ id: 'private-record', resultFull: 'secret-private-output' }) + '\n');
    expect(await inbox.getAll()).toEqual([first]);
    expect((await inbox.addNotification(notification('good'))).id).toBe(first.id);
    await inbox.markRead(first.id);
    expect((await inbox.getAll())[0].read).toBe(true);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('skipped 3 malformed line(s)'));
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('private-record');
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('secret-private-output');
  });
});
