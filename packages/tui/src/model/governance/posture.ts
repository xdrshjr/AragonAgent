/**
 * Posture - the user-visible composite of (gate mode, governance on)
 * (governance-mode section 4.1).
 *
 * Pure: no React, no I/O, no `node:*`. ASCII ONLY (`governance/` is glyph-scanned).
 *
 * WHY A COMPOSITE AND NOT A THIRD/FOURTH `AgentMode` (D-1). `AgentMode` is
 * `'build' | 'plan'` and 25+ sites key off that pair (`=== 'plan'`,
 * `Record<AgentMode, ...>`, the plan gate, the subagent `getMode`). Widening it needs a
 * silent-failure audit of every one of them (a miss means "writable when it should be
 * read-only"). Two orthogonal dimensions leave every existing path untouched.
 */

import type { AgentMode } from '../agent/agent-mode.js';

export type Posture = 'build' | 'plan' | 'govern' | 'plan_govern';

/** Full Shift+Tab cycle: BUILD -> PLAN -> GOVERN -> PLAN+GOVERN -> BUILD. */
export const POSTURES_FULL: readonly Posture[] = ['build', 'plan', 'govern', 'plan_govern'] as const;
/** The classic two-state cycle, used whenever governance is unavailable or switched off. */
export const POSTURES_CLASSIC: readonly Posture[] = ['build', 'plan'] as const;

export const POSTURE_LABEL: Record<Posture, string> = {
  build: 'BUILD',
  plan: 'PLAN',
  govern: 'GOVERN',
  plan_govern: 'PLAN+GOVERN',
};

/** Lower-case spelling for the `shift+tab <next>` hint clause. */
export function postureHintWord(posture: Posture): string {
  return POSTURE_LABEL[posture].toLowerCase();
}

/** (gate mode, governance on) -> posture. Exhaustive; the one place the mapping lives. */
export function composePosture(mode: AgentMode, governanceOn: boolean): Posture {
  if (mode === 'plan') return governanceOn ? 'plan_govern' : 'plan';
  return governanceOn ? 'govern' : 'build';
}

/** posture -> (gate mode, governance on). Inverse of `composePosture`. */
export function splitPosture(posture: Posture): { mode: AgentMode; governance: boolean } {
  switch (posture) {
    case 'build':
      return { mode: 'build', governance: false };
    case 'plan':
      return { mode: 'plan', governance: false };
    case 'govern':
      return { mode: 'build', governance: true };
    case 'plan_govern':
      return { mode: 'plan', governance: true };
  }
}

/** True when the posture has governance switched on. */
export function isGovernancePosture(posture: Posture): boolean {
  return posture === 'govern' || posture === 'plan_govern';
}

/**
 * The next posture in `cycle`. A `current` outside the cycle (e.g. `govern` while the
 * cycle is classic) advances to `'build'` - never throws, never loops on itself.
 */
export function nextPosture(current: Posture, cycle: readonly Posture[]): Posture {
  const index = cycle.indexOf(current);
  if (index < 0) return 'build';
  return cycle[(index + 1) % cycle.length]!;
}
