/**
 * The `/branch` port: flush, plan, spawn (tui-branch-terminal-shortcut 3.6).
 *
 * ASCII ONLY - `src/session/**` is inside `glyphs.test.ts::inScope`.
 *
 * ORDER IS CORRECTNESS (I-1). The child process's first act is to read the parent
 * session file, and the parent's checkpoint is debounced and fingerprint-
 * short-circuited (`checkpoint.ts`). Spawning before a successful FORCED write
 * means the branch can read the previous turn - or, after `aragon sessions rm
 * <id>`, no file at all - and the user sees "the branch opened but lost the last
 * ten turns". That is a data defect, not a UX one, so `checkpoint({force:true})`
 * returns `ok` before any terminal is created.
 *
 * THE CHILD IS NOT A SERVICE (D-5 / I-3): `detached: true`, `stdio: 'ignore'`,
 * `unref()`, and deliberately no `ProcSupervisor` registration. Registering it
 * would make the parent's exit kill a session running in another window.
 *
 * EVERY FAILURE CARRIES A PASTEABLE COMMAND (I-4). "Could not open a terminal" is
 * a dead end; `aragon --resume a4k2m9` is 22 characters the user can always use.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { getLogger, type ScopedLogger } from '../logging/logger.js';
import {
  defaultIsExecutable,
  pathDirsOf,
  planTerminalLaunch,
  resolveShell,
  truncateTitle,
  type ShellInvocation,
  type TerminalLaunchPlan,
} from '../proc/terminal-plan.js';
import { BRANCH_COPY, type BranchCommandPort } from '../commands/branch-command.js';
import {
  buildResumeInvocation,
  renderManualCommand,
  resolveAragonCommand,
  validateBranchId,
  type AragonCommandResolution,
  type BranchInvocation,
} from './branch-invocation.js';
import { BRANCH_TERMINAL_LIMITS } from './limits.js';

export interface BranchRequest {
  id: string;
  cwd: string;
  /** Late `'error'` events after the window opened (I-10). */
  onLateError?: (message: string) => void;
}

export type BranchOpenResult =
  | {
      ok: true;
      /**
       * The paste-ready command block for this platform (D-7).
       *
       * "Always present, so no failure is a dead end" is I-4 for the FAILURE arm;
       * the success arm carries it for the mirror-image reason - "what did the
       * window I just opened actually run" is copyable without retyping it from the
       * toast. Same meaning as the field of the same name below: on win32 it is the
       * two-line PowerShell / `cmd.exe` block, off win32 it is one line.
       */
      command: string;
      shell: string;
      rung: string;
    }
  | {
      ok: false;
      reason: 'cooldown' | 'checkpoint-failed' | 'no-launcher' | 'spawn-failed';
      /**
       * A complete, user-facing sentence - never an internal reason code.
       * `checkpoint-failed` in particular has two very different causes
       * (`not-sendable` vs `no-identity`), and only the launcher knows which one it
       * hit, so the sentence is composed HERE from `BRANCH_COPY`.
       */
      message: string;
      /** Always present, so no failure is a dead end (I-4). */
      command: string;
      retryInMs?: number;
    };

export interface BranchLauncherDeps {
  /** Injected by `cli.tsx`: a thin wrapper over `checkpointWriter.writeNow`, with `force`. */
  checkpoint(opts: { force: true }): { ok: boolean; message?: string };
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  argv: readonly string[];
  execPath: string;
  spawn?: typeof spawn;
  isExecutable?: (name: string) => boolean;
  now?: () => number;
  logger?: ScopedLogger;
}

/** What one rung's attempt produced. */
type SpawnOutcome = 'ok' | Error;

/**
 * Build the port. The only mutable state is this closure's four values, none of
 * which outlives the process (no persistence, 6 in the spec).
 */
