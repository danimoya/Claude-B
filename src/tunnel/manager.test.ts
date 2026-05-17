import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import { renderUnit, unitName, unitPath, resolveSpec, type ResolvedTunnelSpec } from './manager.js';

describe('tunnel.renderUnit', () => {
  it('renders a complete unit body for user scope', () => {
    const spec: ResolvedTunnelSpec = {
      name: 'gb',
      sshHost: 'gpc001gb-wg',
      localPort: 13847,
      remotePort: 3847,
      system: false
    };

    const body = renderUnit(spec);

    expect(body).toContain('Description=Persistent SSH tunnel for Claude-B (local:13847 -> gpc001gb-wg:3847)');
    expect(body).toContain('Type=simple');
    expect(body).toContain('Environment=AUTOSSH_GATETIME=0');
    expect(body).toContain('-L 13847:127.0.0.1:3847 \\');
    expect(body).toContain('  gpc001gb-wg');
    expect(body).toContain('ServerAliveInterval=30');
    expect(body).toContain('ServerAliveCountMax=3');
    expect(body).toContain('ExitOnForwardFailure=yes');
    expect(body).toContain('Restart=always');
    expect(body).toContain('RestartSec=10');
    // User scope uses default.target, not multi-user.target
    expect(body).toContain('WantedBy=default.target');
    expect(body).not.toContain('WantedBy=multi-user.target');
    // No User= field — user-mode systemd inherits from the invoker
    expect(body).not.toContain('\nUser=');
  });

  it('renders multi-user.target for system scope', () => {
    const body = renderUnit({
      name: 'gb', sshHost: 'gpc001gb-wg',
      localPort: 13847, remotePort: 3847, system: true
    });

    expect(body).toContain('WantedBy=multi-user.target');
    expect(body).not.toContain('WantedBy=default.target');
  });

  it('uses custom ports when provided', () => {
    const body = renderUnit({
      name: 'extra', sshHost: 'host.example',
      localPort: 22000, remotePort: 9000, system: false
    });

    expect(body).toContain('-L 22000:127.0.0.1:9000 \\');
    expect(body).toContain('local:22000 -> host.example:9000');
  });
});

describe('tunnel.unitName / unitPath', () => {
  it('prefixes the unit name correctly', () => {
    expect(unitName('gb')).toBe('cb-tunnel-gb.service');
    expect(unitName('my-host.01')).toBe('cb-tunnel-my-host.01.service');
  });

  it('routes to /etc/systemd/system for system scope', () => {
    expect(unitPath('gb', true)).toBe('/etc/systemd/system/cb-tunnel-gb.service');
  });

  it('routes to ~/.config/systemd/user for user scope', () => {
    expect(unitPath('gb', false)).toBe(`${homedir()}/.config/systemd/user/cb-tunnel-gb.service`);
  });
});

describe('tunnel.resolveSpec', () => {
  it('rejects invalid names', async () => {
    await expect(resolveSpec({ name: '', sshHost: 'h' })).rejects.toThrow(/invalid tunnel name/);
    await expect(resolveSpec({ name: '1abc', sshHost: 'h' })).rejects.toThrow(/invalid tunnel name/);
    await expect(resolveSpec({ name: 'has space', sshHost: 'h' })).rejects.toThrow(/invalid tunnel name/);
    await expect(resolveSpec({ name: 'has/slash', sshHost: 'h' })).rejects.toThrow(/invalid tunnel name/);
    await expect(resolveSpec({ name: 'a'.repeat(33), sshHost: 'h' })).rejects.toThrow(/invalid tunnel name/);
  });

  it('rejects missing sshHost', async () => {
    await expect(resolveSpec({ name: 'gb', sshHost: '' })).rejects.toThrow(/--tunnel-ssh-host is required/);
  });

  it('fills defaults: remotePort=3847, system=false, auto-picks localPort', async () => {
    const r = await resolveSpec({ name: 'gb', sshHost: 'gpc001gb-wg' });
    expect(r.name).toBe('gb');
    expect(r.sshHost).toBe('gpc001gb-wg');
    expect(r.remotePort).toBe(3847);
    expect(r.system).toBe(false);
    expect(r.localPort).toBeGreaterThanOrEqual(13847);
    expect(r.localPort).toBeLessThan(13947);
  });

  it('respects explicit ports', async () => {
    const r = await resolveSpec({
      name: 'gb', sshHost: 'h', localPort: 19999, remotePort: 4848, system: true
    });
    expect(r.localPort).toBe(19999);
    expect(r.remotePort).toBe(4848);
    expect(r.system).toBe(true);
  });

  it('accepts allowed name characters', async () => {
    const r = await resolveSpec({ name: 'host.01_dev-2', sshHost: 'h', localPort: 13847 });
    expect(r.name).toBe('host.01_dev-2');
  });
});
