/**
 * The rollback (cli-auto-update-hardening H1 / section 5.1.3).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-19).
 *
 * EVERY IMPORT THAT DOES REAL WORK IS DYNAMIC, AND FOR A REASON THAT IS NOT THE
 * USUAL ONE. This function runs inside a build we have CONCRETE EVIDENCE is
 * broken - it was reached because that build failed to start twice - so every
 * one of `install-lock`, `installer` and `install-source` can reject on import.
 * The whole body is inside one `try`, and the `catch` records one line and
 * returns. Static `import type` specifiers below are erased by tsc and are not
 * runtime edges, which is what keeps `guard.ts`'s own graph inside the list its
 * header pins down.
 *
 * `../update/state.js` IS THE ONE EXCEPTION and is imported statically: the
 * guard has already loaded and read it before it can possibly call us, so a
 * static edge here adds no failure mode that has not already been survived.
 */

import process from 'node:process';
import { readUpdateState, updateUpdateState, type UpdateState } from '../update/state.js';
import type { InstallLockHandle } from '../update/install-lock.js';
import type { InstallResult, RunNpmInstallInput } from '../update/installer.js';

/** What stopped us, when something did. `undefined` on the happy path. */
export type RollbackFailure =
  | 'no-package-root'
  | 'source-ineligible'
  | 'not-writable'
  | 'locked'
  | 'install-failed'
  | 'error';

export interface RollbackResult {
  ok: boolean;
  failure?: RollbackFailure;
}

/** What this module resolved about the machine, injected wholesale by tests. */
export interface RollbackTarget {
  root: string | null;
  packageName: string;
  autoInstallable: boolean;
  writable: boolean;
}

export interface RollbackDeps {
  readState?: () => UpdateState;
  writeState?: (patch: Partial<Omit<UpdateState, 'schema'>>) => unknown;
  /** Injected together; when all four are present nothing is imported at all. */
  resolveTarget?: () => Promise<RollbackTarget>;
  acquireLock?: () => InstallLockHandle | null;
  install?: (input: RunNpmInstallInput) => Promise<InstallResult>;
  log?: (level: 'info' | 'warn', msg: string, data: Record<string, unknown>) => void;
}

/** Best-effort, and deliberately so: a logger that fails must not stop a
 *  rollback that is the user's only way back to a working CLI. */
async function record(
  deps: RollbackDeps,
  level: 'info' | 'warn',
  msg: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    if (deps.log) {
      deps.log(level, msg, data);
      return;
    }
    const { getLogger } = await import('../logging/logger.js');
    getLogger().child('update')[level](msg, data);
  } catch {
    // No logger, or a broken one. The stderr line the guard already wrote is
    // the part the user needs.
  }
}

async function defaultResolveTarget(): Promise<RollbackTarget> {
  const { classifyInstallSource, isAutoInstallable, probeWritable, readSelfManifest, selfPackageRoot } =
    await import('../update/install-source.js');
  const root = selfPackageRoot();
  if (!root) return { root: null, packageName: '', autoInstallable: false, writable: false };
  return {
    root,
    packageName: readSelfManifest(root)?.name ?? '',
    autoInstallable: isAutoInstallable(classifyInstallSource(root)),
    writable: probeWritable(root),
  };
}

/**
 * Reinstall `good` and latch `bad` so nothing puts it back.
 *
 * THE ORDER OF OPERATIONS IS LOAD-BEARING.
 *
 * 1. LATCH FIRST, INSTALL SECOND. If the process dies between the latch and the
 *    spawn, the machine is left running a broken version that WILL NOT BE
 *    REINSTALLED - recoverable by hand. In the other order, a death between the
 *    spawn and the latch leaves a good version installed with no latch, and the
 *    next check reinstalls the bad one.
 *
 *    `skippedVersion` is part of that write and is the reason it works across
 *    versions (C-17 / D-28): `readUpdateState` rebuilds from a fixed field list,
 *    so an OLDER `aragon` writing this file erases every field it does not know.
 *    `skippedVersion` is schema-1 and every shipped version honours it through
 *    `decideUpdate`. Per section 1.2 the ordinary rollback target is itself an H1
 *    build and preserves all four new fields; this covers the cases that
 *    argument does not reach - a hand-edited state file, a user who manually
 *    installs a pre-H1 version, and any future field that matters across the
 *    boundary.
 *
 *    `rolledBackFrom` IS WRITTEN HERE AND NOWHERE ELSE (P0-1d). It is consumed
 *    exactly once, by `UpdateService.start()`, which is the only thing that can
 *    decide the notice has actually been shown.
 *
 * 2. RE-CLASSIFY BEFORE SPAWNING. The machine may have changed since the
 *    install; we do not run `npm i -g` on a tree we would not have installed
 *    into.
 *
 * 3. ONE NON-BLOCKING LOCK ATTEMPT (U-5b). If another process holds it, return:
 *    it is either installing or already rolling back, and two concurrent
 *    `npm i -g` on one prefix is the one thing the lock exists to stop.
 *
 * 4. `runNpmInstall` VERBATIM. It already validates the version against
 *    `STRICT_VERSION_RE`, spawns detached through `process.execPath`, writes to
 *    a real fd and verifies the classified root afterwards (U-6). A rollback is
 *    an install; it does not deserve a second code path.
 *
 * The stderr line belongs to `runBootGuard` and is written before this is called
 * (P2-9). NEVER THROWS: the guard invokes it without `await` and cannot handle a
 * rejection.
 */
