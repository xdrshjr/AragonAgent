/**
 * Killing a process TREE, on both platform families
 * (background-service-supervision §3.5 / P1-1 / P1-2).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * ONE OWNER FOR BOTH KINDS OF CHILD. This was `bash-tool.ts`'s private helper;
 * hoisting it is what lets a foreground `bash` child and a supervised service be
 * reaped by the same code, which is the only way "no service outlives the CLI"
 * can be true on every exit path.
 *
 * THE POSIX BRANCH IS A PROCESS-GROUP KILL, NOT `child.kill()` (P1-1). With
 * `shell: true` the direct child is the shell wrapper, and `npm run dev` re-execs
 * into node children that survive a signal aimed at the shell alone — which is
 * why every `npm run dev` grandchild used to survive today's `killTree` on
 * POSIX. `process.kill(-pid, sig)` reaches the whole group, and a group only
 * EXISTS because `supervisor.ts` spawns with `detached: true` there. On Windows
 * the flag is irrelevant to reaping: `taskkill /t` walks the parent-child table.
 *
 * THE SYNC VARIANT EXISTS BECAUSE `spawn` IS ASYNCHRONOUS (P1-2). A process that
 * is already exiting will not live long enough for an async `taskkill`, and
 * `process.on('exit')` permits only synchronous work — so the reaper an exit hook
 * calls must be `spawnSync` end to end.
 */

import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

/** Is the pid still there? `signal 0` tests for existence without delivering. */
export function isAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which for our purposes
    // is still "alive" - reporting it dead would make the honest
    // "may have left a detached child" warning silently unreachable.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Kill the tree rooted at `pid`, asynchronously. Best-effort; never throws.
 *
 * `signal` is honoured on POSIX (so a graceful `SIGTERM` -> `SIGKILL` ladder is
 * possible); Windows `taskkill /f` has no gentle mode, so a `SIGTERM` there is a
 * plain `taskkill` without `/f` and the escalation adds it.
 */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/t'];
    if (signal === 'SIGKILL') args.push('/f');
    try {
      const child = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      // A reaper must never be the reason the CLI does not exit (I-3), and it
      // must never crash it either: `taskkill` missing from PATH emits 'error'.
      child.unref();
      child.on('error', () => {});
    } catch {
      /* ignore */
    }
    return;
  }
  // THE GROUP FIRST, THE PID SECOND. The group is what reaches the grandchild;
  // the single-pid fallback covers a child that was NOT spawned detached (a
  // foreground `bash` child), where `-pid` is not a group at all.
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* fall through to the single-process attempt */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Kill the tree rooted at `pid`, SYNCHRONOUSLY. Never throws, never awaits.
 *
 * The only kill primitive a signal handler, `process.on('exit')` or
 * `handleFatal` may reach (I-9). No escalation ladder and no logging: a reaper
 * that can block or throw is worse than one that misses a child.
 */
export function killTreeSync(pid: number | undefined): void {
  if (pid === undefined || !Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 2000,
      });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
