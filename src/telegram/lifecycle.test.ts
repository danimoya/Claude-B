import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeBTelegramBot } from './bot.js';

const sdk = vi.hoisted(() => ({ instances: [] as any[] }));
vi.mock('node-telegram-bot-api', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class FakeTelegram extends EventEmitter {
    options: unknown;
    onText = vi.fn();
    getMe = vi.fn().mockResolvedValue({ username: 'fixture' });
    stopPolling = vi.fn().mockResolvedValue(undefined);
    startPolling = vi.fn().mockResolvedValue(undefined);
    constructor(_token: string, options: unknown) { super(); this.options = options; sdk.instances.push(this); }
  } };
});

describe('Telegram SDK shutdown ownership', () => {
  let dir: string;
  let bot: ClaudeBTelegramBot;
  beforeEach(async () => {
    sdk.instances.length = 0;
    vi.useFakeTimers();
    dir = await mkdtemp(join(tmpdir(), 'cb-tg-lifecycle-'));
    bot = new ClaudeBTelegramBot({ configDir: dir });
    await bot.getConfigManager().load();
    await bot.getConfigManager().setToken('fixture-token');
    await bot.start();
  });
  afterEach(async () => { await bot.stop(); vi.useRealTimers(); await rm(dir, { recursive: true, force: true }); });

  it('bounds SDK requests, cancels long polling, and clears timers before shutdown completes', async () => {
    const transport = sdk.instances[0];
    expect(transport.options).toMatchObject({ request: { timeout: 30000 }, polling: { params: { timeout: 25 } } });
    const stopped = bot.stop();
    expect(bot.isRunning()).toBe(false);
    await stopped;
    expect(transport.stopPolling).toHaveBeenCalledWith({ cancel: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores old polling events and scheduled reconnect requests after stop', async () => {
    const transport = sdk.instances[0];
    await bot.stop();
    transport.emit('polling_error', new Error('ETELEGRAM: network timeout'));
    (bot as any).scheduleReconnect();
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.startPolling).not.toHaveBeenCalled();
    expect(sdk.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not revive a transport when shutdown races an in-flight reconnect', async () => {
    const transport = sdk.instances[0];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    transport.stopPolling.mockImplementationOnce(() => gate);
    const reconnecting = (bot as any).attemptReconnect();
    await Promise.resolve();
    expect(transport.stopPolling).toHaveBeenCalledOnce();
    await bot.stop();
    release();
    await reconnecting;
    expect(transport.startPolling).not.toHaveBeenCalled();
    expect(bot.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a broken SDK stop promise without allowing late callbacks to restart polling', async () => {
    const transport = sdk.instances[0];
    transport.stopPolling.mockImplementation(() => new Promise(() => {}));
    const stopped = bot.stop();
    await vi.advanceTimersByTimeAsync(1000);
    await stopped;
    transport.emit('polling_error', new Error('ETELEGRAM: network timeout'));
    expect(transport.startPolling).not.toHaveBeenCalled();
    expect(bot.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('schedules another attempt after transient reconnect failure and still stops explicitly', async () => {
    const transport = sdk.instances[0];
    transport.startPolling.mockRejectedValueOnce(new Error('network timeout'));
    await (bot as any).attemptReconnect();
    expect(transport.startPolling).toHaveBeenCalledOnce();
    expect((bot as any).reconnectTimer).not.toBeNull();
    await bot.stop();
    await vi.advanceTimersByTimeAsync(60000);
    expect(transport.startPolling).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

});
