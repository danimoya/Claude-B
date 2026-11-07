import { spawn } from 'child_process';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { getDataDir } from '../config/env.js';

/** Start the daemon installed alongside this CLI, retaining the caller's cwd. */
export async function startDaemon(): Promise<void> {
  const configDir = getDataDir();
  await mkdir(configDir, { recursive: true });
  const daemonPath = fileURLToPath(new URL('../daemon/index.js', import.meta.url));
  const daemon = spawn(process.execPath, [daemonPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CB_DATA_DIR: configDir },
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      daemon.off('spawn', onSpawn);
      reject(error);
    };
    const onSpawn = () => {
      daemon.off('error', onError);
      daemon.unref();
      resolve();
    };
    daemon.once('error', onError);
    daemon.once('spawn', onSpawn);
  });
}
