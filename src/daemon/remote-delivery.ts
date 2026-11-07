import type { OrchestrationManager } from '../orchestration/manager.js';
import type { RemoteReceipt } from '../orchestration/receipts.js';
import type { NotificationOutbox } from '../notifications/outbox.js';

const terminal = new Set(['completed', 'error', 'cancelled', 'interrupted']);

/** Recover notifications and observe submitted remote tasks using GET only. */
export class RemoteDeliveryMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;
  private stopped = false;

  constructor(
    private manager: Pick<OrchestrationManager, 'listRemoteTasks' | 'getRemoteTask' | 'resumeRemoteTask'>,
    private outbox: Pick<NotificationOutbox, 'enqueue' | 'drain'>,
    private onError: () => void = () => {},
  ) {}

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.reconcile().catch(this.onError); }, 5000);
    this.timer.unref();
    void this.reconcile().catch(this.onError);
  }

  stop(): void { this.stopped = true; clearInterval(this.timer); this.timer = undefined; }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.draining) return this.draining;
    const operation = this.run();
    this.draining = operation;
    void operation.finally(() => { if (this.draining === operation) this.draining = undefined; }).catch(() => {});
    return operation;
  }

  private async run(): Promise<void> {
    const receipts = await this.manager.listRemoteTasks();
    for (let offset = 0; offset < receipts.length && !this.stopped; offset += 4) {
      await Promise.all(receipts.slice(offset, offset + 4).map(async receipt => {
        if (this.stopped) return;
        if (terminal.has(receipt.status)) return this.notify(receipt);
        // Prepared receipts have not submitted anything. Never turn recovery into a POST.
        if (!receipt.submittedAt || receipt.status === 'rejected') return;
        try {
          await this.manager.resumeRemoteTask(receipt.id, { timeout: 1000, waitForCompletion: false });
          const current = await this.manager.getRemoteTask(receipt.id);
          if (current && terminal.has(current.status)) await this.notify(current);
        } catch { this.onError(); }
      }));
    }
    if (!this.stopped) await this.outbox.drain();
  }

  private async notify(receipt: RemoteReceipt): Promise<void> {
    if (this.stopped) return;
    const completed = receipt.status === 'completed';
    const output = receipt.output ?? '';
    const result = completed ? output : [output, receipt.error || receipt.status].filter(Boolean).join('\n');
    await this.outbox.enqueue({
      deliveryId: `remote:${receipt.id}`, promptId: receipt.taskId,
      sessionId: receipt.sessionId, sessionName: `remote:${receipt.hostId}`,
      type: completed ? 'prompt.completed' : 'prompt.error',
      goal: receipt.prompt.slice(0, 100), exitCode: completed ? 0 : 1,
      resultPreview: result.slice(0, 200), resultFull: result.slice(0, 50000),
      viewCommand: `cb --remote-task ${receipt.id}`,
    });
  }
}
