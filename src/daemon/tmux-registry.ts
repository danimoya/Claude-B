import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { atomicWriteJson } from '../storage/atomic-json.js';
import { PANE_IDENTITY_FORMAT, parseTmuxPaneIdentity, pasteToTmuxPane, runTmux, type TmuxPaneIdentity, type TmuxRunner } from '../tmux/targets.js';

export const REGISTRY_PANE_FORMAT = `${PANE_IDENTITY_FORMAT}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_title}`;
export interface ForegroundIdentity { pid: number; startedAt: string }
export interface TmuxSessionSummary {
  id: string;
  name: string;
  status: string;
  selected: boolean;
  createdAt: string;
  goal?: string;
  agent?: string;
}
interface Pane extends TmuxPaneIdentity { alias: string; title: string }
interface Entry {
  pane: TmuxPaneIdentity;
  foreground: ForegroundIdentity;
  summary: TmuxSessionSummary;
  lastSeen: number;
}
export interface TmuxRegistryOptions {
  runSync?: (args: string[]) => string;
  runAsync?: TmuxRunner;
  processIdentity?: (panePid: number) => ForegroundIdentity;
  now?: () => number;
  ttlMs?: number;
  settleMs?: number;
  stateFile?: string;
}

function syncTmux(args: string[]): string {
  const result = spawnSync('tmux', args, { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 });
  if (result.status !== 0 || result.error) throw new Error('Tmux is unavailable');
  return result.stdout;
}

/** pane_pid identifies the shell; its foreground process group identifies the running agent. */
function foregroundIdentity(panePid: number): ForegroundIdentity {
  const ps = (args: string[]) => {
    const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 1000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' } });
    if (result.status !== 0 || result.error) throw new Error('Cannot identify the tmux foreground process');
    return result.stdout.trim();
  };
  const pid = Number(ps(['-o', 'tpgid=', '-p', String(panePid)]));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Tmux has no identifiable foreground process');
  const startedAt = ps(['-o', 'lstart=', '-p', String(pid)]);
  if (!startedAt) throw new Error('Tmux foreground process has exited');
  return { pid, startedAt };
}

function parsePane(line: string): Pane {
  const fields = line.trimEnd().split('\t');
  const pane = parseTmuxPaneIdentity(fields.slice(0, 4).join('\t'));
  return { ...pane, alias: fields[4] || pane.paneId, title: fields.slice(5).join(' ').trim() };
}

