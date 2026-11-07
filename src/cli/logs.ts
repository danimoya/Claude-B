import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '../config/env.js';

/** Read a bounded tail without connecting to or starting the daemon. */
export async function readLogTail(maxBytes = 64 * 1024, maxLines = 100): Promise<{ path: string; text: string; missing: boolean }> {
  const path = join(getDataDir(), 'daemon.log');
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: '', missing: true };
    throw error;
  }
  try {
    const { size } = await file.stat();
    const bytes = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await file.read(bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    let text = bytes.subarray(0, bytesRead).toString('utf8');
    // Discard a possibly partial leading line when reading from mid-file.
    if (size > bytes.length) text = text.slice(text.indexOf('\n') + 1);
    const lines = text.replace(/\n$/, '').split('\n');
    return { path, text: lines.slice(-maxLines).join('\n'), missing: false };
  } finally {
    await file.close();
  }
}
