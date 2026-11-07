import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkStdinArtifact } from './check-stdin.mjs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const [artifact] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}));
const files = artifact.files.map(({ path }) => path);
for (const required of ['package.json', 'README.md', 'LICENSE', 'OPERATIONS.md', 'bin/cb',
  'dist/cli/index.js', 'dist/daemon/index.js']) {
  assert(files.includes(required), `Package missing ${required}; run npm run build first`);
}
for (const path of files) {
  assert(/^(bin\/|dist\/|scripts\/install\.sh$|package\.json$|README\.md$|OPERATIONS\.md$|LICENSE$)/.test(path),
    `Unexpected published path: ${path}`);
  assert(!/(^|\/)(\.env(?:\..*)?|\.npmrc|api\.key|telegram\.json)$/.test(path),
    `Credential file included: ${path}`);
  assert(!/\.test\.|(^|\/)(test|node_modules|\.git|\.claude-b)\//.test(path),
    `Development or state file included: ${path}`);
}

const stateDir = mkdtempSync(join(tmpdir(), 'claude-b-artifact-'));
try {
  const env = { ...process.env, CB_DATA_DIR: stateDir };
  const version = execFileSync(process.execPath, ['bin/cb', '--version'], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  }).trim();
  assert.equal(version, pkg.version, 'Built CLI version differs from package.json');
  const help = execFileSync(process.execPath, ['bin/cb', '--help'], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  assert(help.includes('Claude-B'), 'Built CLI did not render help');
  for (const flag of ['--config', '--export', '--import']) {
    assert(!help.includes(flag), `Unsupported option still advertised: ${flag}`);
    assert.throws(() => execFileSync(process.execPath, ['bin/cb', flag], {
      encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
    }), /Command failed/, `Unsupported option accepted: ${flag}`);
  }
  writeFileSync(join(stateDir, 'daemon.log'), 'artifact log fixture\n');
  const logs = execFileSync(process.execPath, ['bin/cb', '--logs'], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000,
  });
  assert(logs.includes('artifact log fixture'), 'CLI did not read selected state log');
  execFileSync(process.execPath, ['--check', 'dist/daemon/index.js'], {
    stdio: 'pipe', timeout: 10_000,
  });
  console.log(`Artifact checks passed: ${pkg.name}@${pkg.version}, ${files.length} files`);
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

await checkStdinArtifact();