export function createBranchLauncher(deps: BranchLauncherDeps): BranchCommandPort {
  const now = deps.now ?? Date.now;
  const logger: ScopedLogger = deps.logger ?? getLogger().child('branch');
  const spawnFn = deps.spawn ?? spawn;
  const pathDirs = pathDirsOf(deps.env, deps.platform);
  const isExecutable = deps.isExecutable ?? defaultIsExecutable(deps.platform, pathDirs);

  /** Last SUCCESSFUL open (D-10). Failures never move it, so a retry is never blocked. */
  let lastOpenedAt: number | null = null;
  let inFlight = false;
  /** Resolution is cached for the process (R-13 / K-14); a FAILED probe is not. */
  let cachedAragon: AragonCommandResolution | null = null;
  let cachedShell: ShellInvocation | null = null;

  /**
   * Resolve WHAT the new window runs, and the two command forms built from it.
   *
   * The resolution is cached for the process (R-13 / K-14). It costs no
   * filesystem probe - the three rules are env, `argv[1]` and a literal - so the
   * cache is about identity, not speed: the value that opened the first window is
   * the value the log keeps reporting.
   *
   * `manual` is derived HERE from the same `parts` on purpose (D-7): one source of
   * truth for the command means the paste block and the `-EncodedCommand` payload
   * cannot drift apart (I-1).
   */
  function planFor(id: string): {
    aragon: AragonCommandResolution;
    invocation: BranchInvocation;
    manual: string;
  } {
    cachedAragon ??= resolveAragonCommand({
      argv: deps.argv,
      execPath: deps.execPath,
      env: deps.env,
    });
    const invocation = buildResumeInvocation({ id, aragon: cachedAragon });
    return {
      aragon: cachedAragon,
      invocation,
      manual: renderManualCommand(invocation.parts, deps.platform),
    };
  }

  function shellFor(): ShellInvocation {
    cachedShell ??= resolveShell({
      platform: deps.platform,
      env: deps.env,
      isExecutable,
      pathDirs,
    });
    return cachedShell;
  }

  function cooldown(command: string, retryInMs: number): BranchOpenResult {
    return {
      ok: false,
      reason: 'cooldown',
      message: BRANCH_COPY.cooldown(retryInMs),
      command,
      retryInMs,
    };
  }

  function failure(
    reason: 'checkpoint-failed' | 'no-launcher' | 'spawn-failed',
    message: string,
    command: string,
  ): BranchOpenResult {
    return { ok: false, reason, message, command };
  }

  /** Steps 1-2: the in-flight gate, then the cooldown window (D-10). */
  function gated(command: string): BranchOpenResult | null {
    const windowMs = BRANCH_TERMINAL_LIMITS.cooldownMs;
    if (inFlight) return cooldown(command, windowMs);
    if (lastOpenedAt === null) return null;
    const waited = now() - lastOpenedAt;
    if (waited >= windowMs) return null;
    return cooldown(command, Math.max(1, windowMs - waited));
  }

  async function openOnce(request: BranchRequest): Promise<BranchOpenResult> {
    const { aragon, invocation, manual } = planFor(request.id);
    const command = invocation.command;
    // 4.5 BEFORE ANY SPAWN (R-7 / T-46): a command line that `cmd` or AppleScript
    // would truncate is worse than no command line, because the window opens and
    // then fails in a way this process cannot see. The MEASURED object stays the
    // single unquoted line: it is the lower bound of every dialect (quoting only
    // ever adds characters), so the check is conservative and needs no second
    // source of truth.
    if (command.length > BRANCH_TERMINAL_LIMITS.maxCommandLineCells) {
      // A COMPLETE SENTENCE WITH THE FALLBACK INSIDE IT (I-4 / appendix A): the
      // over-long case is the one failure where the user most needs a command to
      // paste, so it may not report the bare reason "command line too long" - that
      // is an internal code, not an answer, and it would leave a dead end.
      return failure(
        'spawn-failed',
        BRANCH_COPY.spawnFailed('command line too long', manual),
        manual,
      );
    }
    // D-9's second gate: an id is about to enter a command line.
    const invalid = validateBranchId(request.id);
    if (invalid !== null) return failure('spawn-failed', invalid, manual);
    // Step 6: flush FIRST, spawn only on `ok` (I-1). `force` skips the fingerprint
    // short circuit and nothing else (D-15 / I-7).
    const flushed = deps.checkpoint({ force: true });
    if (!flushed.ok) {
      const reason = flushed.message ?? 'write-failed';
      // R-19: `no-identity` is a timing answer ("this frame has no id yet"), not a
      // disk problem, so it must not be printed as "could not checkpoint
      // (no-identity)" - that reads like corruption. It gets `/session`'s sentence.
      const message =
        reason === 'no-identity' ? BRANCH_COPY.noIdentity : BRANCH_COPY.checkpointFailed(reason);
      // The THIRD argument changes, never the sentence (parent-R-19): these two
      // failures deliberately do NOT embed the command, because their job is to
      // explain why nothing opened. The command still travels in `result.command`.
      return failure('checkpoint-failed', message, manual);
    }
    const shell = shellFor();
    // Step 7: the TITLE is what gets truncated, never the id in the command line (T-47).
    const title = truncateTitle(`aragon ${request.id}`, BRANCH_TERMINAL_LIMITS.titleMaxCells);
    const planned = planTerminalLaunch({
      platform: deps.platform,
      env: deps.env,
      pathDirs,
      isExecutable,
      shell,
      command: invocation.parts,
      title,
      cwd: request.cwd,
      // The paste block the fallback prints, built by the same dialect owner that
      // encodes the window script (I-1: one command, one artefact).
      manual,
    });
    if (!planned.ok) {
      // Not cached: the next press must be allowed to find a terminal that appeared.
      return failure('no-launcher', BRANCH_COPY.noLauncher(planned.manual), manual);
    }
    // Step 8: walk the ladder, bounded by maxRungs (T-33).
    const rungs = planned.plans.slice(0, BRANCH_TERMINAL_LIMITS.maxRungs);
    let lastError: Error | null = null;
    for (const plan of rungs) {
      const outcome = await trySpawn(request, plan);
      if (outcome === 'ok') {
        lastOpenedAt = now();
        // `origin` is why the record exists (D-18): "I pressed Ctrl+L and nothing
        // happened" is answered by WHICH aragon the child ran (`aragon` from PATH,
        // `node <script>`, or the env override) and through which rung, which no
        // other record in the log can tell you.
        logger.info('opened', {
          id: request.id,
          rung: plan.rung,
          shell: planned.shell.path,
          aragon: aragon.kind,
          origin: aragon.origin,
        });
        return { ok: true, command: manual, shell: planned.shell.path, rung: plan.rung };
      }
      logger.warn('rung_failed', { rung: plan.rung, message: outcome.message });
      lastError = outcome;
    }
    // Step 9: every rung failed. `wt`'s own semantic failures land here too only if
    // the error event fired; a forwarded-but-rejected `wt` invocation does not (K-1).
    return failure(
      'spawn-failed',
      BRANCH_COPY.spawnFailed(lastError?.message ?? 'no rung available', manual),
      manual,
    );
  }

  /**
   * One rung, with EXACTLY ONE `'error'` LISTENER THAT IS NEVER REMOVED (R-3 / I-10).
   *
   * `once('error')` is what the first draft used and it is wrong: after the probe
   * settles on `'spawn'` (or on the timeout) that handler is still removed on
   * first use, so a LATE error has no listener - an unhandled `'error'` on a
   * ChildProcess throws at the process top level and takes the parent TUI with it.
   * A permanent listener with a `settled` flag gives the probe the first error and
   * the user the rest.
   */
  async function trySpawn(request: BranchRequest, plan: TerminalLaunchPlan): Promise<SpawnOutcome> {
    const child: ChildProcess = spawnFn(plan.file, plan.args, {
      cwd: request.cwd,
      detached: true,
      // I-3: the child's streams must never join the parent's, or Ink's frame
      // differ treats another process's bytes as an outside writer.
      stdio: 'ignore',
      // A new window has to be visible; hiding it would defeat the whole key.
      windowsHide: false,
      // The FULL environment, inherited on purpose (K-7): `ARAGON_HOME` is how the
      // child finds the same sessions directory, and `ARAGON_*` is user
      // configuration (D-7). `ARAGON_LOG_FILE` appends per record with `pid` + `sid`.
      env: deps.env,
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    child.unref();
    return probeSpawn(child, plan, request);
  }

  /** Wait for `'spawn'` | `'error'` | the timeout, then keep listening for late errors. */
  function probeSpawn(
    child: ChildProcess,
    plan: TerminalLaunchPlan,
    request: BranchRequest,
  ): Promise<SpawnOutcome> {
    return new Promise<SpawnOutcome>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (value: SpawnOutcome): void => {
        if (settled) {
          if (value === 'ok') return;
          // LATE error: report it, never re-settle, never remove the listener.
          const message = value.message || String(value);
          logger.warn('late_error', { rung: plan.rung, message });
          request.onLateError?.(BRANCH_COPY.lateError(message));
          return;
        }
        settled = true;
        if (timer !== null) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => {
        // A timeout counts as SUCCESS (K-8): `'spawn'` and `'error'` both missing
        // almost always means the process was created and the event was merely
        // delayed behind the scheduler. Reporting a failure here produces the worse
        // error - "window is open, UI says it is not".
        logger.debug('probe_timeout', { rung: plan.rung });
        finish('ok');
      }, BRANCH_TERMINAL_LIMITS.spawnProbeMs);
      timer.unref?.();
      // `spawn` fires at most once, so `once` is honest here.
      child.once('spawn', () => finish('ok'));
      // PERMANENT. Installed before any await so no error can slip past it.
      child.on('error', (error: Error) => finish(error));
    });
  }

  return {
    async open(request: BranchRequest): Promise<BranchOpenResult> {
      // The cooldown path carries the same paste block. It never displays it, but the
      // result type has exactly one meaning for `command` and inventing a second one
      // for this arm is how the two forms would drift apart (D-7).
      const blocked = gated(planFor(request.id).manual);
      if (blocked !== null) return blocked;
      inFlight = true;
      try {
        return await openOnce(request);
      } finally {
        // `inFlight` always clears, including on a synchronous throw from `spawn`
        // (an invalid `cwd`), which then bubbles to `executeSlashInput`'s try/catch
        // and becomes one honest `Command failed: ...` line (D-2).
        inFlight = false;
      }
    },
  };
}
