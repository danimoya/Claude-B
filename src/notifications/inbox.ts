import { appendFile, readFile, writeFile, mkdir, unlink, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { nanoid } from 'nanoid';

export interface Notification {
  id: string;
  timestamp: string;
  sessionId: string;
  sessionName?: string;
  type: 'prompt.completed' | 'prompt.error' | 'remote.completed';
  goal?: string;
  exitCode: number | null;
  durationMs?: number;
  costUsd?: number;
  resultPreview?: string;
  resultFull?: string;         // full output (capped 50KB)
  claudeSessionId?: string;   // Claude Code session UUID for resume
  viewCommand: string;
  read: boolean;
}

export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'read'>;

/**
 * NotificationInbox — JSONL-backed message store.
 *
 * Three guarantees:
 *
 * 1. **Concurrent writes can't corrupt the file.** Every read-modify-write
 *    operation (markRead, markAllRead, deleteNotification, deleteAll, …)
 *    runs inside a per-instance promise chain (a tiny mutex). Two callers
 *    cannot interleave their `readAll → filter → writeAll` cycles.
 *
 * 2. **Writes are atomic.** `writeAll` writes to `notifications.jsonl.tmp`
 *    and renames it over the destination — readers see either the old
 *    file or the new file, never a partial.
 *
 * 3. **A single corrupt line doesn't poison the whole inbox.** `readAll`
 *    skips unparseable lines with a stderr warning instead of returning
 *    `[]` for the entire file (the previous behaviour, which silently
 *    blackholed every other notification when a single line had been
 *    truncated by a concurrent writer).
 */
export class NotificationInbox {
  private configDir: string;
  private inboxPath: string;
  private tmpPath: string;
  /** Tail of the per-instance write chain. Each mutating op chains onto it. */
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(configDir: string) {
    this.configDir = configDir;
    this.inboxPath = `${configDir}/notifications.jsonl`;
    this.tmpPath = `${configDir}/notifications.jsonl.tmp`;
  }

  /** Run an async fn under the write mutex; resolves with its result. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(fn, fn);
    // Make sure a rejection in `fn` doesn't break the chain for the next caller.
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  async addNotification(input: NotificationInput): Promise<Notification> {
    return this.withLock(async () => {
      await mkdir(this.configDir, { recursive: true });
      const notification: Notification = {
        ...input,
        id: nanoid(8),
        timestamp: new Date().toISOString(),
        read: false,
      };
      // Append is already atomic at the OS level — single short write — so
      // we don't need the rename trick here. Lock still serialises against
      // any concurrent rewrite to avoid a writer truncating mid-append.
      await appendFile(this.inboxPath, JSON.stringify(notification) + '\n');
      await this.writeMarker(notification);
      return notification;
    });
  }

  private async writeMarker(notification: Notification): Promise<void> {
    try {
      const markerPath = `${this.configDir}/inbox-new`;
      const label = notification.sessionName || notification.sessionId;
      const status = notification.type === 'prompt.completed' ? 'completed' : 'failed';
      const goal = notification.goal ? `: ${notification.goal.slice(0, 60)}` : '';
      await writeFile(markerPath, `${label} ${status}${goal}\n`);
    } catch { /* best effort */ }
  }

  async getUnread(): Promise<Notification[]> {
    const all = await this.readAll();
    return all.filter(n => !n.read);
  }

  async getAll(limit?: number): Promise<Notification[]> {
    const all = await this.readAll();
    return limit ? all.slice(-limit) : all;
  }

  async markAllRead(): Promise<number> {
    return this.withLock(async () => {
      const all = await this.readAll();
      const unreadCount = all.filter(n => !n.read).length;
      if (unreadCount === 0) return 0;
      const marked = all.map(n => ({ ...n, read: true }));
      await this.writeAll(marked);
      await this.clearMarker();
      return unreadCount;
    });
  }

  async markRead(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const all = await this.readAll();
      const notification = all.find(n => n.id === id);
      if (!notification || notification.read) return false;
      notification.read = true;
      await this.writeAll(all);
      if (!all.some(n => !n.read)) {
        await this.clearMarker();
      }
      return true;
    });
  }

  async deleteNotification(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const all = await this.readAll();
      const filtered = all.filter(n => n.id !== id);
      if (filtered.length === all.length) return false;
      await this.writeAll(filtered);
      return true;
    });
  }

  /**
   * Delete every notification (or every read notification when
   * `onlyRead === true`) in a single atomic rewrite — far safer than
   * fanning out N independent DELETE calls from a remote client, each of
   * which would race the others through the read-modify-write cycle.
   */
  async deleteAll(opts: { onlyRead?: boolean } = {}): Promise<number> {
    return this.withLock(async () => {
      const all = await this.readAll();
      let kept: Notification[];
      let removed: number;
      if (opts.onlyRead) {
        kept = all.filter(n => !n.read);
        removed = all.length - kept.length;
      } else {
        kept = [];
        removed = all.length;
      }
      if (removed === 0) return 0;
      await this.writeAll(kept);
      if (kept.every(n => n.read)) {
        await this.clearMarker();
      }
      return removed;
    });
  }

  async count(): Promise<{ total: number; unread: number }> {
    const all = await this.readAll();
    return {
      total: all.length,
      unread: all.filter(n => !n.read).length,
    };
  }

  private async clearMarker(): Promise<void> {
    try {
      await unlink(`${this.configDir}/inbox-new`);
    } catch { /* ignore if not exists */ }
  }

  /**
   * Robust JSONL reader. Skips unparseable lines instead of blackholing
   * the entire inbox if any single line has been corrupted (e.g., by a
   * crashed writer that didn't finish flushing). The skipped lines stay
   * on disk — a later writeAll() rewrites the file from `kept`, dropping
   * them naturally.
   */
  private async readAll(): Promise<Notification[]> {
    if (!existsSync(this.inboxPath)) return [];
    let content: string;
    try {
      content = await readFile(this.inboxPath, 'utf-8');
    } catch (err) {
      console.error('[inbox] failed to read notifications.jsonl:', (err as Error).message);
      return [];
    }
    const lines = content.split('\n').filter(Boolean);
    const out: Notification[] = [];
    let badLines = 0;
    for (const line of lines) {
      try {
        out.push(JSON.parse(line) as Notification);
      } catch {
        badLines++;
      }
    }
    if (badLines > 0) {
      console.error(
        `[inbox] skipped ${badLines} malformed line(s) in notifications.jsonl ` +
        `(of ${lines.length} total). They will be dropped on next rewrite.`,
      );
    }
    return out;
  }

  /**
   * Atomic rewrite: stage to `<file>.tmp`, then rename over the
   * destination. The rename is guaranteed atomic on POSIX, so a reader
   * sees either the pre-write file or the post-write file — never a
   * partial / truncated state.
   */
  private async writeAll(notifications: Notification[]): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const content = notifications.length === 0
      ? ''
      : notifications.map(n => JSON.stringify(n)).join('\n') + '\n';
    await writeFile(this.tmpPath, content);
    await rename(this.tmpPath, this.inboxPath);
  }
}
