import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { fileURLToPath } from 'url';
import { startDaemon } from './daemon-launch.js';
import { getDataDir } from '../config/env.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));

describe('daemon launch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('launches the installed entry with the current Node and shared state from any cwd', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    });
    vi.spyOn(process, 'cwd').mockReturnValue('/caller/project with spaces');

    await startDaemon();

    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      fileURLToPath(new URL('../daemon/index.js', import.meta.url)),
    ], expect.objectContaining({
      cwd: '/caller/project with spaces',
      detached: true,
      stdio: 'ignore',
      env: expect.objectContaining({ CB_DATA_DIR: getDataDir() }),
    }));
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('propagates spawn errors without leaving an unhandled error event', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn denied')));
      return child as unknown as ChildProcess;
    });

    await expect(startDaemon()).rejects.toThrow('spawn denied');
    expect(child.unref).not.toHaveBeenCalled();
  });
});
