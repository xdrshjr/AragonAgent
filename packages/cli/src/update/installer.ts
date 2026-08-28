/**
 * The install (cli-auto-update section 3.5).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * INVARIANT U-2 - INVOKE NPM'S JS ENTRY THROUGH `process.execPath`, NEVER THE
 * `npm` SHIM. On Windows `npm` is `npm.cmd`, and since the CVE-2024-27980 fix
 * Node refuses to spawn a `.cmd` without `shell: true` - which C-7 forbids
 * outright. Running node's own binary also guarantees the update is installed by
 * the same runtime that will execute it.
 *
 * INVARIANT U-5 - THE CHILD'S OUTPUT GOES TO A FILE, AND ITS LIFETIME IS NEVER
 * BOUNDED BY US. `'ignore'` leaves nothing to put in `update_install_failed`'s
 * `stderrTail`, which is the one diagnostic a feature whose contract is silence
 * actually needs; a PIPE would break D-10, because a detached child whose parent
 * has exited takes `EPIPE` on its next write. A real file descriptor is
 * inherited across the detach and keeps working after the parent is gone.
 *
 * `spawn`, NOT `execFile`, AND THAT IS A CORRECTION TO THE DESIGN (IF-3).
 * Section 3.5 spelled this call as `execFile(..., { detached: true, stdio:
 * [...], timeout: 0 })`, but `execFile` forwards NEITHER `detached` NOR `stdio`
 * to `spawn` - it always builds its own pipes so it can buffer the output it
 * hands to its callback. Measured on this package's own Node: with
 * `stdio: ['ignore', fd, fd]` the log file stays EMPTY and the bytes arrive in
 * the callback's `stdout` instead. Written as designed, U-5 loses its
 * `stderrTail` AND D-10 loses the detach, silently and on every platform.
 * `spawn` with an argv array and an explicit `shell: false` satisfies C-7's
 * actual requirement ("argv array, never a shell, never a concatenated command
 * line"), and it has no `timeout` option at all - so P1-5's "the limit must
 * never become the child's bound" holds STRUCTURALLY here rather than by
 * remembering to leave a field at `0`.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { getUpdateInstallLogPath } from '../config/app-paths.js';
import { UPDATE_LIMITS } from './limits.js';
import { readSelfManifest } from './install-source.js';
import { STRICT_VERSION_RE } from './semver.js';

/** The child handle this module needs. Injectable so no test spawns npm. */
export interface SpawnedChild {
  pid?: number | undefined;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  unref?: () => void;
}

export type SpawnImpl = (file: string, args: string[], options: SpawnOptions) => SpawnedChild;

export interface InstallResult {
  /** `true` only when npm exited 0 AND the classified root actually moved. */
  ok: boolean;
  /**
   * Why not, when not. `'ineffective'` is U-6's case and is NOT a failure of
   * npm - it is a failure of our assumption about WHERE npm writes.
   */
  failure?: 'spawn' | 'exit' | 'ineffective';
  /** What `<root>/package.json` reported after the install. */
  observedVersion?: string;
  /** Bounded tail of the install log. The caller redacts before logging it. */
  stderrTail?: string;
  exitCode?: number;
  elapsedMs?: number;
}

export interface InstallDeps {
  spawnImpl?: SpawnImpl;
  now?: () => number;
  /** `null` forces the "no npm entry point" branch; `undefined` probes. */
  npmCliPath?: string | null;
  logPath?: string;
  /** Injected so U-6's re-read can be exercised without a real install. */
  readVersionAt?: (root: string) => string | null;
  env?: NodeJS.ProcessEnv;
}

export interface RunNpmInstallInput {
  packageName: string;
  version: string;
  /** The root section 3.2 classified; U-6 re-reads its manifest afterwards. */
  root: string;
  /** Called with the child's pid the instant it exists - phase two of U-4. */
  onSpawn?: (pid: number) => void;
  deps?: InstallDeps;
}

/**
 * Where npm's JS entry point lives, or `null`.
 *
 * Probes the Windows / nvm4w layout first and the POSIX one second. There is
 * deliberately NO bare-`npm`-on-PATH fallback: on Windows that resolves to
 * `npm.cmd`, which is exactly what U-2 forbids, and a fallback that is correct
 * on one platform and forbidden on another is the kind of branch that gets
 * copied without its condition. A machine with no reachable `npm-cli.js`
 * degrades to notify-only, which is the honest outcome.
 */
export function resolveNpmCli(execPath: string = process.execPath): string | null {
  const nodeDir = dirname(execPath);
  const candidates = [
    resolve(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // Unreadable candidate; try the next.
    }
  }
  return null;
}

/**
 * `env` minus `NODE_OPTIONS`, plus the three switches that keep npm's
 * postinstall banners from spawning anything interactive.
 *
 * `NODE_OPTIONS` is dropped because a `--require` hook inherited into npm is an
 * unnecessary surface on a process we start unattended and never watch.
 */
export function cleanInstallEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  delete next.NODE_OPTIONS;
  next.npm_config_yes = 'true';
  next.ADBLOCK = '1';
  next.DISABLE_OPENCOLLECTIVE = '1';
  return next;
}

/** The argv this feature is allowed to build. Exported for AC-24's assertion. */
export function buildInstallArgs(
  npmCliJs: string,
  packageName: string,
  version: string,
): string[] {
  return [
    npmCliJs,
    'install',
    '--global',
    `${packageName}@${version}`,
    '--no-fund',
    '--no-audit',
    '--loglevel=error',
  ];
}

