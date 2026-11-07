import { describe, expect, it, vi } from 'vitest';
import { RemoteDeliveryMonitor } from './remote-delivery.js';
import type { RemoteReceipt } from '../orchestration/receipts.js';

function receipt(status: RemoteReceipt['status'], id = 'receipt-original'): RemoteReceipt {
  return { id, receiptId: id, taskId: 'task-original', sessionId: 'session-original',
    hostId: 'host-original', prompt: 'literal prompt', idempotencyKey: 'stable-key', status,
    createdAt: '2026-11-07T00:00:00.000Z', updatedAt: '2026-11-07T00:00:00.000Z',
    ...(status === 'prepared' ? {} : { submittedAt: '2026-11-07T00:00:00.000Z' }) };
}

describe('durable remote completion delivery', () => {
  it('recovers accepted tasks through status reads and delivers the exact terminal receipt', async () => {
    let task = receipt('accepted');
    const manager = { listRemoteTasks: vi.fn(async () => [task]), getRemoteTask: vi.fn(async () => task),
      resumeRemoteTask: vi.fn(async () => { task = { ...task, status: 'completed', output: 'exact result' }; return {} as never; }) };
    const outbox = { enqueue: vi.fn(async () => ({} as never)), drain: vi.fn(async () => {}) };
    const monitor = new RemoteDeliveryMonitor(manager, outbox);
    await Promise.all([monitor.reconcile(), monitor.reconcile()]);
    expect(manager.resumeRemoteTask).toHaveBeenCalledTimes(1);
    expect(manager.resumeRemoteTask).toHaveBeenCalledWith(task.id, { timeout: 1000, waitForCompletion: false });
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: `remote:${task.id}`,
      promptId: task.taskId, type: 'prompt.completed', resultFull: 'exact result', viewCommand: `cb --remote-task ${task.id}` }));
    await new RemoteDeliveryMonitor(manager, outbox).reconcile();
    expect(manager.resumeRemoteTask).toHaveBeenCalledTimes(1);
    expect(outbox.enqueue.mock.calls[0]).toEqual(outbox.enqueue.mock.calls[1]);
  });

  it('never submits a prepared receipt or claims an uncertain result has completed', async () => {
    const prepared = receipt('prepared');
    const uncertain = receipt('uncertain', 'receipt-uncertain');
    const manager = { listRemoteTasks: async () => [prepared, uncertain], getRemoteTask: async () => uncertain,
      resumeRemoteTask: vi.fn(async () => ({} as never)) };
    const outbox = { enqueue: vi.fn(async () => ({} as never)), drain: vi.fn(async () => {}) };
    const monitor = new RemoteDeliveryMonitor(manager, outbox);
    await monitor.reconcile();
    expect(manager.resumeRemoteTask).toHaveBeenCalledTimes(1);
    expect(manager.resumeRemoteTask).toHaveBeenCalledWith(uncertain.id, { timeout: 1000, waitForCompletion: false });
    expect(outbox.enqueue).not.toHaveBeenCalled();
    monitor.stop();
    await monitor.reconcile();
    expect(manager.resumeRemoteTask).toHaveBeenCalledTimes(1);
  });

  it('preserves empty success and includes the error beside partial failure output', async () => {
    const tasks = [{ ...receipt('completed'), output: '', goal: 'owner-selected goal' },
      { ...receipt('error', 'receipt-failed'), output: 'partial result', error: 'provider failed' }];
    const manager = { listRemoteTasks: async () => tasks, getRemoteTask: async () => null,
      resumeRemoteTask: vi.fn(async () => ({} as never)) };
    const outbox = { enqueue: vi.fn(async () => ({} as never)), drain: vi.fn(async () => {}) };
    await new RemoteDeliveryMonitor(manager, outbox).reconcile();
    expect(outbox.enqueue).toHaveBeenNthCalledWith(1, expect.objectContaining({ resultFull: '', goal: 'owner-selected goal' }));
    expect(outbox.enqueue).toHaveBeenNthCalledWith(2, expect.objectContaining({ resultFull: 'partial result\nprovider failed', goal: 'literal prompt' }));
    expect(manager.resumeRemoteTask).not.toHaveBeenCalled();
  });
});
