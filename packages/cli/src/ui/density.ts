/**
 * Entry spacing policy (spec §4.3).
 *
 * Replaces four unconditional `marginTop={1}` sites (`UserEntry`,
 * `AssistantEntry`, `ToolCard`, the notice branch in `Transcript`). Those spent
 * a blank row on EVERY entry, so a plain "ask -> read a file -> answer" turn was
 * 17 rows tall against a 13-16 row viewport: the user could only ever see the
 * current step.
 *
 * Blank space now marks the one boundary that means something — the start of a
 * new user turn. Everything inside a turn stays contiguous, and the left rail
 * (§4.3) provides the grouping the blank rows used to.
 *
 * Pure and free of React so `density.test.ts` can enumerate the whole matrix.
 */

import type { Entry } from '../agent/reducer.js';
import type { DensityMode } from '../config/schema.js';

export type { DensityMode };

/**
 * Blank rows to insert BEFORE `next`. `prev === undefined` means `next` is the
 * first item in the list.
 *
 * This is the ONLY place allowed to decide entry spacing: if a component also
 * sets its own `marginTop`, the two stack and the turn boundary becomes 2 rows.
 */
export function separationRows(
  prev: Entry | undefined,
  next: Entry,
  mode: DensityMode,
): 0 | 1 {
  if (!prev) return 0;
  if (mode === 'compact') return 0;
  // Consecutive tool calls read as one action; keep them tight.
  if (prev.kind === 'tool' && next.kind === 'tool') return 0;
  if (next.kind === 'user') return 1;
  return 0;
}
