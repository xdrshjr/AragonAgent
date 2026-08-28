/**
 * The cross-process install lock (cli-auto-update section 3.7).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * INHERITS `skills/lock.ts`'s PAYLOAD DISCIPLINE, NOT ITS ACQUISITION LOOP
 * (C-9). The payload shape, the TTL, the liveness probe, the
 * `LOCK_UNREADABLE_CONFIRMATIONS` rule and the uuid-guarded release are all the
 * same and are imported rather than restated. The retry loop is NOT:
 *
 * INVARIANT U-5b - ACQUISITION IS A SINGLE NON-BLOCKING ATTEMPT.
 * `acquireRootLock` busy-waits SYNCHRONOUSLY through `Atomics.wait` for up to
 * `LOCK_MAX_WAIT_MS = 5_000` and then THROWS. That is right for `aragon skills
 * install`, where a human typed the command and there is nothing else to do.
 * Here it would freeze the Ink render loop for five seconds, from a background
 * timer, in the feature whose entire requirement is that it is invisible. So:
 * one `wx` attempt, no sleep, no retry, no throw - `tryAcquireInstallLock()`
 * returns `null` on `EEXIST` after the staleness check, and the caller treats
 * that as INFORMATION (someone else is already installing) rather than failure.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import process from 'node:process';
import { getUpdateLockPath } from '../config/app-paths.js';
import { LOCK_UNREADABLE_CONFIRMATIONS } from '../skills/lock.js';
import { UPDATE_LIMITS } from './limits.js';

interface LockPayload {
  pid: number;
  host: string;
  startedAt: number;
  uuid: string;
}

export interface InstallLockHandle {
  /**
   * Phase two of U-4: rewrite the payload in place with the CHILD's pid.
   *
   * `uuid` and `startedAt` are preserved - the uuid is what `release()` matches
   * on, and `startedAt` is what the TTL measures, so replacing either here would
   * silently break one of the two recovery paths.
   */
  adoptChild(pid: number): void;
  release(): void;
}

export interface InstallLockOptions {
  now?: () => number;
  /** Injected for tests; defaults to `process.kill(pid, 0)` liveness probing. */
  isProcessAlive?: (pid: number) => boolean;
  /** Injected for tests; defaults to `<home>/update-install.lock`. */
  path?: string;
}

/**
 * `ESRCH` means gone. `EPERM` means the process EXISTS but belongs to another
 * user - treating that as dead would let one user steal another's lock, so it
 * reports alive. Verbatim from `skills/lock.ts`.
 */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function readLock(path: string): LockPayload | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as LockPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'number') return null;
    if (typeof parsed.uuid !== 'string' || typeof parsed.host !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** `wx` - atomic exclusive create. THIS SINGLE CALL IS THE MUTUAL EXCLUSION;
 *  everything else in this file is recovery policy. */
function tryCreate(path: string, payload: LockPayload): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    // An unwritable home is not a lock conflict, but it is equally a reason not
    // to install; the caller cannot act on the difference.
    return false;
  }
  try {
    writeSync(fd, JSON.stringify(payload));
  } finally {
    // Closed IMMEDIATELY: on Windows an open handle blocks `unlink`, so holding
    // it would make our own release fail and turn every lock into a
    // ten-minute stall for the next process.
    closeSync(fd);
  }
  return true;
}

/**
 * Take the install lock, or report that someone else has it. NEVER SLEEPS,
 * NEVER THROWS (U-5b / AC-27).
 *
 * The payload written here carries the PARENT's pid, and that is not a mistake:
 * INVARIANT U-4 says the lock must name the CHILD, but the lock has to be held
 * BEFORE the spawn (or the race it exists to close is wide open) and `child.pid`
 * does not exist UNTIL AFTER it. `skills/lock.ts::tryCreate` writes its payload
 * at create time, so a literal mirror can only ever write the parent's. Hence
 * two phases: this call, then `adoptChild(child.pid)` the moment `execFile`
 * returns.
 *
 * The window between them is SAFE rather than merely narrow: a crash inside it
 * leaves a lock naming a DEAD PARENT, which is exactly the case the liveness
 * probe below already reclaims.
 */
export function tryAcquireInstallLock(opts: InstallLockOptions = {}): InstallLockHandle | null {
  const now = opts.now ?? Date.now;
  const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;
  const path = opts.path ?? getUpdateLockPath();

  const payload: LockPayload = {
    pid: process.pid,
    host: hostname(),
    startedAt: now(),
    uuid: randomUUID(),
  };

  if (tryCreate(path, payload)) return makeHandle(path, payload);

  // Held. The ONLY thing we may do about it is decide whether the holder is
  // plausibly dead - and even then we get exactly one more `wx` attempt, because
  // two processes can judge the same lock stale at the same moment and `wx` is
  // the only thing entitled to decide between them.
  const holder = readLock(path);
  let stale: boolean;
  if (holder === null) {
    // One unreadable read is indistinguishable from a lock that is mid-creation
    // (create and write are two syscalls), so it is NOT evidence of abandonment.
    // With a single attempt there is no second probe to accumulate, so an
    // unreadable lock is left alone unless the discipline says one look is
    // enough - which, at `LOCK_UNREADABLE_CONFIRMATIONS = 2`, it is not.
    stale = LOCK_UNREADABLE_CONFIRMATIONS <= 1;
  } else {
    stale =
      now() - holder.startedAt > UPDATE_LIMITS.lockTtlMs ||
      (holder.host === payload.host && !isAlive(holder.pid));
  }
  if (!stale) return null;

  try {
    unlinkSync(path);
  } catch {
    // Another process won the race to clean it up, or the file is pinned by a
    // scanner holding a handle open on Windows. Either way: not ours this tick.
    return null;
  }
  return tryCreate(path, payload) ? makeHandle(path, payload) : null;
}

function makeHandle(path: string, payload: LockPayload): InstallLockHandle {
  let released = false;
  let current = payload;
  return {
    adoptChild(pid: number): void {
      if (released) return;
      const next: LockPayload = { ...current, pid };
      try {
        // A plain overwrite and NOT `wx`: we already own this file, and a
        // rename-based atomic swap would break the `wx` invariant for whoever is
        // probing it at this instant.
        writeFileSync(path, JSON.stringify(next), 'utf-8');
        current = next;
      } catch {
        // The lock keeps naming the parent. That degrades to the pre-U-4
        // behaviour for this one install - a lock that may be judged stale early
        // - and is strictly better than aborting an install that is already
        // running.
      }
    },
    release(): void {
      if (released) return;
      released = true;
      try {
        const holder = readLock(path);
        // THE UUID CHECK IS NOT DEFENSIVE PADDING (D-A10's argument, verbatim).
        // If this process was judged stale and preempted, an unconditional
        // `unlink` here would delete the NEW holder's lock and open a second
        // concurrency window - the classic file-lock bug, and one that only
        // shows up under exactly the contention the lock exists to handle.
        if (holder?.uuid !== current.uuid) return;
        unlinkSync(path);
      } catch {
        // A failed release costs at most one TTL of waiting for the next
        // process. Letting it throw would end a SUCCESSFUL install in an error.
      }
    },
  };
}
