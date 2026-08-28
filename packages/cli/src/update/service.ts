/**
 * `UpdateService` - the state machine, the scheduler and the event stream
 * (cli-auto-update section 3.6).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 *         idle --check()--> checking --none--> idle
 *                              |
 *                              |-notify--> available     (terminal for the session)
 *                              `-install-> installing --ok--> ready   (terminal)
 *                                               `-err--> failed --backoff--> idle
 *
 * EVERY FAILURE IS SILENT (D-7). A background updater that cannot reach the
 * registry behind a corporate proxy, or cannot write to `/usr/lib/node_modules`
 * without sudo, must not turn into a recurring interruption: it logs, backs off
 * exponentially, and stays quiet. The single exception is a failure the user can
 * actually fix, after `UPDATE_LIMITS.failuresBeforeNotice` consecutive
 * occurrences.
 *
 * THIS MODULE IS REACHED ONLY THROUGH A DYNAMIC `import()` (section 3.8 / D-25).
 * `runOneShot` and `runInteractive` live in the same `cli.tsx` module and there
 * is no bundler (C-16), so a static import here would put the whole subsystem in
 * `dist/cli.js`'s graph and `aragon -p` would evaluate every module under
 * `update/`.
 */

import process from 'node:process';
import type { ScopedLogger } from '../logging/logger.js';
import { getLogger } from '../logging/logger.js';
import type { UpdateConfig } from '../config/schema.js';
import {
  adviceFor,
  classifyInstallSource,
  isAutoInstallable,
  isReportableSource,
  probeWritable,
  readSelfManifest,
  selfPackageRoot,
} from './install-source.js';
import { classifyInstallFailure } from './classify-failure.js';
import { UPDATE_LIMITS } from './limits.js';
import { fetchLatestViaNpm, type NpmViewDeps } from './npm-view.js';
import { fetchLatestManifest, resolveRegistryUrl } from './registry.js';
import { decideUpdate, STRICT_VERSION_RE } from './semver.js';
import { tryAcquireInstallLock } from './install-lock.js';
import { runNpmInstall, type InstallDeps, type SpawnImpl } from './installer.js';
import { readUpdateState, updateUpdateState } from './state.js';
import type {
  InstallSource,
  UpdateCommandPort,
  UpdatePhase,
  UpdateReason,
  UpdateSnapshot,
} from './types.js';

/** A timer handle we only ever cancel and `unref`. */
interface TimerHandle {
  unref?: () => void;
}

export interface UpdateServiceDeps {
  config: UpdateConfig;
  /** The running version - `cli.tsx`'s `VERSION`. */
  currentVersion: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnImpl;
  logger?: ScopedLogger;
  env?: NodeJS.ProcessEnv;
  /** `process.versions.node`, injected so every engine test is offline. */
  nodeVersion?: string;
  /** Overrides `selfPackageRoot()`; tests point it at a synthetic tree. */
  packageRoot?: string | null;
  /** Overrides the name read from `<root>/package.json`. */
  packageName?: string;
  /** Pre-resolved classification, so a test need not build a real tree. */
  source?: InstallSource;
  setTimeoutImpl?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
  /** Deterministic jitter for tests. */
  random?: () => number;
  /** Forwarded to `runNpmInstall` and `tryAcquireInstallLock`. */
  install?: InstallDeps;
  /** Forwarded to `fetchLatestViaNpm`, so no test spawns npm (H3). */
  npmView?: NpmViewDeps;
  lockPath?: string;
  isProcessAlive?: (pid: number) => boolean;
}

type Listener = (snapshot: UpdateSnapshot) => void;

/** What the service resolved about this machine, once per process. */
interface Resolved {
  root: string | null;
  packageName: string;
  source: InstallSource;
  writable: boolean;
}

export class UpdateService implements UpdateCommandPort {
  private readonly deps: UpdateServiceDeps;
  private readonly now: () => number;
  private readonly log: ScopedLogger;
  private readonly listeners = new Set<Listener>();

