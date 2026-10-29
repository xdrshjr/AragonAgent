/**
 * The updater's runtime shapes, plus the ONE pure predicate the renderer needs
 * (cli-auto-update sections 5.3 / 5.3a).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * THE ONLY VALUE EXPORTED HERE IS `shouldRenderUpdateLine`. Everything else is a
 * type, so `ui/UpdateLine.tsx` and `commands/registry.ts` can import from this
 * module with `import type` and tsc erases the specifier entirely - no runtime
 * edge from the renderer or the command registry into `update/` (section 3.1
 * rule 1 / P1-7). This module and `limits.ts` import nothing but each other, are
 * side-effect-free, and open no socket, spawn no process and create no timer.
 */

import { UPDATE_LIMITS } from './limits.js';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'installing'
  | 'ready'
  | 'failed';

/**
 * How the running copy of `aragon` got onto this machine (section 3.2).
 *
 * `npm-global` is the ONLY value that may be auto-installed, because it is the
 * only one whose install target is unambiguous and verifiable from this machine
 * (D-5). Everything else is advice, not execution.
 */
export type InstallSource =
  | 'dev-monorepo'
  | 'npx'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'volta'
  | 'npm-local'
  | 'npm-global'
  | 'unknown';

/** Why we are not installing, when we are not. Drives the advice line. */
export type UpdateReason =
  | 'up-to-date'
  | 'prerelease'
  | 'deprecated'
  | 'node-too-old'
  | 'skipped'
  | 'not-writable'
  | 'source-ineligible'
  | 'network'
  | 'install-failed'
  | 'locked'
  /** npm exited 0 but THIS root did not move - see U-6. */
  | 'install-ineffective'
  /** EPERM / EBUSY / ETXTBSY - something holds the file we must replace. */
  | 'blocked-by-os'
  /** ENOSPC. */
  | 'no-space';

/** The slice of the registry's dist-tag document this feature reads. */
export interface LatestManifest {
  name: string;
  version: string;
  engines?: { node?: string };
  /** Present ONLY when the version is deprecated; the string is the reason. */
  deprecated?: string;
}

export interface UpdateSnapshot {
  phase: UpdatePhase;
  currentVersion: string;
  latestVersion: string | null;
  source: InstallSource;
  reason?: UpdateReason;
  /** Copy-pasteable command for an ineligible source. */
  advice?: string;
  /**
   * The `engines.node` range the offered version demands, and the Node actually
   * running - set ONLY on the `node-too-old` path.
   *
   * They exist because section 6.2 specifies that row as
   * `<warn> 0.6.0 needs Node >=20 (running 18.19.0)`, and neither number is
   * derivable from anything else on this object. "Needs a newer Node" without
   * saying WHICH is the kind of notice a user cannot act on, which is exactly
   * what D-7 spends the rest of this feature avoiding (IF-2).
   */
  requiredNode?: string;
  runningNode?: string;
  /**
   * Set for the WHOLE session after a rollback, and deliberately NOT a `reason`
   * (cli-auto-update-hardening section 5.2a / D-39).
   *
   * `reason` is rewritten by `setPhase` on EVERY transition, so the first
   * scheduled check three seconds into the session would erase it before anyone
   * read it. A fact that is true for a whole session needs a carrier the state
   * machine does not own.
   *
   * BOTH, OR NEITHER, on the `requiredNode` / `runningNode` precedent above -
   * half the pair is a notice nobody can read. Here it holds BY CONSTRUCTION
   * rather than by discipline: `rolledBackTo` is the running version, assigned
   * in the same two lines that read `rolledBackFrom` out of the state file.
   */
  rolledBackFrom?: string;
  rolledBackTo?: string;
  /**
   * What `aragon update --rollback` would reinstall, read from the state file.
   *
   * On the snapshot rather than derived because `/update status` is the only
   * place a user can find out what that command would DO before running it
   * (section 6.3). See IF-1 in the hardening spec.
   */
  lastGoodVersion?: string;
  /** Which probe answered the last successful check (H3). */
  probe?: 'http' | 'npm';
  nextCheckAt: number | null;
  consecutiveFailures: number;
}

export type UpdateEvent =
  | { type: 'phase'; snapshot: UpdateSnapshot }
  | { type: 'log'; level: 'info' | 'warn'; msg: string };