export async function performRollback(
  bad: string,
  good: string,
  deps: RollbackDeps = {},
): Promise<RollbackResult> {
  const write = deps.writeState ?? updateUpdateState;
  const read = deps.readState ?? readUpdateState;
  try {
    // Read BEFORE the latch: the write below zeroes `bootFailures`, and the
    // count is the one number worth keeping in the log record.
    const failures = read().bootFailures;

    // Step 1 - the latch, in ONE write.
    write({
      skippedVersion: bad,
      pendingRestartVersion: '',
      bootFailures: 0,
      autoInstalledVersion: '',
      rolledBackFrom: bad,
    });

    // Step 2 - re-classify.
    const target = await (deps.resolveTarget ?? defaultResolveTarget)();
    if (!target.root || target.packageName.length === 0) {
      await record(deps, 'warn', 'update_rollback_failed', {
        from: bad,
        to: good,
        reason: 'no-package-root',
      });
      return { ok: false, failure: 'no-package-root' };
    }
    if (!target.autoInstallable) {
      await record(deps, 'warn', 'update_rollback_failed', {
        from: bad,
        to: good,
        reason: 'source-ineligible',
      });
      return { ok: false, failure: 'source-ineligible' };
    }
    if (!target.writable) {
      await record(deps, 'warn', 'update_rollback_failed', {
        from: bad,
        to: good,
        reason: 'not-writable',
      });
      return { ok: false, failure: 'not-writable' };
    }

    // Step 3 - the ordinary install lock.
    const acquire =
      deps.acquireLock ??
      (await import('../update/install-lock.js')).tryAcquireInstallLock;
    const lock = acquire();
    if (!lock) {
      await record(deps, 'warn', 'update_rollback_failed', {
        from: bad,
        to: good,
        reason: 'locked',
      });
      return { ok: false, failure: 'locked' };
    }

    // Step 4 - the install, reused.
    const install = deps.install ?? (await import('../update/installer.js')).runNpmInstall;
    let result: InstallResult;
    try {
      result = await install({
        packageName: target.packageName,
        version: good,
        root: target.root,
        // Phase two of U-4, exactly as `performInstall` does it: the lock had to
        // precede the spawn, and it is rewritten to the child's pid the instant
        // the child exists. `adoptChild` closes over its own state and may be
        // passed unbound.
        onSpawn: lock.adoptChild,
      });
    } finally {
      lock.release();
    }

    if (!result.ok) {
      await record(deps, 'warn', 'update_rollback_failed', {
        from: bad,
        to: good,
        reason: result.failure ?? 'install-failed',
      });
      return { ok: false, failure: 'install-failed' };
    }

    await record(deps, 'warn', 'update_rolled_back', { from: bad, to: good, failures });
    return { ok: true };
  } catch (err) {
    // The one place this module writes to the terminal itself, and only because
    // the alternative is a silent no-op on the path the user is already stuck on.
    try {
      process.stderr.write(
        `aragon: rollback to ${good} could not run (${err instanceof Error ? err.message : String(err)}).\n`,
      );
    } catch {
      // stderr is gone too. Nothing further is available to us.
    }
    await record(deps, 'warn', 'update_rollback_failed', { from: bad, to: good, reason: 'error' });
    return { ok: false, failure: 'error' };
  }
}
