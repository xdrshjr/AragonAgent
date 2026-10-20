/**
 * The session-id chip: pure width planning, no JSX
 * (tui-session-id-resume §3.9 / D-11 / D-12).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * WHY A PLANNER AND NOT A STYLED `<Text>`: the status bar is a cell-by-cell
 * measured row with a six-rung degradation ladder (`status-layout.ts`), not a
 * flex layout.
 * Anything positioned "just to the right" pushes the left half over or covers
 * `phase`, and `phase` is the field a user needs while a run is in flight. The
 * chip therefore spends cells out of the SAME budget as every other field.
 *
 * THE ID IS NEVER TRUNCATED (D-12). A truncated id produces a `--resume` command
 * that is guaranteed to fail, which is strictly worse than showing nothing: the
 * rungs below are, in order, "drop the label" and only then "hide the whole
 * chip", and `/session` reports the full id at any width.
 */

import stringWidth from 'string-width';

export const SESSION_CHIP_LIMITS = {
  /** The same threshold `Header.tsx` uses for its `^I Index` hint. */
  labelMinCols: 72,
  /** Blank cells between the last status field and the chip. */
  gapCells: 2,
  /**
   * The tightest rung's worst-case width for the fields on the LEFT, summed:
   * phase glyph(1)+label(4)=5, sep 1 -> 6, deferred mode 'C>B' 3 -> 9,
   * sep 1 -> 10, 'C'+'~999%' 6 -> 16, sep 1 -> 17, thinking code 1 -> 18,
   * sep 1 -> 19, '>99M/s' 6 -> 25, sep 1 -> 26, '>999d' 5 -> 31.
   *
   * 34 IS A FLOOR ROUNDED UP, not a measurement: over-estimating hides the chip
   * one column early, which is invisible; under-estimating lets the chip eat the
   * phase field, which is not.
   */
  minStatusCells: 34,
} as const;

export interface SessionChipPlan {
  visible: boolean;
  text: string;
  cells: number;
  gap: number;
}

/** `{visible:false}` - the shape every caller can cheaply branch on. */
const HIDDEN: SessionChipPlan = { visible: false, text: '', cells: 0, gap: 0 };

/**
 * Plan the chip for `columns` and this session's id.
 *
 * Inputs are the same ones the status row already has, so the two plans cannot
 * disagree about the terminal: `StatusBar` computes `chip` first and hands
 * `chip.cells + chip.gap` to `planPrimaryStatusFields` as `reserveRight`.
 */
export function planSessionChip(input: {
  columns: number;
  sessionId?: string | null;
}): SessionChipPlan {
  // No identity (the default build, a test, or a host with no session) is the
  // `undefined` case, and it must cost nothing: reserveRight stays 0 and the
  // status row's output is byte-identical to the pre-feature build (I-6).
  if (!input.sessionId) return HIDDEN;
  const columns = Number.isFinite(input.columns) ? Math.floor(input.columns) : 80;
  const id = input.sessionId;
  const gap = SESSION_CHIP_LIMITS.gapCells;
  const fits = (text: string): boolean =>
    columns - 1 - gap - stringWidth(text) >= SESSION_CHIP_LIMITS.minStatusCells;
  // Widest form first, then drop the label, then hide: the order is the decision.
  const labelled = `id ${id}`;
  if (columns >= SESSION_CHIP_LIMITS.labelMinCols && fits(labelled)) {
    return { visible: true, text: labelled, cells: stringWidth(labelled), gap };
  }
  if (fits(id)) return { visible: true, text: id, cells: stringWidth(id), gap };
  return HIDDEN;
}
