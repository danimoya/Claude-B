import { readFileSync } from 'node:fs';

try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  if (pkg.name !== 'claude-b' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version || '')) {
    throw new Error('Invalid Claude-B release package identity');
  }
  if (lock.name !== pkg.name || lock.version !== pkg.version ||
      lock.packages?.['']?.version !== pkg.version) {
    throw new Error('Lockfile root version does not match package.json');
  }
  const dryRun = process.env.CB_RELEASE_DRY_RUN ?? 'false';
  if (dryRun !== 'true' && dryRun !== 'false') throw new Error('Invalid release dry-run setting');
  const expectedRef = `refs/tags/v${pkg.version}`;
  if ((dryRun === 'false' || process.env.GITHUB_REF?.startsWith('refs/tags/')) &&
      process.env.GITHUB_REF !== expectedRef) {
    throw new Error(`Publishing requires the package version tag ${expectedRef}`);
  }
  console.log(`Release identity verified: ${pkg.name}@${pkg.version}${dryRun === 'true' ? ' (dry run)' : ''}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release identity validation failed');
  process.exitCode = 1;
}
