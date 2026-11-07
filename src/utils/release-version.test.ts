import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../../scripts/check-release-version.mjs', import.meta.url));

describe('release publication identity', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cb-release-'));
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'claude-b', version: '0.8.0' }));
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-b', version: '0.8.0', packages: { '': { version: '0.8.0' } } }));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const run = (ref: string, dryRun = 'false') => execFileSync(process.execPath, [guard], {
    cwd: dir, env: { GITHUB_REF: ref, CB_RELEASE_DRY_RUN: dryRun }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });

  it('accepts the exact immutable package version tag', () => {
    expect(run('refs/tags/v0.8.0')).toContain('claude-b@0.8.0');
  });
  it('rejects a different tag before any publication job can run', () => {
    expect(() => run('refs/tags/v0.7.0')).toThrow();
    expect(() => run('refs/tags/v0.7.0', 'true')).toThrow();
  });
  it('allows a branch dry run and rejects branch publication', () => {
    expect(run('refs/heads/main', 'true')).toContain('(dry run)');
    expect(() => run('refs/heads/main')).toThrow();
  });
  it('rejects an inconsistent lockfile even during a dry run', async () => {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-b', version: '0.7.0', packages: { '': { version: '0.8.0' } } }));
    expect(() => run('refs/heads/main', 'true')).toThrow();
  });
  it('rejects a stale packages root version and an invalid dry-run value', async () => {
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-b', version: '0.8.0', packages: { '': { version: '0.7.0' } } }));
    expect(() => run('refs/tags/v0.8.0')).toThrow();
    await writeFile(join(dir, 'package-lock.json'), JSON.stringify({ name: 'claude-b', version: '0.8.0', packages: { '': { version: '0.8.0' } } }));
    expect(() => run('refs/tags/v0.8.0', 'yes')).toThrow();
  });
});
