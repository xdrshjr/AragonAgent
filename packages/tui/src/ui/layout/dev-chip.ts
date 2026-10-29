/**
 * The status bar's developer-mode chip: pure width planning, no JSX
 * (tui-subagent-persona-and-developer-mode §3.3).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * SAME SHAPE AS `governance-chip.ts`, for the same reason: the status row is measured
 * cell by cell and a chip appended "just to the right" would eat `phase`. It competes
 * for the same budget and is hidden outright when it would leave the left half below
 * its floor. A chip is shown while developer mode is ON so that a mistyped hidden
 * chord can never silently change what the screen says: the user can SEE the mode.
 */

export const DEV_CHIP_LIMITS = {
  /** Blank cells between the chip and the field run. */
  gapCells: 2,
  /** The floor the left half must keep; the same 34 the other chips use. */
  minStatusCells: 34,
} as const;

export const DEV_CHIP_TEXT = 'DEV';

export interface DevChipPlan {
  visible: boolean;
  text: string;
  cells: number;
  gap: number;
  tone: 'warn';
}

export interface DevChipInput {
  columns: number;
  developerMode: boolean | undefined;
}

const HIDDEN: DevChipPlan = { visible: false, text: '', cells: 0, gap: 0, tone: 'warn' };

/** Plan the chip for `columns`. Total: any number in, a plan out. */
export function planDevChip(input: DevChipInput): DevChipPlan {
  if (input.developerMode !== true) return HIDDEN;
  const columns = Number.isFinite(input.columns) ? Math.floor(input.columns) : 0;
  const cells = DEV_CHIP_TEXT.length;
  const gap = DEV_CHIP_LIMITS.gapCells;
  if (columns - (cells + gap) < DEV_CHIP_LIMITS.minStatusCells) return HIDDEN;
  return { visible: true, text: DEV_CHIP_TEXT, cells, gap, tone: 'warn' };
}
