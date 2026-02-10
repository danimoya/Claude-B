import { appendFile, readFile, writeFile, mkdir } from 'fs/promises';
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
  viewCommand: string;
  read: boolean;
}

export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'read'>;

export class NotificationInbox {
  private configDir: string;
  private inboxPath: string;

  constructor(configDir: string) {
    this.configDir = configDir;
    this.inboxPath = `${configDir}/notifications.jsonl`;
  }

  async addNotification(input: NotificationInput): Promise<Notification> {
    await mkdir(this.configDir, { recursive: true });
    const notification: Notification = {
      ...input,
      id: nanoid(8),
      timestamp: new Date().toISOString(),
      read: false,
    };
    await appendFile(this.inboxPath, JSON.stringify(notification) + '\n');
    return notification;
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
    const all = await this.readAll();
    const unreadCount = all.filter(n => !n.read).length;
    if (unreadCount === 0) return 0;
    const marked = all.map(n => ({ ...n, read: true }));
    await this.writeAll(marked);
    return unreadCount;
  }

  async count(): Promise<{ total: number; unread: number }> {
    const all = await this.readAll();
    return {
      total: all.length,
      unread: all.filter(n => !n.read).length,
    };
  }

  private async readAll(): Promise<Notification[]> {
    if (!existsSync(this.inboxPath)) return [];
    try {
      const content = await readFile(this.inboxPath, 'utf-8');
      return content.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  private async writeAll(notifications: Notification[]): Promise<void> {
    await mkdir(this.configDir, { recursive: true });
    const content = notifications.map(n => JSON.stringify(n)).join('\n') + '\n';
    await writeFile(this.inboxPath, content);
  }
}
