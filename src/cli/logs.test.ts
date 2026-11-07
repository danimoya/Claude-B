import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readLogTail } from './logs.js';

describe('local daemon log tail', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-logs-'));
    vi.stubEnv('CB_DATA_DIR', dir);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });

  it('reports a missing log without creating state or contacting a daemon', async () => {
    expect(await readLogTail()).toEqual({ path: join(dir, 'daemon.log'), text: '', missing: true });
  });
  it('reads the last requested lines of the selected data directory', async () => {
    await writeFile(join(dir, 'daemon.log'), 'first\nsecond\nlast\n');
    expect((await readLogTail(1024, 2)).text).toBe('second\nlast');
  });
  it('bounds bytes read and drops a partial first line', async () => {
    await writeFile(join(dir, 'daemon.log'), 'first line\nsecond line\nlast\n');
    expect((await readLogTail(12)).text).toBe('last');
  });
  it('handles empty files', async () => {
    await writeFile(join(dir, 'daemon.log'), '');
    expect((await readLogTail()).text).toBe('');
  });
});
