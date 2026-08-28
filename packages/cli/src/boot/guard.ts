/**
 * The boot guard (cli-auto-update-hardening H1 / section 5.1).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-19).
 *
 * WHY THIS LIVES BELOW `cli.tsx` AND NOT INSIDE `main()` (D-26). The instinct is
 * to put crash recovery in `cli.tsx::main()`. That covers a crash AFTER the
 * module graph loads and misses the class of failure that actually bricks npm
 * CLIs: `dist/cli.js` statically imports ~60 modules, and a release that fails to
 * IMPORT never reaches any line anyone wrote inside `main()`. An undeclared
 * dependency, a Node API that moved, a syntax error past the transpile target -
 * all of them raise before `main` exists.
 *
 * ==========================================================================
 * THE IMPORT LIST HERE IS A CONSTRAINT, NOT A COINCIDENCE (section 4 rule 2).
 *
 * This module may import `node:*`, `../update/state.js` and its own sibling in
 * `boot/` - AND NOTHING ELSE. Every module it pulls in is a module that can
 * crash before the guard that exists to survive crashes has run.
 *
 * IN PARTICULAR IT MUST NOT IMPORT `logging/logger.js`. `getLogger()` resolves
 * config on its way to a sink, so wiring it in here would drag the whole config
 * graph into the one module that has to survive a broken build - which is
 * exactly the failure this guard is for. So the guard is SILENT BY CONSTRUCTION
 * (D-42); the two facts worth having after the event are recorded by
 * `rollback.ts` and by `UpdateService`, both of which already have a logger.
 *
 * THE CHAIN IS NOT `node:*`-ONLY AND THE LIST MUST NOT BE READ AS CLAIMING SO
 * (P1-2). `../update/state.js` imports `../config/app-paths.js`, which imports
 * and CALLS `env-paths` at module scope. That third-party module is in this
 * graph, which is why `launcher.ts` imports this file DYNAMICALLY and inside a
 * `try` - so a release whose `node_modules` lost `env-paths` degrades to "no
 * guard, and the CLI reports its own crash normally" rather than to an
 * `ERR_MODULE_NOT_FOUND` from the bin entry. The residual hole is real and is
 * stated in section 5.1.5 rather than argued away; this list is what keeps it
 * from growing.
 * ==========================================================================
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readUpdateState, updateUpdateState, type UpdateState } from '../update/state.js';
import { performRollback } from './rollback.js';

/**
 * Non-zero exits of a version we installed before it is rolled back.
 *
 * DUPLICATED FROM `UPDATE_LIMITS.crashesBeforeRollback` RATHER THAN IMPORTED,
 * and the duplication is the point: `update/limits.ts` is pure and dependency-
 * free today, but it is a shared table that anyone may add an import to, and the
 * import list above is worth more than one deduplicated integer. It is a bare
 * number with no path and no name in it, so it is not the duplication
 * `config/app-paths.ts`'s header forbids.
 */
const CRASHES_BEFORE_ROLLBACK = 2;

let cachedVersion: string | null = null;

/**
 * `<root>/package.json`'s `version`, or `''`.
 *
 * Resolves the root the way `install-source.ts` does - `dirname(fileURLToPath(
 * import.meta.url))` then up two - which from `dist/boot/` lands on the package
 * root exactly as it does from `dist/update/`. DUPLICATED RATHER THAN IMPORTED
 * because the import list above keeps `install-source.js` out of this graph; it
 * is four lines of `node:*` with no path NAME in it (P2-4).
 *
 * The level count is load-bearing for the same reason it is there: this package
 * is compiled by plain `tsc` with `rootDir: ./src` and NO BUNDLER (C-16), so
 * `src/boot/guard.ts` really does land at `dist/boot/guard.js`.
 */
export function readOwnVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed = JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf-8')) as {
      version?: unknown;
    };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '';
  } catch {
    cachedVersion = '';
  }
  return cachedVersion;
}

/** Injected wholesale by the tests; `runBootGuard()` uses the real ones. */
export interface BootGuardDeps {
  readState?: () => UpdateState;
  writeState?: (patch: Partial<Omit<UpdateState, 'schema'>>) => unknown;
  version?: string;
  /** Called instead of `performRollback`, so no test spawns npm. */
  rollback?: (bad: string, good: string) => void;
  onExit?: (listener: (code: number) => void) => void;
  writeStderr?: (text: string) => void;
}