function tailOf(path: string, maxChars: number): string {
  try {
    const text = readFileSync(path, 'utf-8');
    return text.length <= maxChars ? text : text.slice(-maxChars);
  } catch {
    return '';
  }
}

/**
 * Install `packageName@version` globally, detached, and verify it landed HERE.
 *
 * Resolves when the child exits (or fails to start). The child is `unref()`ed
 * either way, so if the user quits mid-install the install COMPLETES rather than
 * leaving a global package half-written; the next launch's check then finds
 * local === remote and does nothing. Convergence, not bookkeeping (D-10).
 *
 * NEVER REJECTS. Every failure is an `InstallResult` with `ok: false`, because
 * the only caller is a background timer whose contract is silence.
 */
export function runNpmInstall(input: RunNpmInstallInput): Promise<InstallResult> {
  const { packageName, version, root, onSpawn } = input;
  const deps = input.deps ?? {};
  const now = deps.now ?? Date.now;
  const doSpawn = (deps.spawnImpl ?? (spawn as unknown as SpawnImpl)) as SpawnImpl;
  const logPath = deps.logPath ?? getUpdateInstallLogPath();
  const readVersionAt =
    deps.readVersionAt ?? ((where: string) => readSelfManifest(where)?.version ?? null);

  return new Promise<InstallResult>((settle) => {
    // The version came back from the registry and has already been through
    // `parseSemver`; this is the gate that makes "not an injection surface" a
    // checkable claim rather than a reasoned one (AC-24). It also satisfies
    // `fetch-source.ts` rule 3 (no leading `-`) by construction.
    if (!STRICT_VERSION_RE.test(version)) {
      settle({ ok: false, failure: 'spawn' });
      return;
    }
    const npmCliJs = deps.npmCliPath !== undefined ? deps.npmCliPath : resolveNpmCli();
    if (!npmCliJs) {
      settle({ ok: false, failure: 'spawn' });
      return;
    }

    // A stale log from a parent that died before its child is unlinked here, so
    // the tail read later can only be THIS install's (U-5).
    try {
      rmSync(logPath, { force: true });
    } catch {
      // Best-effort; an unremovable stale log costs one misleading tail.
    }

    let logFd: number | null = null;
    try {
      logFd = openSync(logPath, 'w');
    } catch {
      // No log file means no `stderrTail`, which is a diagnostic loss and not a
      // reason to skip the install.
      logFd = null;
    }

    const startedAt = now();
    let settled = false;
    const finish = (result: InstallResult): void => {
      if (settled) return;
      settled = true;
      if (logFd !== null) {
        try {
          closeSync(logFd);
        } catch {
          // Already closed; the child holds its own duplicated descriptor.
        }
      }
      settle({ ...result, elapsedMs: now() - startedAt });
    };

    const options: SpawnOptions = {
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      env: cleanInstallEnv(deps.env ?? process.env),
      // C-7, spelled out rather than inherited from the default: this argv is
      // built from a manifest on disk and a registry response, and a `true` here
      // would turn both into shell input.
      shell: false,
      windowsHide: true,
    };

    let child: SpawnedChild;
    try {
      child = doSpawn(process.execPath, buildInstallArgs(npmCliJs, packageName, version), options);
    } catch {
      finish({ ok: false, failure: 'spawn' });
      return;
    }

    child.on('error', () => finish({ ok: false, failure: 'spawn' }));

    child.on('exit', (code) => {
      const tail = tailOf(logPath, UPDATE_LIMITS.stderrTailChars);
      try {
        rmSync(logPath, { force: true });
      } catch {
        // The next install unlinks it before opening.
      }
      if (code !== 0) {
        finish({
          ok: false,
          failure: 'exit',
          ...(tail ? { stderrTail: tail } : {}),
          ...(typeof code === 'number' ? { exitCode: code } : {}),
        });
        return;
      }

      // ---------------------------------------------------------------------
      // U-6 - `npm` EXITING 0 DOES NOT MEAN THIS INSTALLATION MOVED.
      //
      // Section 3.2 classifies the running copy by PATH; `npm install --global`
      // writes to the prefix NPM'S OWN CONFIG resolves. Those are the same
      // directory on an ordinary machine and different directories on one with
      // `prefix=` in `.npmrc`, with two Node installations, or with a global
      // root inherited from a version manager the user has since switched away
      // from. Left unchecked the state machine reaches `ready` on a lie,
      // `pendingRestartVersion` never matches, and the next check re-decides
      // `install` - an UNBOUNDED SILENT REINSTALL, once per interval, forever
      // (R-12). The check costs one `readFileSync` of a file we already know how
      // to parse, and it is the only thing standing between this design and the
      // worst failure shape available to a feature that promised to be invisible.
      // ---------------------------------------------------------------------
      const observed = readVersionAt(root);
      if (observed !== version) {
        finish({
          ok: false,
          failure: 'ineffective',
          ...(observed ? { observedVersion: observed } : {}),
          ...(tail ? { stderrTail: tail } : {}),
        });
        return;
      }
      finish({ ok: true, observedVersion: observed, exitCode: 0 });
    });

    // Phase two of U-4, and it must happen HERE: the lock had to be taken before
    // the spawn, but `child.pid` does not exist until after it.
    if (typeof child.pid === 'number' && onSpawn) onSpawn(child.pid);
    // Survives our own exit (D-10). `dispose()` deliberately never kills it
    // (U-3): killing a running `npm install -g` is the one action in this
    // feature that can leave the user's global installation broken, and it would
    // be triggered by the most ordinary event there is - Ctrl+C.
    child.unref?.();
  });
}
