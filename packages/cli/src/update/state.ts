/**
 * `<home>/update-state.json` (cli-auto-update section 5.2).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * WHY NOT `state.json` (D-14 / C-6). That file is documented as UI bookkeeping
 * SCALARS ONLY, and its header names itself "the most inviting drawer in the
 * codebase". What lives here is CROSS-PROCESS COORDINATION state with a
 * completely different lifetime and failure policy: ten terminals read it to
 * decide whether anyone has already asked the registry today. The rule exists
 * precisely to stop the merge that looks convenient today.
 *
 * FAILURE POLICY: copies `ui-state.ts` verbatim - per-field tolerance, whole
 * object fallback on a wrong `schema`, atomic temp-file + rename + `chmod 0600`,
 * and NEVER THROWS. Losing the file costs one extra registry request.
 *
 * NO PROCESS-LIFETIME CACHE, unlike `ui-state.ts`. The whole point of
 * `lastCheckAt` is that a SECOND aragon process wrote it (section 3.7), so a
 * value memoized at first read would defeat the throttle it exists to implement.
 *
 * ==========================================================================
 * C-17 - THIS FILE IS A CROSS-VERSION CHANNEL, AND `readUpdateState` ERASES
 * WHAT IT DOES NOT KNOW.
 *
 * The reader below rebuilds the object FIELD BY FIELD from a fixed list, so an
 * OLDER `aragon` reading and writing this file destroys every field added after
 * it shipped. Two consequences, and both have already been reasoned through
 * (cli-auto-update-hardening section 7.1 / D-27 / D-28):
 *
 *  1. DO NOT BUMP `UPDATE_STATE_SCHEMA` TO ADD A FIELD. A bump makes the reader
 *     fall back to the WHOLE default object on the first read after an upgrade
 *     (see the `parsed.schema !== ...` line), which discards `skippedVersion` -
 *     the field that stops an `install-ineffective` loop (R-12) and a
 *     bad-release loop (H1) - on every machine at once. Per-field tolerance
 *     already handles absence: a missing field reads as its default.
 *  2. A ROLLBACK MUST LATCH THROUGH `skippedVersion`, which is a schema-1 field
 *     every shipped version honours. Latching only in one of the four fields
 *     below would be invisible to a CLI that predates them, which would decide
 *     `install` on its next check and reinstall the release that just bricked
 *     the machine - once per interval, forever.
 * ==========================================================================
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { getHomeRoot, getUpdateStatePath } from '../config/app-paths.js';

export const UPDATE_STATE_FILENAME = 'update-state.json';
export const UPDATE_STATE_SCHEMA = 1;

export interface UpdateState {
  schema: number;
  /** Epoch ms of the last registry request by ANY process; `0` = never. */
  lastCheckAt: number;
  /** `''` = unknown. */
  lastKnownVersion: string;
  /** Installed and awaiting a relaunch; `''` = none. */
  pendingRestartVersion: string;
  /** `''` = none. Set by `/update skip` and by an ineffective install (U-6). */
  skippedVersion: string;
  consecutiveFailures: number;
  lastFailureAt: number;
  /**
   * The version THIS UPDATER installed and has not yet seen boot healthy.
   * `''` = the boot guard is disarmed, which is every launch on every machine
   * except the first one after an auto-update.
   */
  autoInstalledVersion: string;
  /**
   * The version that was running when the last auto-install ran, or the last
   * version seen to boot healthy. THE ROLLBACK TARGET.
   */
  lastGoodVersion: string;
  /**
   * Launches of `autoInstalledVersion` that EXITED NON-ZERO. Reset by
   * `markBootHealthy`, by a rollback, and by each new arming.
   *
   * NAMED FOR FAILURES AND NOT FOR ATTEMPTS, and the name is the specification
   * (P1-5). A counter named for attempts invites an increment at boot, and an
   * increment at boot has no per-process identity: three terminals starting
   * inside the window between the first one's increment and its
   * `markBootHealthy` walk it to the threshold, and the third rolls back a
   * release running fine in the other two. A counter named for failures can only
   * be incremented where a failure is observable, which is the exit hook.
   */
  bootFailures: number;
  /**
   * The version the last rollback moved away from. Written by `performRollback`
   * and consumed EXACTLY ONCE by `UpdateService.start()`. `''` = nothing to
   * report.
   */
  rolledBackFrom: string;
}

