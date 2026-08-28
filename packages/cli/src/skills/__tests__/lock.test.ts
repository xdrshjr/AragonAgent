/**
 * AC-A8 / AC-A9 / AC-A16 — the cross-process install lock (§7).
 *
 * AC-A9 is the one that matters most and is the easiest to fake. It asserts the
 * BYTES IN THE LOCK FILE after a preemption, not that `release()` returned
 * quietly. A `release()` that unlinks unconditionally also "does not throw" —
 * and it deletes the new holder's lock, opening a second race in the exact
 * scenario the lock was written for. Only reading the file back distinguishes
 * the two implementations (D-A10).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  LOCK_FILENAME,
  LOCK_MAX_WAIT_MS,
  LOCK_TTL_MS,
  LOCK_UNREADABLE_CONFIRMATIONS,
  SkillLockError,
  acquireRootLock,
} from '../lock.js';
import { cleanup, makeTmpDir, writeSkill } from './helpers.js';

const tmp = { root: '' };
const lockPath = (): string => join(tmp.root, LOCK_FILENAME);

function readLockFile(): { pid: number; host: string; startedAt: number; uuid: string } {
  return JSON.parse(readFileSync(lockPath(), 'utf-8'));
}

beforeEach(() => {
  tmp.root = makeTmpDir('aragon-lock-');
});
afterEach(() => cleanup(tmp.root));

describe('acquireRootLock — mutual exclusion (AC-A8)', () => {
  it('the second acquirer waits, then fails with a readable message', () => {
    const first = acquireRootLock(tmp.root);
    expect(existsSync(lockPath())).toBe(true);

    let slept = 0;
    let clock = Date.now();
    expect(() =>
      acquireRootLock(tmp.root, {
        now: () => clock,
        sleep: (ms) => {
          slept += ms;
          clock += ms;
        },
      }),
    ).toThrow(SkillLockError);

    // It genuinely waited rather than failing on the first EEXIST.
    expect(slept).toBeGreaterThanOrEqual(LOCK_MAX_WAIT_MS);
    first.release();
  });

  it('names the holding pid and the time, so "my other terminal" is diagnosable', () => {
    const first = acquireRootLock(tmp.root);
    let clock = Date.now();
    try {
      acquireRootLock(tmp.root, { now: () => clock, sleep: (ms) => (clock += ms) });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain(`pid ${process.pid}`);
      expect((err as Error).message).toMatch(/since \d{4}-\d{2}-\d{2}T/);
    }
    first.release();
  });

  it('succeeds once the holder releases', () => {
    const first = acquireRootLock(tmp.root);
    first.release();
    expect(existsSync(lockPath())).toBe(false);
    const second = acquireRootLock(tmp.root);
    expect(existsSync(lockPath())).toBe(true);
    second.release();
  });

  it('creates the root directory if it does not exist yet', () => {
    const fresh = join(tmp.root, 'not', 'yet', 'there');
    const lock = acquireRootLock(fresh);
    expect(existsSync(join(fresh, LOCK_FILENAME))).toBe(true);
    lock.release();
  });
});

describe('acquireRootLock — stale takeover', () => {
  it('takes over a lock older than the TTL', () => {
    const clockStart = 1_800_000_000_000;
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 999_999, host: 'other-host', startedAt: clockStart, uuid: 'old' }),
      'utf-8',
    );
    const lock = acquireRootLock(tmp.root, { now: () => clockStart + LOCK_TTL_MS + 1 });
    expect(readLockFile().pid).toBe(process.pid);
    lock.release();
  });

  it('takes over when the holder is a dead pid on THIS host', () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 4242, host: hostname(), startedAt: Date.now(), uuid: 'dead' }),
      'utf-8',
    );
    const lock = acquireRootLock(tmp.root, { isProcessAlive: () => false });
    expect(readLockFile().pid).toBe(process.pid);
    lock.release();
  });

  it('does NOT take over a live pid on this host', () => {
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 4242, host: hostname(), startedAt: Date.now(), uuid: 'live' }),
      'utf-8',
    );
    let clock = Date.now();
    expect(() =>
      acquireRootLock(tmp.root, {
        now: () => clock,
        sleep: (ms) => (clock += ms),
        isProcessAlive: () => true,
      }),
    ).toThrow(SkillLockError);
    expect(readLockFile().uuid).toBe('live');
  });

  it('does NOT liveness-probe a pid from a DIFFERENT host', () => {
    // pid 1 exists everywhere; deciding it is "our" pid 1 would let one machine
    // steal a lock held by another over a shared volume.
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 1, host: 'some-other-box', startedAt: Date.now(), uuid: 'remote' }),
      'utf-8',
    );
    let clock = Date.now();
    expect(() =>
      acquireRootLock(tmp.root, {
        now: () => clock,
        sleep: (ms) => (clock += ms),
        isProcessAlive: () => false,
      }),
    ).toThrow(SkillLockError);
    expect(readLockFile().uuid).toBe('remote');
  });

  it('takes over an unparseable lock file', () => {
    writeFileSync(lockPath(), 'not json at all', 'utf-8');
    const lock = acquireRootLock(tmp.root);
    expect(readLockFile().pid).toBe(process.pid);
    lock.release();
  });

  it('does NOT take over on the FIRST unreadable read — a lock may be mid-creation', () => {
    // `tryCreate` creates the file and writes the payload as two syscalls, so a
    // zero-byte lock can be microseconds old and about to become valid. Deleting
    // it on sight would leave two processes owning the root at once, which is
    // the precise race this module exists to close. The observable proof is that
    // the very first probe does not unlink: preemption costs at least one retry.
    writeFileSync(lockPath(), '', 'utf-8');
    let probes = 0;
    const lock = acquireRootLock(tmp.root, {
      sleep: () => {
        probes += 1;
      },
    });
    expect(probes).toBeGreaterThanOrEqual(LOCK_UNREADABLE_CONFIRMATIONS - 1);
    expect(readLockFile().pid).toBe(process.pid);
    lock.release();
  });

  it('gives up instead of spinning when a stale lock cannot be removed', () => {
    // A lock judged stale whose `unlink` keeps failing (a scanner holding the
    // handle open on Windows, a read-only directory) used to `continue` without
    // consulting the deadline: an unbounded, sleepless loop that hung the CLI
    // outright. Simulated here by making the root itself refuse the delete.
    const dirLock = join(tmp.root, LOCK_FILENAME);
    mkdirSync(dirLock, { recursive: true });
    // A DIRECTORY at the lock path: `openSync(…, 'wx')` reports EEXIST and
    // `unlinkSync` reports EPERM/EISDIR forever, so nothing can make progress.
    let clock = Date.now();
    expect(() =>
      acquireRootLock(tmp.root, { now: () => clock, sleep: (ms) => (clock += ms) }),
    ).toThrow(SkillLockError);
  });
});

describe('AC-A9 — release() only deletes a lock it still owns (D-A10)', () => {
  it('a preempted holder does NOT delete the new holder’s lock', () => {
    const original = acquireRootLock(tmp.root);
    const originalUuid = readLockFile().uuid;

    // Simulate: the original was judged stale and someone else took over.
    writeFileSync(
      lockPath(),
      JSON.stringify({ pid: 12_345, host: 'usurper', startedAt: Date.now(), uuid: 'NEW-HOLDER' }),
      'utf-8',
    );

    original.release();

    // THE assertion: the file still holds the NEW holder's uuid. A `release()`
    // that unlinked unconditionally would leave no file here at all, and the
    // next process would walk straight into a second concurrent commit.
    expect(existsSync(lockPath())).toBe(true);
    expect(readLockFile().uuid).toBe('NEW-HOLDER');
    expect(readLockFile().uuid).not.toBe(originalUuid);
  });

  it('release() is idempotent and never throws', () => {
    const lock = acquireRootLock(tmp.root);
    lock.release();
    expect(() => lock.release()).not.toThrow();
    expect(() => lock.release()).not.toThrow();
  });

  it('release() survives the lock file having been deleted by hand', () => {
    const lock = acquireRootLock(tmp.root);
    rmSync(lockPath(), { force: true });
    expect(() => lock.release()).not.toThrow();
  });
});

describe('AC-A16 — the lock file is invisible to discovery', () => {
  it('a lock in a skills root does not become a phantom skill', async () => {
    // Built from the real scanner rather than by reasoning about dot-prefixes:
    // the claim is about `discover()`'s behaviour, not about a naming rule.
    const { SkillService } = await import('../service.js');
    const { createNodeSkillHost } = await import('../node-host.js');
    const { recordingGate, runtimeOptions, skillsConfig } = await import('./helpers.js');

    const userRoot = join(tmp.root, 'user');
    mkdirSync(userRoot, { recursive: true });
    writeSkill(userRoot, 'real-skill');

    const service = new SkillService({
      host: createNodeSkillHost(),
      getCwd: () => join(tmp.root, 'cwd'),
      config: skillsConfig(),
      runtime: runtimeOptions(),
      approval: recordingGate({ canPrompt: false, approve: false }),
    });

    // Scan the root directly so the assertion does not depend on envPaths.
    const before = (service as unknown as {
      scanRoot: (r: { dir: string; scope: string; writable: boolean }, e: string[]) => unknown[];
    }).scanRoot({ dir: userRoot, scope: 'user', writable: true }, []);

    const lock = acquireRootLock(userRoot);
    const after = (service as unknown as {
      scanRoot: (r: { dir: string; scope: string; writable: boolean }, e: string[]) => unknown[];
    }).scanRoot({ dir: userRoot, scope: 'user', writable: true }, []);
    lock.release();

    expect(before).toHaveLength(1);
    expect(after).toHaveLength(1);
  });
});
