/**
 * The governance slice of the view model: the small pure folds `reducer.ts` delegates to
 * (governance-mode section 14.4).
 *
 * Pure: no React, no I/O. ASCII ONLY (`agent/` is glyph-scanned).
 *
 * WHY A FILE OF ITS OWN. `reducer.ts` is already past the file-size ceiling and the repo
 * rule is "wiring-style growth only": each governance `case` in the reducer is a line or
 * two that calls a function here, so the logic is unit-testable without a `ViewState`.
 */

import type { AgentMode } from './agent-mode.js';
import type { GovernanceSnapshot } from '../governance/types.js';
import { composePosture, isGovernancePosture, type Posture } from '../governance/posture.js';

/** The posture half of a `setAgentMode` action. */
export interface AdoptedPostureInput {
  mode: AgentMode;
  pending: AgentMode | null;
  /** Written from the controller's adopted state; absent for callers that predate postures. */
  posture?: Posture;
  pendingPosture?: Posture | null;
}

/**
 * The pair of posture fields one `setAgentMode` dispatch writes.
 *
 * "NEVER DISPATCH THE REQUESTED VALUE, ONLY THE ADOPTED ONE" (spec 4.3): the controller
 * reports all four values together and the reducer mirrors them, so the badge and the gate
 * cannot disagree. A dispatch that carries only the gate mode (every pre-governance call
 * site) keeps the governance dimension the view already has and swaps the mode half, which
 * is exactly what such a caller meant.
 */
export function adoptPosture(
  current: Posture,
  action: AdoptedPostureInput,
): { posture: Posture; pendingPosture: Posture | null } {
  const governed = isGovernancePosture(current);
  const posture = action.posture ?? composePosture(action.mode, governed);
  const pendingPosture =
    action.pendingPosture !== undefined
      ? action.pendingPosture
      : action.pending === null
        ? null
        : composePosture(action.pending, governed);
  return { posture, pendingPosture };
}

/**
 * Fold a pushed snapshot into the view: a snapshot OLDER than the one held, for the same
 * run, is dropped (the wiring throttles, and a late flush must not roll the panel back).
 * Returns the held object unchanged when nothing should change.
 */
export function foldGovernanceSnapshot(
  held: GovernanceSnapshot | null,
  incoming: GovernanceSnapshot,
): GovernanceSnapshot {
  if (held !== null && held.runId === incoming.runId && incoming.rev < held.rev) return held;
  return incoming;
}
