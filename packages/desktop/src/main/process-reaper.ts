/**
 * Killing a process TREE, and telling a pid's identity by its creation time.
 *
 * Windows has no process groups to signal, so the tree is walked by `taskkill /T /F`.
 * POSIX hosts are started as group leaders, so a negative pid signals the whole group
 * (`SIGTERM`, then `SIGKILL` a second later for whatever ignored it). Everything is
 * best-effort and NEVER throws: this runs on the quit and crash paths, where a failure to
 * clean up must not become a failure to quit.
 */

import { execFile, execFileSync } from 'node:child_process';
import process from 'node:process';
import type { ProcessReaper } from './session-supervisor.js';

function run(file: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

export function createProcessReaper(platform: NodeJS.Platform = process.platform): ProcessReaper {
  return {
    async killTree(pid: number): Promise<void> {
      if (!Number.isInteger(pid) || pid <= 1) return;
      if (platform === 'win32') {
        await run('taskkill', ['/PID', String(pid), '/T', '/F']);
        return;
      }
      for (const target of [-pid, pid]) {
        try { process.kill(target, 'SIGTERM'); } catch { /* no such group or process */ }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const target of [-pid, pid]) {
        try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
      }
    },

    startedAt(pid: number): number | null {
      return processStartTime(pid, platform);
    },
  };
}

/**
 * Creation time of a live pid in epoch ms, or null if it is gone or cannot be read. The host
 * records the same value for each descendant, so equality (within a couple of seconds)
 * proves the pid has not been recycled.
 */
export function processStartTime(pid: number, platform: NodeJS.Platform = process.platform): number | null {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
  }
  try {
    if (platform === 'win32') {
      const out = execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 4000 }).trim();
      const parsed = Date.parse(out);
      return Number.isFinite(parsed) ? parsed : null;
    }
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim();
    const parsed = Date.parse(`${out} UTC`);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