export const DEFAULT_UPDATE_STATE: UpdateState = {
  schema: UPDATE_STATE_SCHEMA,
  lastCheckAt: 0,
  lastKnownVersion: '',
  pendingRestartVersion: '',
  skippedVersion: '',
  consecutiveFailures: 0,
  lastFailureAt: 0,
  autoInstalledVersion: '',
  lastGoodVersion: '',
  bootFailures: 0,
  rolledBackFrom: '',
};

function count(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Per-field tolerance: one nonsense value must not take the others with it, and
 * a field this version has never heard of reads as its default rather than
 * failing the parse. A wrong SCHEMA is different - the shape is no longer known,
 * so the whole object falls back (the rule `ui-state.ts` and `skills/usage.ts`
 * follow). See C-17 in the header before adding a field OR touching the schema.
 */
export function readUpdateState(): UpdateState {
  const path = getUpdateStatePath();
  if (!existsSync(path)) return { ...DEFAULT_UPDATE_STATE };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<UpdateState>;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_UPDATE_STATE };
    if (parsed.schema !== UPDATE_STATE_SCHEMA) return { ...DEFAULT_UPDATE_STATE };
    return {
      schema: UPDATE_STATE_SCHEMA,
      lastCheckAt: count(parsed.lastCheckAt, DEFAULT_UPDATE_STATE.lastCheckAt),
      lastKnownVersion: text(parsed.lastKnownVersion, DEFAULT_UPDATE_STATE.lastKnownVersion),
      pendingRestartVersion: text(
        parsed.pendingRestartVersion,
        DEFAULT_UPDATE_STATE.pendingRestartVersion,
      ),
      skippedVersion: text(parsed.skippedVersion, DEFAULT_UPDATE_STATE.skippedVersion),
      consecutiveFailures: count(
        parsed.consecutiveFailures,
        DEFAULT_UPDATE_STATE.consecutiveFailures,
      ),
      lastFailureAt: count(parsed.lastFailureAt, DEFAULT_UPDATE_STATE.lastFailureAt),
      autoInstalledVersion: text(
        parsed.autoInstalledVersion,
        DEFAULT_UPDATE_STATE.autoInstalledVersion,
      ),
      lastGoodVersion: text(parsed.lastGoodVersion, DEFAULT_UPDATE_STATE.lastGoodVersion),
      bootFailures: count(parsed.bootFailures, DEFAULT_UPDATE_STATE.bootFailures),
      rolledBackFrom: text(parsed.rolledBackFrom, DEFAULT_UPDATE_STATE.rolledBackFrom),
    };
  } catch {
    return { ...DEFAULT_UPDATE_STATE };
  }
}

/**
 * Atomic write: temp file, rename, re-chmod. Never throws.
 *
 * `mkdirSync` first for the reason `prompt-history.ts` and `ui-state.ts` both
 * record: `<home>` is not guaranteed to exist, and without it the throttle would
 * silently never persist on a fresh install - which presents as one registry
 * request per launch forever.
 */
function writeUpdateState(state: UpdateState): void {
  const path = getUpdateStatePath();
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(getHomeRoot(), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing further to try; the value simply stays in memory.
    }
  }
}

/**
 * Read-modify-write. READ-MODIFY-WRITE AND NOT WRITE, deliberately: another
 * `aragon` may have recorded a check or an install between our read and this
 * call, and clobbering its `lastCheckAt` is how ten terminals turn back into ten
 * registry requests.
 */
export function updateUpdateState(patch: Partial<Omit<UpdateState, 'schema'>>): UpdateState {
  const next: UpdateState = { ...readUpdateState(), ...patch, schema: UPDATE_STATE_SCHEMA };
  writeUpdateState(next);
  return next;
}