export class TmuxRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly sync: (args: string[]) => string;
  private readonly async: TmuxRunner;
  private readonly processIdentity: (panePid: number) => ForegroundIdentity;
  private readonly now: () => number;
  private readonly ttl: number;
  private saving: Promise<void> = Promise.resolve();
  private writeError: Error | null = null;
  private corruptState: Error | null = null;
  private restoring = false;

  constructor(private readonly options: TmuxRegistryOptions = {}) {
    this.sync = options.runSync || syncTmux;
    this.async = options.runAsync || runTmux;
    this.processIdentity = options.processIdentity || foregroundIdentity;
    this.now = options.now || Date.now;
    this.ttl = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  private persist(): void {
    if (!this.options.stateFile || this.restoring || this.corruptState) return;
    this.saving = this.saving.then(async () => {
      try {
        await atomicWriteJson(this.options.stateFile!, { version: 1, entries: [...this.entries.values()] });
        this.writeError = null;
      } catch {
        this.writeError = new Error('Tmux registry state could not be persisted');
      }
    });
  }

  async flush(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.saving; await pending; } while (pending !== this.saving);
    if (this.corruptState) throw this.corruptState;
    if (this.writeError) throw this.writeError;
  }

  private validateStoredEntry(value: unknown): asserts value is Entry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid tmux registry entry');
    const entry = value as Entry;
    const pane = entry.pane;
    const foreground = entry.foreground;
    const summary = entry.summary;
    if (!pane || !/^%\d+$/.test(pane.paneId) || !Number.isSafeInteger(pane.pid) || pane.pid <= 0 ||
        typeof pane.command !== 'string' || !pane.command || /[\r\n\0]/.test(pane.command) ||
        !foreground || !Number.isSafeInteger(foreground.pid) || foreground.pid <= 0 ||
        typeof foreground.startedAt !== 'string' || !foreground.startedAt || foreground.startedAt.length > 256 ||
        !summary || typeof summary.name !== 'string' || !['idle', 'busy'].includes(summary.status) || summary.selected !== false ||
        typeof summary.createdAt !== 'string' || !Number.isFinite(Date.parse(summary.createdAt)) ||
        (summary.goal !== undefined && typeof summary.goal !== 'string') ||
        !Number.isFinite(entry.lastSeen) || entry.lastSeen < 0 ||
        this.permittedAgent({ ...pane, alias: '', title: '' }, summary.agent) !== summary.agent ||
        typeof summary.agent !== 'string' || this.canonical(pane, foreground) !== summary.id) throw new Error('Invalid tmux registry entry');
  }

  /** Restore only the exact approved invocation, never whatever now occupies an alias. */
  async restore(): Promise<void> {
    if (!this.options.stateFile) return;
    let stored: Entry[];
    try {
      let bytes: string;
      try { bytes = await readFile(this.options.stateFile, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      const value: unknown = JSON.parse(bytes);
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          (value as { version?: unknown }).version !== 1 || !Array.isArray((value as { entries?: unknown }).entries)) throw new Error('Invalid tmux registry state');
      stored = (value as { entries: unknown[] }).entries.map((entry) => { this.validateStoredEntry(entry); return entry; });
      if (new Set(stored.map((entry) => entry.summary.id)).size !== stored.length) throw new Error('Duplicate tmux registry entries');
    } catch {
      this.corruptState = new Error('Cannot restore tmux registry; invalid or unreadable state was preserved');
      throw this.corruptState;
    }
    this.corruptState = null;
    this.restoring = true;
    this.entries.clear();
    try {
      for (const entry of stored) {
        if (this.now() - entry.lastSeen > this.ttl) continue;
        try {
          const actual = parsePane(this.sync(['display-message', '-p', '-t', entry.pane.paneId, REGISTRY_PANE_FORMAT]));
          if (!this.matches(entry, actual)) continue;
          const id = this.register(entry.summary.id, entry.summary.name, entry.summary.agent, entry.summary.goal);
          if (id === entry.summary.id) {
            const restored = this.entries.get(id)!;
            restored.lastSeen = entry.lastSeen;
            restored.summary.createdAt = entry.summary.createdAt;
            if (restored.summary.agent !== 'claude') restored.summary.status = entry.summary.status;
          }
        } catch { /* unknown, replaced or unavailable invocations are not restored */ }
      }
    } finally { this.restoring = false; }
    this.persist();
    await this.flush();
  }

  private canonical(pane: TmuxPaneIdentity, foreground: ForegroundIdentity): string {
    const generation = createHash('sha256').update(`${foreground.startedAt}\0${pane.pid}\0${pane.command}`).digest('hex').slice(0, 8);
    return `tmux:${pane.paneId}@${foreground.pid}-${generation}`;
  }

  private snapshot(): Map<string, Pane> | undefined {
    try {
      const result = new Map<string, Pane>();
      for (const line of this.sync(['list-panes', '-a', '-F', REGISTRY_PANE_FORMAT]).split('\n')) {
        if (!line) continue;
        try { const pane = parsePane(line); result.set(pane.paneId, pane); } catch { /* dead/malformed panes are not selectable */ }
      }
      return result;
    } catch { return undefined; }
  }

  private permittedAgent(pane: Pane, declared?: string): string | undefined {
    const command = pane.command.toLowerCase();
    if (['claude', 'codex', 'opencode', 'antigravity'].includes(command)) return command;
    const agent = declared?.toLowerCase();
    if (agent && ['codex', 'opencode', 'antigravity'].includes(agent) && ['node', 'bun'].includes(command)) return agent;
    return undefined;
  }

  private record(pane: Pane, name: string | undefined, declared: string | undefined, goal: string | undefined): string | undefined {
    const agent = this.permittedAgent(pane, declared);
    if (!agent) return undefined;
    const foreground = this.processIdentity(pane.pid);
    const id = this.canonical(pane, foreground);
    for (const [oldId, entry] of this.entries) {
      if (entry.pane.paneId === pane.paneId && oldId !== id) this.entries.delete(oldId);
    }
    const previous = this.entries.get(id);
    const status = agent === 'claude' ? (pane.title.startsWith('✳') ? 'idle' : 'busy') : 'idle';
    this.entries.set(id, {
      pane: { paneId: pane.paneId, pid: pane.pid, command: pane.command }, foreground, lastSeen: this.now(),
      summary: { id, name: name || [pane.alias, pane.title].filter(Boolean).join(' '), agent, status,
        selected: false, createdAt: previous?.summary.createdAt || new Date(this.now()).toISOString(),
        goal: goal ?? previous?.summary.goal },
    });
    this.persist();
    return id;
  }

  /** Normalize an authenticated agent event to one concrete running invocation. */
  register(sessionId: string, name?: string, agent?: string, goal?: string): string | undefined {
    if (this.corruptState) return undefined;
    if (!sessionId.startsWith('tmux:')) return undefined;
    const supplied = sessionId.slice(5);
    const canonical = /^(%\d+)@(\d+)-([a-f0-9]{8})$/.exec(supplied);
    const target = canonical?.[1] || supplied;
    if (!/^%\d+$/.test(target) && !/^[^:\r\n\0]+:\d+\.\d+$/.test(target)) return undefined;
    try {
      const pane = parsePane(this.sync(['display-message', '-p', '-t', target, REGISTRY_PANE_FORMAT]));
      if ((target.startsWith('%') && pane.paneId !== target) || (!target.startsWith('%') && pane.alias !== target)) return undefined;
      if (canonical && this.canonical(pane, this.processIdentity(pane.pid)) !== sessionId) return undefined;
      return this.record(pane, name, agent, goal);
    } catch { return undefined; }
  }

  private matches(entry: Entry, pane: TmuxPaneIdentity | undefined): boolean {
    if (!pane || pane.paneId !== entry.pane.paneId || pane.pid !== entry.pane.pid || pane.command !== entry.pane.command) return false;
    try {
      const foreground = this.processIdentity(pane.pid);
      return foreground.pid === entry.foreground.pid && foreground.startedAt === entry.foreground.startedAt;
    } catch { return false; }
  }

  private live(snapshot: Map<string, Pane>): TmuxSessionSummary[] {
    const summaries: TmuxSessionSummary[] = [];
    for (const [id, entry] of this.entries) {
      if (this.now() - entry.lastSeen > this.ttl || !this.matches(entry, snapshot.get(entry.pane.paneId))) {
        this.entries.delete(id);
        this.persist();
        continue;
      }
      summaries.push({ ...entry.summary });
    }
    return summaries;
  }

  /** Discover native agents and include still-live agents registered by Stop events. */
  discover(): TmuxSessionSummary[] {
    if (this.corruptState) return [];
    const panes = this.snapshot();
    if (!panes) return [];
    for (const pane of panes.values()) {
      if (pane.command === 'claude') {
        try { this.record(pane, undefined, 'claude', undefined); } catch { /* foreground exited */ }
      }
    }
    return this.live(panes);
  }

  aliveSessions(): TmuxSessionSummary[] {
    if (this.corruptState) return [];
    const panes = this.snapshot();
    return panes ? this.live(panes) : [];
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (this.corruptState) throw this.corruptState;
    const entry = this.entries.get(sessionId);
    if (!entry || this.now() - entry.lastSeen > this.ttl) throw new Error('Tmux agent is no longer registered; select the live session again');
    const verify = (actual: TmuxPaneIdentity) => {
      if (!this.matches(entry, actual)) {
        this.entries.delete(sessionId);
        this.persist();
        throw new Error('Tmux agent invocation changed; select the live session again');
      }
    };
    const guarded: TmuxRunner = async (args, input) => {
      if (args[0] === 'display-message') {
        const output = await this.async(args, input);
        verify(parseTmuxPaneIdentity(output));
        return output;
      }
      if (['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0])) {
        verify(parseTmuxPaneIdentity(await this.async(['display-message', '-p', '-t', entry.pane.paneId, PANE_IDENTITY_FORMAT])));
      }
      return this.async(args, input);
    };
    await pasteToTmuxPane(entry.pane, text, guarded, this.options.settleMs ?? 150);
    entry.summary.status = 'busy';
    this.persist();
  }
}
