import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { getDataDir, loadEnv } from './env.js';

describe('state directory resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('defaults to the user state directory', () => {
    vi.stubEnv('CB_DATA_DIR', undefined);
    expect(getDataDir()).toBe(join(homedir(), '.claude-b'));
  });

  it('keeps absolute paths and spaces intact', () => {
    vi.stubEnv('CB_DATA_DIR', '/tmp/claude b/state');
    expect(getDataDir()).toBe('/tmp/claude b/state');
  });

  it('resolves relative paths in the caller directory', () => {
    vi.stubEnv('CB_DATA_DIR', './state');
    expect(getDataDir()).toBe(resolve('state'));
  });

  it('expands a home-relative path without shell expansion', () => {
    vi.stubEnv('CB_DATA_DIR', '~/cb-state');
    expect(getDataDir()).toBe(join(homedir(), 'cb-state'));
    vi.stubEnv('CB_DATA_DIR', '~');
    expect(getDataDir()).toBe(homedir());
  });

  it('loads the configured relative state env and exports its absolute location', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cb-env-'));
    try {
      await mkdir(join(dir, 'state'));
      await writeFile(join(dir, 'state', '.env'), 'CB_REST_PORT=4999\n');
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      vi.stubEnv('CB_DATA_DIR', './state');
      vi.stubEnv('CB_REST_PORT', undefined);

      loadEnv();

      expect(process.env.CB_DATA_DIR).toBe(join(dir, 'state'));
      expect(process.env.CB_REST_PORT).toBe('4999');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
