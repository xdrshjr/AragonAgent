/**
 * Per-root advisory install lock (spec §7).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS PREVENTS: two argon processes installing at once can DELETE a
 * skill, and the path that does it reports success.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `commitDirectory()` is `existsSync(target) → rename(target → .trash) →
 * rename(staging → target)`. Interleave two of those (§7.1):
 *
 *   A: existsSync = true  → moves the old version to .trash
 *   B: existsSync = false → decides there is no backup to take
 *   A: rename(stagingA → target)
 *   B: rename(stagingB → target)     ← overwrites A; A's backup is now orphaned
 *   A: rmSync(backup)                ← deletes the user's previous version
 *
 * If B then fails, its rollback is a no-op because it believes `backup === null`
 * — and the skill is gone. Nothing in that sequence throws.
 *
 * The lock is ADVISORY and PER WRITABLE ROOT (D-A9), not per skill: the danger
 * is the shared `.staging/.trash` bookkeeping, which a per-skill lock would not
 * cover. Serialising installs costs a few seconds of queueing on a command a
 * human typed.
 *
 * KNOWN LIMIT (RA4): `wx` is atomic on local filesystems and on SMB, but not
 * reliably on every NFS implementation. The TTL and the 5-second ceiling below
 * mean the worst case there is the CURRENT behaviour (no mutual exclusion) — a
 * deadlock is not reachable.
 */

import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A FILE, and dot-prefixed. `discover()` only considers `isDirectory` entries
 * and already skips dotfiles, so the lock is invisible to the scanner twice
 * over — asserted by `lock.test.ts` rather than left to reasoning (AC-A16).
 */
export const LOCK_FILENAME = '.argon-skills.lock';

/** A lock older than this is presumed abandoned. */
export const LOCK_TTL_MS = 60_000;

export const LOCK_RETRY_MS = 250;

/** Total time spent waiting before giving up with a readable message. */
export const LOCK_MAX_WAIT_MS = 5_000;

/**
 * Consecutive unreadable reads required before a lock is presumed abandoned.
 *
 * MUST BE > 1. `tryCreate()` creates the file and writes its payload as two
 * separate syscalls, so a competing process can legitimately observe a
 * zero-byte lock that is microseconds old. Treating that single observation as
 * "corrupt, therefore abandoned" would delete a lock that is about to become
 * valid and leave two processes both believing they own the root — precisely
 * the race this module exists to close, and one that only appears under the
 * contention the lock was written for. Re-reading a retry later costs 250 ms in
 * the genuinely-corrupt case and removes the window in every other.
 */
export const LOCK_UNREADABLE_CONFIRMATIONS = 2;

export class SkillLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillLockError';
  }
}

export interface LockHandle {
  release(): void;
}

interface LockPayload {
  pid: number;
  host: string;
  startedAt: number;
  uuid: string;
}

export interface AcquireLockOptions {
  now?: () => number;
  sleep?: (ms: number) => void;
  /** Injected for tests; defaults to `process.kill(pid, 0)` liveness probing. */
  isProcessAlive?: (pid: number) => boolean;
}

/** Busy-wait. Deliberate: this runs in a CLI command, and there is nothing else to do. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Is `pid` still running?
 *
 * `ESRCH` means gone. `EPERM` means the process EXISTS but belongs to another
 * user — treating that as dead would let one user steal another's lock, so it
 * reports alive.
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

/** Write the lock file exclusively, or report that someone else holds it. */
function tryCreate(path: string, payload: LockPayload): boolean {
  let fd: number;
  try {
    // `wx` — atomic exclusive create. This single call is the entire
    // correctness argument; everything else is recovery policy.
    fd = openSync(path, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(payload));
  } finally {
    // Closed IMMEDIATELY: on Windows an open handle blocks `unlink`, so holding
    // it would make our own release fail and turn every lock into a 60-second
    // stall for the next process.
    closeSync(fd);
  }
  return true;
}

/**
 * Take the install lock for `root`, blocking until it is free or the ceiling
 * elapses.
 *
 * @throws {SkillLockError} when another live process holds it for longer than
 *   `LOCK_MAX_WAIT_MS`. The message names the pid and the time so the user can
 *   tell "my other terminal" from "a crashed process".
 */
export function acquireRootLock(root: string, opts: AcquireLockOptions = {}): LockHandle {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepSync;
  const isAlive = opts.isProcessAlive ?? defaultIsProcessAlive;

  mkdirSync(root, { recursive: true });
  const path = join(root, LOCK_FILENAME);
  const payload: LockPayload = {
    pid: process.pid,
    host: hostname(),
    startedAt: now(),
    uuid: randomUUID(),
  };

  const deadline = now() + LOCK_MAX_WAIT_MS;
  let unreadableProbes = 0;

  for (;;) {
    if (tryCreate(path, payload)) return makeHandle(path, payload.uuid);

    const holder = readLock(path);
    let stale: boolean;
    if (holder === null) {
      // See LOCK_UNREADABLE_CONFIRMATIONS: one unreadable read is indistinguishable
      // from a lock that is mid-creation, so it is not evidence of abandonment.
      unreadableProbes += 1;
      stale = unreadableProbes >= LOCK_UNREADABLE_CONFIRMATIONS;
    } else {
      unreadableProbes = 0;
      stale =
        now() - holder.startedAt > LOCK_TTL_MS ||
        (holder.host === payload.host && !isAlive(holder.pid));
    }

    let preempted = false;
    if (stale) {
      try {
        unlinkSync(path);
        preempted = true;
      } catch {
        // Either another process won the race to clean it up, or the file is
        // pinned (a scanner holding a handle open on Windows). Fall through to
        // the timed wait rather than retrying immediately: an unlink that keeps
        // failing would otherwise spin here forever, and a CLI that never
        // returns is a worse outcome than one that reports a busy lock.
      }
    }

    // Evaluated on EVERY iteration, including the preemption path, so that no
    // branch of this loop can run unbounded.
    if (now() >= deadline) throw lockBusyError(holder);

    // A successful preemption goes straight back to `tryCreate` rather than
    // assuming ownership: two processes can judge the same lock stale at the
    // same moment, and `wx` is the only thing entitled to decide between them.
    if (!preempted) sleep(LOCK_RETRY_MS);
  }
}

/** The give-up message. Names the holder when there is one to name. */
function lockBusyError(holder: LockPayload | null): SkillLockError {
  const who = holder
    ? `pid ${holder.pid} since ${new Date(holder.startedAt).toISOString()}`
    : 'an unreadable lock file that could not be cleared';
  return new SkillLockError(
    `another argon process is installing skills (lock held by ${who}); retry in a moment`,
  );
}

/**
 * Release only OUR lock (D-A10).
 *
 * The uuid check is not defensive padding. If this process was judged stale and
 * preempted, an unconditional `unlink` here would delete the NEW holder's lock
 * and open a second concurrency window — the classic file-lock bug, and one
 * that only shows up under exactly the contention the lock exists to handle.
 */
function makeHandle(path: string, uuid: string): LockHandle {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      try {
        const holder = readLock(path);
        if (holder?.uuid !== uuid) return;
        unlinkSync(path);
      } catch {
        // A failed release costs at most one TTL of waiting for the next
        // process. Letting it throw would end a SUCCESSFUL install in an error.
      }
    },
  };
}
