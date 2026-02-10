import { Socket } from 'net';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { Session, SessionState } from '../session/session.js';

interface SessionIndex {
  sessions: SessionState[];
  selectedId?: string;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private selectedId: string | null = null;
  private configDir: string;
  private indexPath: string;
  private attachedSessions: Map<Socket, string> = new Map();

  constructor(configDir: string) {
    this.configDir = configDir;
    this.indexPath = `${configDir}/sessions/index.json`;
  }

  async load(): Promise<void> {
    const sessionsDir = `${this.configDir}/sessions`;
    await mkdir(sessionsDir, { recursive: true });

    if (!existsSync(this.indexPath)) {
      await this.save();
      return;
    }

    try {
      const data = await readFile(this.indexPath, 'utf-8');
      const index: SessionIndex = JSON.parse(data);

      let staleCount = 0;
      for (const state of index.sessions) {
        // Reset stale "busy" sessions — no process survives a daemon restart
        if (state.status === 'busy') {
          state.status = 'idle';
          staleCount++;
        }
        const session = new Session(state, this.configDir);
        // Load persisted output buffer from disk
        await session.loadPersistedOutput();
        this.sessions.set(session.id, session);
      }

      if (staleCount > 0) {
        console.log(`[SessionManager] Reset ${staleCount} stale busy session(s) to idle`);
        await this.save();
      }

      if (index.selectedId && this.sessions.has(index.selectedId)) {
        this.selectedId = index.selectedId;
      }
    } catch {
      // Start fresh if index is corrupted
      await this.save();
    }
  }

  async save(): Promise<void> {
    const sessionsDir = `${this.configDir}/sessions`;
    await mkdir(sessionsDir, { recursive: true });

    const index: SessionIndex = {
      sessions: Array.from(this.sessions.values()).map(s => s.getState()),
      selectedId: this.selectedId || undefined
    };

    await writeFile(this.indexPath, JSON.stringify(index, null, 2));
  }

  async create(name?: string, model?: string, goal?: string, fireAndForget?: boolean): Promise<Session> {
    const session = Session.create(name, this.configDir, model, goal, fireAndForget);
    this.sessions.set(session.id, session);

    // Auto-select if no session is selected
    if (!this.selectedId) {
      this.selectedId = session.id;
    }

    await this.save();
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  current(): Session | null {
    if (!this.selectedId) {
      return null;
    }
    return this.sessions.get(this.selectedId) || null;
  }

  select(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    this.selectedId = sessionId;
    this.save().catch(() => {});
  }

  list(): Array<{
    id: string;
    name?: string;
    model?: string;
    status: string;
    selected: boolean;
    createdAt: string;
    goal?: string;
    fireAndForget?: boolean;
    claudeSessionId?: string;
  }> {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      name: session.name,
      model: session.model,
      status: session.status,
      selected: session.id === this.selectedId,
      createdAt: session.createdAt,
      goal: session.goal,
      fireAndForget: session.fireAndForget,
      claudeSessionId: session.getClaudeSessionId(),
    }));
  }

  count(): number {
    return this.sessions.size;
  }

  async kill(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    await session.stop();
    this.sessions.delete(sessionId);

    // Clear selection if killing selected session
    if (this.selectedId === sessionId) {
      this.selectedId = this.sessions.size > 0
        ? this.sessions.keys().next().value || null
        : null;
    }

    await this.save();
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.sessions.values()).map(s => s.stop());
    await Promise.all(stopPromises);
    await this.save();
  }

  // Remove idle sessions older than maxAge (default: 30 days)
  async cleanupExpired(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
    const now = Date.now();
    const expired: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.status === 'busy') continue; // don't kill active sessions
      const lastActive = new Date(session.lastActivityAt || session.createdAt).getTime();
      if (now - lastActive > maxAgeMs) {
        expired.push(id);
      }
    }

    for (const id of expired) {
      const session = this.sessions.get(id);
      if (session) {
        await session.stop();
        this.sessions.delete(id);
        if (this.selectedId === id) {
          this.selectedId = this.sessions.size > 0
            ? this.sessions.keys().next().value || null
            : null;
        }
      }
    }

    if (expired.length > 0) {
      await this.save();
    }
    return expired.length;
  }

  // Remove completed fire-and-forget sessions that are idle
  async cleanupFireAndForget(): Promise<number> {
    const completed: string[] = [];

    for (const [id, session] of this.sessions) {
      if (session.fireAndForget && session.status === 'idle' && session.getState().promptCount > 0) {
        completed.push(id);
      }
    }

    for (const id of completed) {
      const session = this.sessions.get(id);
      if (session) {
        await session.stop();
        this.sessions.delete(id);
        if (this.selectedId === id) {
          this.selectedId = this.sessions.size > 0
            ? this.sessions.keys().next().value || null
            : null;
        }
      }
    }

    if (completed.length > 0) {
      await this.save();
    }
    return completed.length;
  }

  getAttachedSession(socket: Socket): Session | undefined {
    const sessionId = this.attachedSessions.get(socket);
    if (!sessionId) return undefined;
    return this.sessions.get(sessionId);
  }

  registerAttachment(socket: Socket, sessionId: string): void {
    this.attachedSessions.set(socket, sessionId);
  }

  unregisterAttachment(socket: Socket): void {
    this.attachedSessions.delete(socket);
  }
}