/**
 * Arm, count, disarm, or decide a rollback. Called once, from `launcher.ts`,
 * before `dist/cli.js` is imported.
 *
 * READ THE ORDER AGAINST THE FAILURE IT DEFENDS:
 *
 *  - `autoInstalledVersion !== version` IS THE ARMING CONDITION AND IT IS FIRST.
 *    That field is written by `performInstall` on success and cleared by
 *    `markBootHealthy`, so the guard is armed for exactly the window between "we
 *    installed X" and "X has been seen to start", and for no other launch of any
 *    version. Steady state - every launch on every machine except the first one
 *    after an auto-update - is ONE `readFileSync` of ~300 bytes and one string
 *    compare, with NO WRITE AT ALL. Reordering this check after anything else
 *    costs a write on every `aragon --version`.
 *
 *  - THE GUARD ONLY CLEANS UP DAMAGE WE CAUSED (D-29). If a user's own
 *    `npm i -g @aragon-agent/cli@broken` crashes, that is their install and
 *    their decision; an updater that silently reverts it is a worse actor than
 *    one that does nothing. It also bounds the blast radius of a bug in the
 *    guard itself to one unnecessary reinstall of a version the user was running
 *    an hour ago.
 *
 *  - THE THRESHOLD IS TESTED BEFORE THIS LAUNCH CAN CONTRIBUTE, so `2` means
 *    "two PREVIOUS launches of X exited non-zero" and the rollback happens on the
 *    third (D-30).
 *
 *  - THE ROLLBACK DOES NOT ABORT THE BOOT (D-31). Refusing to start would be the
 *    wrong trade: if the crash was transient the user is now locked out of a
 *    working CLI by our guess. The detached child completes regardless, so the
 *    worst case is one more crash followed by a good launch.
 *
 *  - THE COUNTER MOVES IN THE EXIT HOOK AND ONLY ON A NON-ZERO CODE (D-30a /
 *    P1-5). See `UpdateState.bootFailures`. The cost is stated rather than
 *    hidden: a release that dies WITHOUT running exit handlers (`SIGKILL`, a
 *    native segfault, `process.abort()`) is never counted and never rolled back.
 *    For a pure-JS CLI whose target failure is a module that will not import -
 *    which raises, and therefore exits `1` through the launcher's `.catch` -
 *    that is the right side of the trade.
 *
 * NEVER THROWS. `launcher.ts` wraps the call anyway, because a guard that throws
 * must never be the reason the CLI will not start.
 */
export function runBootGuard(deps: BootGuardDeps = {}): void {
  try {
    const read = deps.readState ?? readUpdateState;
    const write = deps.writeState ?? updateUpdateState;
    const version = deps.version ?? readOwnVersion();
    if (!version) return;

    const state = read();
    // FAST PATH: not our install, or already seen healthy. No write, no hook.
    if (state.autoInstalledVersion !== version) return;

    if (
      state.bootFailures >= CRASHES_BEFORE_ROLLBACK &&
      state.lastGoodVersion &&
      state.lastGoodVersion !== version
    ) {
      // WRITTEN HERE, SYNCHRONOUSLY, AND NOT INSIDE `performRollback` (P2-9).
      // That function is `async` and its first statement is a dynamic `import`,
      // which yields - so a line written in there would race the
      // `await import('./cli.js')` that follows and could land below whatever
      // the CLI prints. Written before the call, the ordering is a property of
      // the code rather than of the module loader's timing. C-10 permits this
      // one visible message because the TUI is not mounted yet: there is no
      // fixed frame to shift.
      const stderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
      stderr(`aragon ${version} failed to start twice; rolling back to ${state.lastGoodVersion}.\n`);
      const roll =
        deps.rollback ??
        ((bad: string, good: string) => {
          void performRollback(bad, good);
        });
      roll(version, state.lastGoodVersion);
      // No exit hook: the rollback has already disarmed the guard, and this
      // launch's own crash must not be counted against a cycle that is over.
      return;
    }

    const on = deps.onExit ?? ((listener: (code: number) => void) => process.on('exit', listener));
    on((code: number) => {
      try {
        if (code === 0) markBootHealthy(version, { readState: read, writeState: write });
        else write({ bootFailures: state.bootFailures + 1 });
      } catch {
        // An exit hook that throws prints an unactionable stack over whatever
        // the CLI last said. The bookkeeping is not worth that.
      }
    });
  } catch {
    // See the contract above: never throws.
  }
}

/**
 * Disarm the guard and record this version as the one to roll back TO.
 *
 * Called from two places, and both matter:
 *
 *  - `cli.tsx::runInteractive`, immediately after `render()` returns - the
 *    earliest moment at which "this build starts" is PROVEN: the module graph
 *    loaded, config resolved, Ink mounted. This is the primary, and it is what
 *    makes a long session that is later `SIGKILL`ed (terminal window closed,
 *    machine slept badly, OOM killer) still count as healthy.
 *  - the exit hook installed by `runBootGuard`, when the code is `0` - the
 *    backstop for `aragon -p`, `aragon config set`, `aragon --version` and every
 *    other path that never mounts Ink.
 *
 * IDEMPOTENT through the first-line guard, which is also the fast path: on every
 * ordinary launch this is one read and one string compare.
 *
 * `lastGoodVersion` is set here as well as at install time, deliberately: a
 * machine whose state file was deleted between the install and the next launch
 * converges to a correct rollback target after one healthy run.
 *
 * IT DOES NOT TOUCH `rolledBackFrom`, AND IT MUST NOT (P0-1e). An earlier draft
 * had this function clear the rollback notice; it could never have done so,
 * because in the session AFTER a rollback `autoInstalledVersion` is `''` and this
 * function returns on its first line before touching anything. The notice is
 * consumed by `UpdateService.start()` instead, which is also the only place that
 * can decide it has actually been shown (D-40).
 */
export function markBootHealthy(version: string, deps: BootGuardDeps = {}): void {
  try {
    if (!version) return;
    const read = deps.readState ?? readUpdateState;
    const write = deps.writeState ?? updateUpdateState;
    const state = read();
    if (state.autoInstalledVersion !== version) return;
    write({ autoInstalledVersion: '', bootFailures: 0, lastGoodVersion: version });
  } catch {
    // Bookkeeping. Never a reason to fail a session that is otherwise healthy.
  }
}
