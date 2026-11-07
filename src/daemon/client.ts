import { createConnection, Socket } from 'net';
import { EventEmitter } from 'events';
import { join } from 'path';
import { getDataDir } from '../config/env.js';

export interface DaemonMessage {
  method: string;
  params?: Record<string, unknown>;
  id?: number;
}

export interface DaemonResponse {
  id?: number;
  data?: Record<string, unknown>;
  error?: string;
}

export class DaemonClient extends EventEmitter {
  private socket: Socket | null = null;
  private socketPath: string;
  private messageId = 0;
  private connecting: Promise<Socket> | null = null;
  private requestTimeoutMs: number;
  private pendingRequests: Map<number, {
    resolve: (value: DaemonResponse) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = new Map();
  private buffer = '';

  constructor(socketPath?: string, requestTimeoutMs = 30000) {
    super();
    this.socketPath = socketPath || join(getDataDir(), 'daemon.sock');
    this.requestTimeoutMs = requestTimeoutMs;
  }

  private connect(): Promise<Socket> {
    if (this.connecting) return this.connecting;
    if (this.socket?.writable && !this.socket.destroyed) return Promise.resolve(this.socket);

    const socket = createConnection(this.socketPath);
    this.socket = socket;
    this.buffer = '';
    this.connecting = new Promise((resolve, reject) => {
      const terminate = (error: Error) => {
        if (this.socket === socket) {
          this.socket = null;
          this.connecting = null;
          this.buffer = '';
          this.rejectPending(error);
          this.emit('close');
        }
        reject(error);
      };
      socket.once('connect', () => {
        if (this.socket !== socket) {
          socket.destroy();
          reject(new Error('Daemon connection closed'));
          return;
        }
        this.connecting = null;
        resolve(socket);
      });
      socket.on('data', (data) => {
        if (this.socket === socket) this.handleData(data.toString());
      });
      socket.on('error', (error) => {
        terminate(error);
        socket.destroy();
      });
      socket.once('close', () => terminate(new Error('Daemon connection closed')));
    });
    return this.connecting;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Process complete JSON messages (newline-delimited)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as DaemonResponse & { type?: string };

        // Handle streaming output
        if (message.type === 'output') {
          this.emit('output', message.data);
          continue;
        }

        // Handle status updates
        if (message.type === 'status') {
          this.emit('status', message.data);
          continue;
        }

        // Handle response to request
        if (message.id !== undefined) {
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            this.pendingRequests.delete(message.id);
            clearTimeout(pending.timer);
            pending.resolve(message);
          }
        }
      } catch {
        // Ignore parse errors for incomplete messages
      }
    }
  }

  async send(message: DaemonMessage): Promise<DaemonResponse> {
    const socket = await this.connect();
    if (this.socket !== socket || !socket.writable || socket.destroyed) throw new Error('Daemon connection closed');
    const id = ++this.messageId;
    const payload = JSON.stringify({ ...message, id }) + '\n';

    return new Promise((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('Request timeout')), this.requestTimeoutMs);
      timer.unref();
      this.pendingRequests.set(id, { resolve, reject, timer });
      try {
        socket.write(payload, (error) => { if (error) fail(error); });
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async attach(sessionId: string): Promise<void> {
    const socket = await this.connect();

    // Send attach command
    await this.send({ method: 'session.attach', params: { sessionId } });

    // Pipe stdout to socket and socket to stdout
    process.stdout.on('resize', () => {
      this.send({ method: 'terminal.resize', params: {
        cols: process.stdout.columns,
        rows: process.stdout.rows
      } }).catch(() => {});
    });

    // Listen for output
    this.on('output', (data: { content: string }) => {
      process.stdout.write(data.content);
    });

    // Handle stdin
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      // Ctrl+D to detach
      if (data.toString() === '\x04') {
        this.send({ method: 'session.detach' }).finally(() => {
          process.stdin.setRawMode?.(false);
          process.exit(0);
        });
        return;
      }
      socket.write(JSON.stringify({ method: 'stdin', params: { data: data.toString() } }) + '\n');
    });

    // Wait for connection to close
    await new Promise<void>((resolve) => {
      this.on('close', resolve);
    });
  }

  async watch(): Promise<void> {
    await this.connect();

    // Send watch command
    await this.send({ method: 'session.watch' });

    // Listen for output
    this.on('output', (data: { content: string }) => {
      process.stdout.write(data.content);
    });

    // Listen for status updates
    this.on('status', (data: { status: string; promptId?: string }) => {
      if (data.status === 'processing') {
        process.stdout.write(`\x1b[33m[Processing prompt ${data.promptId || ''}...]\x1b[0m\n`);
      } else if (data.status === 'completed') {
        process.stdout.write(`\x1b[32m[Completed]\x1b[0m\n`);
      } else if (data.status === 'error') {
        process.stdout.write(`\x1b[31m[Error]\x1b[0m\n`);
      }
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
      this.send({ method: 'session.unwatch' }).finally(() => {
        process.exit(0);
      });
    });

    // Wait for connection to close
    await new Promise<void>((resolve) => {
      this.on('close', resolve);
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    this.connecting = null;
    this.buffer = '';
    this.rejectPending(new Error('Daemon client closed'));
    socket?.destroy();
    if (socket) this.emit('close');
  }
}