  private phase: UpdatePhase = 'idle';
  private latestVersion: string | null = null;
  private reason: UpdateReason | undefined;
  private advice: string | undefined;
  /** Set only on the `node-too-old` path; both, or neither (section 6.2). */
  private requiredNode: string | undefined;
  private runningNode: string | undefined;
  private nextAt: number | null = null;
  private failures = 0;
  /**
   * The rollback notice, held for THIS SESSION and cleared from the file the
   * first time it is read (section 5.2a / D-38). Both, or neither.
   */
  private rolledBackFrom: string | undefined;
  private rolledBackTo: string | undefined;
  /** What `aragon update --rollback` would reinstall, for `/update status`. */
  private lastGoodVersion: string | undefined;
  /** Which probe answered the last successful check (H3). */
  private probe: 'http' | 'npm' | undefined;

  private timer: TimerHandle | null = null;
  private started = false;
  private disposed = false;
  private inFlight: Promise<UpdateSnapshot> | null = null;
  private resolved: Resolved | null = null;

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.logger ?? getLogger().child('update');
    this.failures = readUpdateState().consecutiveFailures;
  }

  // -------------------------------------------------------------------------
  // Public surface
  // -------------------------------------------------------------------------

  /**
   * Schedule the first check. Idempotent.
   *
   * The first check fires `UPDATE_LIMITS.startupDelayMs` after this call so it
   * can never contend with first paint, and every timer is `unref()`ed so a
   * pending check never keeps `aragon` from exiting.
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.reconcilePendingRestart();
    this.consumeRollbackNotice();
    this.schedule(UPDATE_LIMITS.startupDelayMs);
  }

  snapshot(): UpdateSnapshot {
    return {
      phase: this.phase,
      currentVersion: this.deps.currentVersion,
      latestVersion: this.latestVersion,
      source: this.resolved?.source ?? this.deps.source ?? 'unknown',
      ...(this.reason ? { reason: this.reason } : {}),
      ...(this.advice ? { advice: this.advice } : {}),
      ...(this.requiredNode ? { requiredNode: this.requiredNode } : {}),
      ...(this.runningNode ? { runningNode: this.runningNode } : {}),
      ...(this.rolledBackFrom ? { rolledBackFrom: this.rolledBackFrom } : {}),
      ...(this.rolledBackTo ? { rolledBackTo: this.rolledBackTo } : {}),
      ...(this.lastGoodVersion ? { lastGoodVersion: this.lastGoodVersion } : {}),
      ...(this.probe ? { probe: this.probe } : {}),
      nextCheckAt: this.nextAt,
      consecutiveFailures: this.failures,
    };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  nextCheckAt(): number | null {
    return this.nextAt;
  }

  /**
   * Run a check now, subject to the machine-wide throttle unless forced.
   *
   * SINGLE-FLIGHT. Two `/update now` in a row, or a slash command landing on top
   * of the scheduled tick, must produce one registry request and one install -
   * the in-process half of what `lastCheckAt` does across processes.
   */
  checkNow(opts: { force?: boolean } = {}): Promise<UpdateSnapshot> {
    if (this.disposed) return Promise.resolve(this.snapshot());
    if (this.inFlight) return this.inFlight;
    const run = this.runCheck(opts.force === true).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /**
   * Install a specific version now, bypassing the decision gates.
   *
   * The explicit escape hatch behind `aragon update --to <version>` (non-goal 4:
   * there is no AUTOMATIC downgrade, but a deliberate one is exactly what a user
   * needs when a release misbehaves).
   */
  async installNow(version?: string): Promise<UpdateSnapshot> {
    if (this.disposed) return this.snapshot();
    const target = version ?? this.latestVersion;
    if (!target) return this.snapshot();
    // VALIDATED BEFORE IT TOUCHES ANYTHING. `runNpmInstall` rejects a malformed
    // version too (AC-24), but by then it has already been written into the
    // snapshot and the lock has been taken and released - so `aragon update --to
    // "1.0.0; rm -rf /"` would render the attacker's string in the bottom row
    // and burn a consecutive-failure. This is the one entry point whose target
    // comes straight from argv rather than from a parsed manifest.
    if (!STRICT_VERSION_RE.test(target)) {
      this.log.warn('update_install_rejected', { target: 'malformed' });
      return this.snapshot();
    }
    const resolved = this.resolve();
    if (!resolved.root) return this.snapshot();
    // `{ arm: false }` IS THE WHOLE OF D-32. A user who explicitly asked for
    // version X and gets a crash has made a decision, and an updater that
    // silently reverses it is a worse actor than one that does nothing. This is
    // the only call site that differs from the automatic path.
    await this.performInstall(resolved, target, { arm: false });
    return this.snapshot();
  }

  /** Persist `skippedVersion`; the line disappears until a newer one appears. */
  skip(version: string): void {
    if (!version) return;
    updateUpdateState({ skippedVersion: version });
    this.log.info('update_skipped', { version });
    this.setPhase('idle', { reason: 'skipped', advice: undefined });
  }

  /**
   * Clear timers and drop listeners. NEVER KILLS THE INSTALLER CHILD (U-3).
   *
   * Killing a running `npm install -g` is the one action in this feature that
   * can leave the user's global installation broken, and `dispose()` is called
   * by the most ordinary event there is - the user pressing Ctrl+C. The child is
   * detached and `unref()`ed precisely so it can finish without us.
   *
   * Idempotent, and called on BOTH of `runInteractive`'s teardown branches.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelTimer();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private cancelTimer(): void {
    if (!this.timer) return;
    const clear = this.deps.clearTimeoutImpl ?? ((h: TimerHandle) => clearTimeout(h as never));
    clear(this.timer);
    this.timer = null;
  }

  /**
   * Arm the next check.
   *
   * The jitter is not decoration (D-12 / R-6): machine fleets started by the
   * same automation otherwise arrive at the registry together, and the throttle
   * in `update-state.json` only de-duplicates within ONE machine.
   */
  private schedule(delayMs: number): void {
    if (this.disposed) return;
    this.cancelTimer();
    const jitter = this.deps.random ?? Math.random;
    const spread = delayMs * UPDATE_LIMITS.jitterRatio;
    const delay = Math.max(0, Math.round(delayMs + (jitter() * 2 - 1) * spread));
    this.nextAt = this.now() + delay;
    const set =
      this.deps.setTimeoutImpl ??
      ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as TimerHandle);
    const handle = set(() => {
      this.timer = null;
      void this.checkNow();
    }, delay);
    // A pending check must never be the reason `aragon` will not exit.
    handle.unref?.();
    this.timer = handle;
  }

  /** `backoffBaseMs * 2^(n-1)`, capped. `n` is the consecutive-failure count. */
  private backoffMs(failures: number): number {
    if (failures <= 0) return this.deps.config.checkIntervalMs;
    const grown = UPDATE_LIMITS.backoffBaseMs * 2 ** (failures - 1);
    return Math.min(UPDATE_LIMITS.backoffMaxMs, grown);
  }

  private scheduleNext(): void {
    this.schedule(this.failures > 0 ? this.backoffMs(this.failures) : this.deps.config.checkIntervalMs);
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private setPhase(
    phase: UpdatePhase,
    patch: { reason?: UpdateReason | undefined; advice?: string | undefined } = {},
  ): void {
    this.phase = phase;
    if ('reason' in patch) this.reason = patch.reason;
    if ('advice' in patch) this.advice = patch.advice;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A subscriber that throws is a renderer bug, not a reason to break the
        // state machine for every other subscriber.
      }
    }
  }

  /**
   * Step 11 of the happy path: the new version is now the running one, so the
   * pending marker has served its purpose.
   *
   * Silent by design - the user restarted, which is the acknowledgement. The log
   * record is what makes "when did this machine actually pick up 0.6.0"
   * answerable after the fact.
   */
  private reconcilePendingRestart(): void {
    const state = readUpdateState();
    if (!state.pendingRestartVersion) return;
    if (state.pendingRestartVersion !== this.deps.currentVersion) return;
    updateUpdateState({ pendingRestartVersion: '' });
    this.log.info('update_applied', { version: this.deps.currentVersion });
  }

  /**
   * Read the rollback notice, hold it for this session, and clear the file
   * (cli-auto-update-hardening section 5.2a / D-38 / D-40).
   *
   * CONSUMING ON READ IS WHAT MAKES "ONE SESSION" TRUE WITHOUT A SECOND
   * TIMESTAMP. It also means a launch that never constructs a service -
   * `update.mode: 'off'`, a non-TTY, CI - does NOT burn the notice, so it
   * survives to the first session that could actually have shown it.
   *
   * `rolledBackTo` is the running version and is therefore DERIVED, not stored:
   * we are, by definition, the target of the rollback that wrote this field. The
   * "both or neither" rule the pair inherits from `requiredNode` / `runningNode`
   * is satisfied by construction rather than by discipline.
   *
   * `lastGoodVersion` is picked up in the same read - it is what
   * `aragon update --rollback` would reinstall, and `/update status` is the only
   * place a user can find that out before running the command.
   */
  private consumeRollbackNotice(): void {
    const state = readUpdateState();
    if (state.lastGoodVersion) this.lastGoodVersion = state.lastGoodVersion;
    if (!state.rolledBackFrom) return;
    this.rolledBackFrom = state.rolledBackFrom;
    this.rolledBackTo = this.deps.currentVersion;
    updateUpdateState({ rolledBackFrom: '' });
    this.log.warn('update_rollback_notice', {
      from: this.rolledBackFrom,
      to: this.rolledBackTo,
    });
  }

  /** Classify this installation once. Cheap, but it stats the filesystem. */
  private resolve(): Resolved {
    if (this.resolved) return this.resolved;
    const root = this.deps.packageRoot !== undefined ? this.deps.packageRoot : selfPackageRoot();
    const manifest = root ? readSelfManifest(root) : null;
    const source =
      this.deps.source ?? (root ? classifyInstallSource(root, this.deps.env ?? process.env) : 'unknown');
    this.resolved = {
      root,
      packageName: this.deps.packageName ?? manifest?.name ?? '',
      source,
      // A path can look global and still be unwritable - the EACCES-on-Linux
      // case (R-2). Probing BEFORE spawning npm turns a confusing failure deep in
      // npm's output into an actionable one-line notice.
      writable: root ? probeWritable(root) : false,
    };
    return this.resolved;
  }

  // -------------------------------------------------------------------------
  // The check
  // -------------------------------------------------------------------------

  private async runCheck(force: boolean): Promise<UpdateSnapshot> {
    // `installing` is single-flight and `ready` is terminal for the session:
    // there is nothing a further check could learn that would change either.
    if (this.phase === 'installing' || this.phase === 'ready') return this.snapshot();

    const state = readUpdateState();
    const now = this.now();
    if (!force) {
      // Ten terminals opened at once produce ONE registry request, not ten.
      if (now - state.lastCheckAt < this.deps.config.checkIntervalMs) {
        this.scheduleNext();
        return this.snapshot();
      }
      if (
        state.consecutiveFailures > 0 &&
        now < state.lastFailureAt + this.backoffMs(state.consecutiveFailures)
      ) {
        this.scheduleNext();
        return this.snapshot();
      }
    }

    const resolved = this.resolve();
    if (!resolved.root || resolved.packageName.length === 0) {
      // U-1's guard fired: we could not establish which package we are, so there
      // is nothing safe to ask the registry about.
      this.setPhase('idle', { reason: 'source-ineligible', advice: undefined });
      this.scheduleNext();
      return this.snapshot();
    }

    const registry = resolveRegistryUrl(this.deps.config.registry, this.deps.env ?? process.env);
    this.setPhase('checking');
    this.log.info('update_check_start', {
      registry,
      distTag: this.deps.config.distTag,
      source: resolved.source,
    });

    let manifest = await fetchLatestManifest(
      registry,
      resolved.packageName,
      this.deps.config.distTag,
      {
        ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
        userAgent: `aragon-agent-cli/${this.deps.currentVersion}`,
      },
    );
    // H3 - THE PROXY-AWARE FALLBACK (section 5.4 / D-35 / R-19).
    //
    // UNCONDITIONAL ON A FAILED FETCH: no "three consecutive network failures"
    // precondition and no sticky mode. A precondition would make a proxied
    // machine wait out a 30 min -> 60 min -> 120 min backoff before its FIRST
    // successful check, and a sticky `probeMode` field would be a fifth thing to
    // keep correct across versions under C-17. The unconditional form costs one
    // `execFile` on a check that has ALREADY FAILED, which on a healthy machine
    // is never.
    //
    // The SAME resolved `registry` string goes to both probes (P1-4 / D-41), so
    // they describe one registry by construction.
    let via: 'http' | 'npm' = 'http';
    if (!manifest) {
      manifest = await fetchLatestViaNpm(
        registry,
        resolved.packageName,
        this.deps.config.distTag,
        {
          ...(this.deps.env ? { env: this.deps.env } : {}),
          ...(this.deps.npmView ?? {}),
        },
      );
      if (manifest) via = 'npm';
      this.log.info('update_check_via_npm', {
        packageName: resolved.packageName,
        distTag: this.deps.config.distTag,
        ok: manifest !== null,
      });
    }
    // WRITTEN ONCE, AFTER BOTH ATTEMPTS, exactly as before: it means "somebody
    // asked", and the throttle it feeds must not fire twice for one check.
    updateUpdateState({ lastCheckAt: this.now() });

    if (!manifest) {
      this.recordFailure('network');
      this.scheduleNext();
      return this.snapshot();
    }

    this.probe = via;
    this.latestVersion = manifest.version;
    updateUpdateState({ lastKnownVersion: manifest.version });

    const decision = decideUpdate({
      local: this.deps.currentVersion,
      manifest,
      nodeVersion: this.deps.nodeVersion ?? process.versions.node,
      skippedVersion: readUpdateState().skippedVersion,
    });
    // `via` belongs on THIS record and not on `update_check_start` (P2-3): the
    // value is not known until the fetch has failed, so on the start record it
    // would be the constant `'http'`, which is worse than absent. It is what
    // makes "this machine updates through the npm fallback" answerable from the
    // log rather than only from `/update status`.
    this.log.info('update_check_result', {
      local: this.deps.currentVersion,
      remote: manifest.version,
      action: decision.action,
      reason: decision.reason,
      source: resolved.source,
      via,
    });

    // A reachable registry is a working check, whatever it answered.
    this.clearFailures();

    if (decision.action === 'none') {
      this.setPhase('idle', {
        reason: decision.reason as UpdateReason,
        advice: undefined,
      });
      this.scheduleNext();
      return this.snapshot();
    }

    if (decision.action === 'notify') {
      // Both, or neither: section 6.2's row names the range AND the running
      // version, and half of that pair is a notice nobody can act on.
      const required = manifest.engines?.node;
      if (required) {
        this.requiredNode = required;
        this.runningNode = this.deps.nodeVersion ?? process.versions.node;
      }
      this.offer(resolved, 'node-too-old');
      return this.snapshot();
    }

    // `install` - now the machine's own gates, which are deliberately NOT part
    // of `decideUpdate` (a pure decision must not depend on the filesystem).
    if (this.deps.config.mode !== 'auto') {
      this.offer(resolved, undefined);
      return this.snapshot();
    }
    if (!isAutoInstallable(resolved.source)) {
      this.offer(resolved, 'source-ineligible');
      return this.snapshot();
    }
    if (!resolved.writable) {
      this.offer(resolved, 'not-writable');
      return this.snapshot();
    }

    await this.performInstall(resolved, manifest.version, { arm: true });
    return this.snapshot();
  }

  /**
   * Report an available version without installing it.
   *
   * `dev-monorepo` and `npx` are SILENT even here (AC-6 / AC-7): a developer's
   * clone is not out of date, it is checked out, and `npx` resolved `latest`
   * seconds ago. Both fall back to `idle`, which `shouldRenderUpdateLine`
   * answers `false` for.
   */
  private offer(resolved: Resolved, reason: UpdateReason | undefined): void {
    const advice = adviceFor(resolved.source, resolved.packageName);
    if (!isReportableSource(resolved.source)) {
      this.setPhase('idle', { reason: 'source-ineligible', advice: undefined });
      this.scheduleNext();
      return;
    }
    this.setPhase('available', { reason, advice });
    this.scheduleNext();
  }

  // -------------------------------------------------------------------------
  // The install
  // -------------------------------------------------------------------------

  private async performInstall(
    resolved: Resolved,
    target: string,
    opts: { arm: boolean },
  ): Promise<void> {
    const lock = tryAcquireInstallLock({
      now: this.now,
      ...(this.deps.lockPath ? { path: this.deps.lockPath } : {}),
      ...(this.deps.isProcessAlive ? { isProcessAlive: this.deps.isProcessAlive } : {}),
    });
    if (!lock) {
      // NOT AN ERROR: another process is already doing the work, so this one
      // re-checks on the next tick, by which point the version is installed.
      this.setPhase('idle', { reason: 'locked', advice: undefined });
      this.scheduleNext();
      return;
    }

    this.setPhase('installing', { reason: undefined, advice: undefined });
    this.latestVersion = target;
    this.log.info('update_install_start', { version: target, root: resolved.root });

    const result = await runNpmInstall({
      packageName: resolved.packageName,
      version: target,
      root: resolved.root as string,
      // Phase two of U-4: the lock was created with OUR pid because the lock has
      // to precede the spawn, and it is rewritten to the child's the instant the
      // child exists. The child outlives us by design, so a lock naming the
      // parent would be released - or judged stale - while npm is still writing.
      onSpawn: (pid) => lock.adoptChild(pid),
      deps: {
        now: this.now,
        ...(this.deps.spawnImpl ? { spawnImpl: this.deps.spawnImpl } : {}),
        ...(this.deps.env ? { env: this.deps.env } : {}),
        ...(this.deps.install ?? {}),
      },
    });
    lock.release();

    if (result.ok) {
      updateUpdateState({
        pendingRestartVersion: target,
        consecutiveFailures: 0,
        lastFailureAt: 0,
        // ------------------------------------------------------------------
        // H1's ARMING WRITE (cli-auto-update-hardening section 5.2).
        //
        // `lastGoodVersion` is the version DOING the installing. That is the
        // strongest available evidence of "this one works": it is executing.
        // Reading it from the registry or from a list of published versions
        // would be a guess.
        //
        // `bootFailures: 0` IS NOT DEFENSIVE TIDYING; WITHOUT IT THE GUARD
        // DOWNGRADES HEALTHY RELEASES (P0-2 / D-30b). Arming and the counter are
        // two fields with two lifetimes, and nothing else resets the counter
        // except a rollback that actually fires. Follow an ordinary sequence:
        // 0.6.0 auto-installs and arms, crashes twice (`bootFailures: 2`), and
        // the user gives up and runs `npm i -g @aragon-agent/cli@0.5.9` by hand
        // rather than launching a third time. The guard now takes its fast path
        // forever - `autoInstalledVersion` is 0.6.0, the running version is
        // 0.5.9 - so the counter is STRANDED at 2. Weeks later 0.7.0, a
        // perfectly good release, auto-installs and arms ON TOP OF IT, and its
        // very first launch already satisfies the threshold. The guard rolls a
        // working version back and latches it into `skippedVersion`, so it is
        // never offered again. One field in a write that was already happening;
        // its absence is silent, destructive, and the exact inverse of what H1
        // is for.
        //
        // `arm` IS FALSE FOR `installNow` (`aragon update --to`) - see D-32 at
        // that call site.
        // ------------------------------------------------------------------
        ...(opts.arm
          ? {
              autoInstalledVersion: target,
              lastGoodVersion: this.deps.currentVersion,
              bootFailures: 0,
            }
          : {}),
      });
      if (opts.arm) this.lastGoodVersion = this.deps.currentVersion;
      this.failures = 0;
      this.log.info('update_install_done', { version: target, ms: result.elapsedMs ?? 0 });
      this.setPhase('ready', { reason: undefined, advice: undefined });
      return;
    }

    if (result.failure === 'ineffective') {
      // U-6 / R-12. npm succeeded, but into a prefix that is not the root we
      // classified. `skippedVersion` LATCHES so the same version is never
      // retried - without it this is an unbounded silent reinstall, once per
      // check interval, forever. A newer release clears the latch in the normal
      // way, so the user is not opted out permanently, only out of the loop.
      updateUpdateState({ skippedVersion: target, consecutiveFailures: 0, lastFailureAt: 0 });
      this.failures = 0;
      this.log.warn('update_install_ineffective', {
        target,
        observed: result.observedVersion ?? null,
        root: resolved.root,
      });
      this.setPhase('available', {
        reason: 'install-ineffective',
        advice: adviceFor(resolved.source, resolved.packageName),
      });
      this.scheduleNext();
      return;
    }

    // H2 - the tail decides the reason, and the reason decides the advice
    // (section 5.3). `recordFailure` itself is unchanged: it still increments,
    // still persists, still attaches `adviceFor(...)`, still sets
    // `phase: 'failed'`. What changes is that three of the possible reasons are
    // in `IMMEDIATE_NOTICE_REASONS` and so bypass the three-strike silence.
    const reason = classifyInstallFailure(result.stderrTail);
    // `stderrTail` goes through the logger's own redactor on the way to disk
    // (`Logger.emit` -> `redactRecord`): an npm error can echo a registry URL
    // carrying an auth token.
    //
    // A DISTINCT RECORD FOR THE BLOCKED CASE (section 5.6), because it is the
    // one failure whose remedy is not "wait": on Windows the shim that launched
    // us is held open by the shell running it for as long as our process lives,
    // so it will fail identically until the user closes something.
    this.log.warn(reason === 'blocked-by-os' ? 'update_install_blocked' : 'update_install_failed', {
      version: target,
      code: result.exitCode ?? null,
      stderrTail: result.stderrTail ?? '',
    });
    this.recordFailure(reason);
    this.scheduleNext();
  }

  // -------------------------------------------------------------------------
  // Failure bookkeeping
  // -------------------------------------------------------------------------

  private recordFailure(reason: UpdateReason): void {
    const next = updateUpdateState({
      consecutiveFailures: readUpdateState().consecutiveFailures + 1,
      lastFailureAt: this.now(),
    });
    this.failures = next.consecutiveFailures;
    // THE ADVICE IS THE WHOLE POINT OF THE ONE FAILURE THE USER EVER SEES.
    // Section 1.2 promises that after `failuresBeforeNotice` the line becomes
    // "muted and ACTIONABLE", and section 6.2 spells that row as
    // `<warn> update failed <dot> npm i -g @aragon-agent/cli`. Passing
    // `undefined` here leaves `UpdateLine` on its `!advice` fallback, so the row
    // reads a bare "update failed" - a warning that names no way out, on the one
    // path where a corporate proxy or a root-owned prefix means the user's only
    // remaining move is the manual command. `undefined` for the three silent
    // sources is correct and stays: `adviceFor` has nothing honest to offer them.
    //
    // The phase changes on every failure, but `shouldRenderUpdateLine` keeps the
    // row empty until `failuresBeforeNotice` - so the first two are invisible
    // and only the third says anything (D-7 / R-8).
    const advice = this.resolved
      ? adviceFor(this.resolved.source, this.resolved.packageName)
      : undefined;
    this.setPhase('failed', { reason, advice });
  }

  private clearFailures(): void {
    if (this.failures === 0 && readUpdateState().consecutiveFailures === 0) return;
    updateUpdateState({ consecutiveFailures: 0, lastFailureAt: 0 });
    this.failures = 0;
  }
}
