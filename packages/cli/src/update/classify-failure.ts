/**
 * Turning a tail of npm output into a reason (cli-auto-update-hardening H2 /
 * section 5.3).
 *
 * ASCII ONLY - this tree is inside the glyph scanner's scope (C-2 / C-3).
 *
 * PURE, AND THE ONLY IMPORT IS A TYPE. The interesting half of H2 is not this
 * table, it is the REPORTING rule that decides which of the resulting reasons
 * may break the three-strike silence - and that lives in `types.ts` beside
 * `shouldRenderUpdateLine`, as `IMMEDIATE_NOTICE_REASONS`.
 *
 * WHY THIS EXISTS AT ALL. The one line a user is ever allowed to see on the
 * failure path reads `update failed <dot> npm i -g @aragon-agent/cli` for EVERY
 * cause. For `EPERM` / `EBUSY` - the Windows self-replacement case, R-3 - that
 * advice hits the same held handle and fails identically, so the single visible
 * failure is also a wrong instruction.
 */

import type { UpdateReason } from './types.js';

/**
 * FIRST MATCH WINS, AND THE ORDER IS NOT ALPHABETICAL.
 *
 * `EPERM` is tested before `EACCES` because npm's Windows output frequently
 * carries BOTH - the `EPERM` on the shim rename plus an `EACCES` from a retry -
 * and the actionable one is the first. `network` is last because "proxy" and
 * "network" appear inside unrelated npm advisory text often enough that an
 * earlier position would swallow the three specific cases above it.
 */
const TABLE: ReadonlyArray<readonly [RegExp, UpdateReason]> = [
  [
    /\bEPERM\b|\bEBUSY\b|\bETXTBSY\b|operation not permitted|resource busy or locked/i,
    'blocked-by-os',
  ],
  [/\bEACCES\b|permission denied/i, 'not-writable'],
  [/\bENOSPC\b|no space left/i, 'no-space'],
  [
    /\bENOTFOUND\b|\bEAI_AGAIN\b|\bECONNRESET\b|\bETIMEDOUT\b|network|proxy|tunneling socket/i,
    'network',
  ],
];

/**
 * Classify an install failure from the bounded stderr tail `runNpmInstall`
 * already returns.
 *
 * ONE PARAMETER, NOT TWO. An earlier draft took `exitCode` and never read it:
 * npm exits `1` for every one of these, so the code carries no information the
 * tail does not, and a parameter that no branch and no test consumes is a
 * maintenance liability that reads like a promise (P2-2).
 *
 * An absent or unrecognised tail is `install-failed` - the pre-H2 behaviour, so
 * a machine whose npm says something we have never seen degrades to exactly what
 * it did before rather than to a confident wrong answer.
 */
export function classifyInstallFailure(tail: string | undefined): UpdateReason {
  if (!tail) return 'install-failed';
  for (const [re, reason] of TABLE) {
    if (re.test(tail)) return reason;
  }
  return 'install-failed';
}
