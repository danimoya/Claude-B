import { createConnection, Socket } from 'net';
import { homedir } from 'os';
import { EventEmitter } from 'events';

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
  private pendingRequests: Map<number, {
    resolve: (value: DaemonResponse) => void;
    reject: (error: Error) => void;
  }> = new Map();
  private buffer = '';

  constructor(socketPath?: string) {
    super();
    this.socketPath = socketPath || `${homedir()}/.claude-b/daemon.sock`;
  }

  private async connect(): Promise<Socket> {
    if (this.socket?.writable) {
      return this.socket;
    }

    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);

      socket.on('connect', () => {
        this.socket = socket;
        resolve(socket);
      });

      socket.on('data', (data) => {
        this.handleData(data.toString());
      });

      socket.on('error', (error) => {
        this.socket = null;
        reject(error);
      });

      socket.on('close', () => {
        this.socket = null;
        this.emit('close');
      });
    });
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
    const id = ++this.messageId;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      const payload = JSON.stringify({ ...message, id }) + '\n';
      socket.write(payload, (error) => {
        if (error) {
          this.pendingRequests.delete(id);
          reject(error);
        }
      });

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('Request timeout'));
        }
      }, 30000);
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
    this.socket?.end();
    this.socket = null;
  }
}