/**
 * The narrow surface `/update` sees (section 4.4 / C-14 / P0-2).
 *
 * `CommandContext` carries this rather than the service itself, and carries it
 * as an OPTIONAL member: the service is legitimately absent under
 * `update.mode: 'off'`, on a non-TTY and in CI, and a required field would break
 * every existing `CommandContext` fixture at compile time.
 *
 * `UpdateService` satisfies it STRUCTURALLY, so nothing implements it explicitly
 * and there is no adapter to keep in sync.
 */
export interface UpdateCommandPort {
  snapshot(): UpdateSnapshot;
  checkNow(opts?: { force?: boolean }): Promise<UpdateSnapshot>;
  skip(version: string): void;
  nextCheckAt(): number | null;
}

/** What the renderer needs on top of the command port: a subscription. */
export interface UpdateServiceHandle extends UpdateCommandPort {
  subscribe(fn: (snapshot: UpdateSnapshot) => void): () => void;
}

/**
 * The late-arrival channel between `cli.tsx` and `App` (IF-4).
 *
 * The service is constructed through a DYNAMIC `import()` fired AFTER
 * `render()` (section 3.8 / D-25), so it does not exist when `App` mounts and
 * cannot be an ordinary prop. This is the same shape `ConfirmBridge` and
 * `HumanInputBridge` already use for exactly the same reason: a mutable object
 * created before `render()`, populated by whichever side arrives second.
 *
 * A PLAIN INTERFACE AND NOT A CLASS, so `cli.tsx` builds one with an object
 * literal and needs no runtime import from `update/` (AC-1).
 */
export interface UpdateBridge {
  /** Set once the dynamically-imported service exists; `null` until then. */
  service: UpdateServiceHandle | null;
  /** Set by `App` on mount, so a service that arrives later can wake it. */
  onAttach: ((service: UpdateServiceHandle) => void) | null;
}

/**
 * The reasons allowed to break the three-strike silence rule (D-7 / D-33),
 * because each is both ACTIONABLE BY THE USER and NOT SELF-HEALING.
 *
 * THE MEMBERSHIP RULE IS THE WHOLE MECHANISM, not the list. `network` fails both
 * halves - the user cannot fix the registry and the next check may well succeed -
 * so it stays silent and backs off, which is the entire reason a background
 * updater is tolerable at all. The three below will otherwise repeat identically
 * until the user does something, which is the definition of a notice worth
 * showing once. Anything added here without passing both halves is the first
 * step of the notification fatigue the rest of this feature is built to avoid
 * (R-20).
 */
export const IMMEDIATE_NOTICE_REASONS: ReadonlySet<UpdateReason> = new Set<UpdateReason>([
  'blocked-by-os',
  'no-space',
  'not-writable',
]);

/**
 * Whether the bottom row has anything to say. PURE, and deliberately NOT
 * expressed as `UpdateLine` returning `null` (C-15 / P0-1 / D-19).
 *
 * A component that returns `null` still satisfies `if (update)` at the call site
 * - the prop is a React ELEMENT, and an element is truthy however it renders.
 * The row would become `<Box flexShrink={0}>{nothing}</Box>`, which in
 * full-screen is ZERO rows, and the transcript silently gains a row for as long
 * as the updater is idle and loses it again the moment it has news. That is
 * precisely the layout shift `BottomStatusRow` exists to prevent, and
 * `bottom-status-row.test.tsx`'s "holds one row in all four states" is the
 * assertion it would defeat.
 *
 * `ActivityLine` already settles the pattern: it ALWAYS returns an element, and
 * `App.tsx` decides presence at the call site with `running && !overlayNode`.
 */
export function shouldRenderUpdateLine(snapshot: UpdateSnapshot): boolean {
  if (
    snapshot.phase === 'available' ||
    snapshot.phase === 'installing' ||
    snapshot.phase === 'ready'
  ) {
    return true;
  }
  if (snapshot.phase === 'failed') {
    if (snapshot.reason && IMMEDIATE_NOTICE_REASONS.has(snapshot.reason)) return true;
    return snapshot.consecutiveFailures >= UPDATE_LIMITS.failuresBeforeNotice;
  }
  // `idle` / `checking` - the two phases the user must never be told about,
  // EXCEPT for a rollback this session has not yet reported. Placed LAST on
  // purpose: any real news above owns the row first, and the budget is one row
  // (C-15). It is therefore possible for the notice never to appear on a machine
  // that has an update waiting on the very next launch, which is the correct
  // trade - the newer fact is the more actionable one, and the rollback is still
  // in `/update status` and in the log.
  return Boolean(snapshot.rolledBackFrom);
}
