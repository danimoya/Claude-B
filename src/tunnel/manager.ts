// Persistent SSH tunnel management via systemd + autossh.
//
// Why this exists: `cb --remote-fire <name>` on host A needs a TCP path to
// host B's REST API on `127.0.0.1:3847` (the daemon does not bind a public
// interface). The dependable way to keep that path alive across network
// blips and reboots is autossh under a systemd unit. Writing those units
// by hand is tedious and error-prone, so this module packages it as a
// single command.

import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFile, mkdir, unlink, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createServer } from 'net';

const exec = promisify(execFile);

export interface TunnelSpec {
  /** Logical name — becomes part of unit filename `cb-tunnel-<name>.service` */
  name: string;
  /** SSH host alias as ssh(1)/autossh(1) resolve it (from ~/.ssh/config or DNS) */
  sshHost: string;
  /** Local TCP port to bind on this host. Default: auto-pick in [13847, 13947) */
  localPort?: number;
  /** Remote port (on the SSH target) to forward to. Default: 3847 */
  remotePort?: number;
  /** Write to /etc/systemd/system instead of ~/.config/systemd/user. Needs sudo. */
  system?: boolean;
}

export interface ResolvedTunnelSpec extends Required<Omit<TunnelSpec, 'system'>> {
  system: boolean;
}

const UNIT_PREFIX = 'cb-tunnel-';
const NAME_RE = /^[a-zA-Z][a-zA-Z0-9._-]{0,31}$/;

/** Render the systemd unit body. Pure, deterministic — easy to test. */
export function renderUnit(spec: ResolvedTunnelSpec): string {
  return `[Unit]
Description=Persistent SSH tunnel for Claude-B (local:${spec.localPort} -> ${spec.sshHost}:${spec.remotePort})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N -T \\
  -o ServerAliveInterval=30 \\
  -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes \\
  -o StrictHostKeyChecking=accept-new \\
  -L ${spec.localPort}:127.0.0.1:${spec.remotePort} \\
  ${spec.sshHost}
Restart=always
RestartSec=10

[Install]
WantedBy=${spec.system ? 'multi-user.target' : 'default.target'}
`;
}

export function unitName(name: string): string {
  return `${UNIT_PREFIX}${name}.service`;
}

export function unitPath(name: string, system: boolean): string {
  if (system) return `/etc/systemd/system/${unitName(name)}`;
  return join(homedir(), '.config', 'systemd', 'user', unitName(name));
}

/** Find a free TCP port in [13847, 13947) (or throw). */
async function pickLocalPort(): Promise<number> {
  for (let p = 13847; p < 13947; p++) {
    const free = await new Promise<boolean>(resolve => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => srv.close(() => resolve(true)));
      srv.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('no free port in 13847-13946 — pass --tunnel-local-port');
}

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await exec('which', [bin]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function sshReachable(host: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await exec('ssh', [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=5',
      '-o', 'StrictHostKeyChecking=accept-new',
      host,
      'true'
    ]);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.split('\n')[0] };
  }
}

async function systemctl(args: string[], system: boolean): Promise<string> {
  const cmd = system ? ['sudo', 'systemctl', ...args] : ['systemctl', '--user', ...args];
  const { stdout } = await exec(cmd[0], cmd.slice(1));
  return stdout.trim();
}

/** Resolve defaults, validating preconditions. */
export async function resolveSpec(spec: TunnelSpec): Promise<ResolvedTunnelSpec> {
  if (!NAME_RE.test(spec.name)) {
    throw new Error(
      `invalid tunnel name "${spec.name}" — must match ${NAME_RE} (letters/digits/._- ; starts with letter; max 32 chars)`
    );
  }
  if (!spec.sshHost) throw new Error('--tunnel-ssh-host is required with --install-tunnel');
  const remotePort = spec.remotePort ?? 3847;
  const localPort = spec.localPort ?? await pickLocalPort();
  return {
    name: spec.name,
    sshHost: spec.sshHost,
    localPort,
    remotePort,
    system: spec.system ?? false
  };
}

export interface InstallResult {
  unitPath: string;
  spec: ResolvedTunnelSpec;
  /** Whether systemctl reported the unit as active afterwards */
  active: boolean;
}

export async function install(spec: TunnelSpec): Promise<InstallResult> {
  const resolved = await resolveSpec(spec);

  const autossh = await which('autossh');
  if (!autossh) {
    throw new Error('autossh is not installed — install with `dnf install autossh` (RHEL) or `apt install autossh` (Debian)');
  }

  const reach = await sshReachable(resolved.sshHost);
  if (!reach.ok) {
    throw new Error(
      `ssh to "${resolved.sshHost}" failed in batch mode (${reach.reason}). ` +
      'autossh needs unattended key auth — check your ssh config / agent before installing.'
    );
  }

  const path = unitPath(resolved.name, resolved.system);
  if (existsSync(path)) {
    throw new Error(`unit already exists at ${path} — run \`cb --remove-tunnel ${resolved.name}\` first`);
  }

  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, renderUnit(resolved), { mode: 0o644 });

  await systemctl(['daemon-reload'], resolved.system);
  await systemctl(['enable', '--now', unitName(resolved.name)], resolved.system);

  // ~3s grace for autossh to spawn ssh + ssh to bind the port
  await new Promise(r => setTimeout(r, 3000));

  let active = false;
  try {
    const state = await systemctl(['is-active', unitName(resolved.name)], resolved.system);
    active = state === 'active';
  } catch {
    active = false;
  }

  return { unitPath: path, spec: resolved, active };
}

export async function remove(name: string, system: boolean): Promise<{ removed: boolean; unitPath: string }> {
  if (!NAME_RE.test(name)) throw new Error(`invalid tunnel name "${name}"`);
  const path = unitPath(name, system);
  if (!existsSync(path)) {
    // Try the other scope before giving up
    const otherPath = unitPath(name, !system);
    if (existsSync(otherPath)) {
      throw new Error(`tunnel "${name}" is installed in the ${system ? 'user' : 'system'} scope, not ${system ? 'system' : 'user'}. Re-run with${system ? 'out' : ''} --tunnel-system.`);
    }
    return { removed: false, unitPath: path };
  }

  try {
    await systemctl(['disable', '--now', unitName(name)], system);
  } catch {
    // Already disabled / stopped — proceed to remove the file
  }
  await unlink(path);
  await systemctl(['daemon-reload'], system).catch(() => undefined);
  return { removed: true, unitPath: path };
}

export interface TunnelInfo {
  name: string;
  unitPath: string;
  scope: 'user' | 'system';
  active: boolean;
}

export async function list(): Promise<TunnelInfo[]> {
  const out: TunnelInfo[] = [];
  const dirs: Array<{ dir: string; scope: 'user' | 'system' }> = [
    { dir: join(homedir(), '.config', 'systemd', 'user'), scope: 'user' },
    { dir: '/etc/systemd/system', scope: 'system' }
  ];
  for (const { dir, scope } of dirs) {
    let names: string[] = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const file of names) {
      if (!file.startsWith(UNIT_PREFIX) || !file.endsWith('.service')) continue;
      const name = file.slice(UNIT_PREFIX.length, -'.service'.length);
      let active = false;
      try {
        const state = await systemctl(['is-active', file], scope === 'system');
        active = state === 'active';
      } catch { active = false; }
      out.push({ name, unitPath: join(dir, file), scope, active });
    }
  }
  return out;
}
