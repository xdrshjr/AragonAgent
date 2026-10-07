/** Compatibility planner for former composer run rows. The current UI uses
 * status-layout.ts and interaction-hints.ts; keep this pure API for existing callers.
 */

import type { StatusLayoutInput } from './layout/status-layout.js';

/** Shared activity facts; omitted phase fields retain the legacy phrase behavior. */
export interface RunActivity {
  phase?: StatusLayoutInput['phase'];
  outcome?: StatusLayoutInput['runOutcome'];
  activeTool?: StatusLayoutInput['activeTool'];
  /** Epoch ms the current run began - the phrase sequence's seed. */
  startedAt: number;
  /** `Date.now() - startedAt`, already computed by App's 200 ms ticker. */
  elapsedMs: number;
  /** The RAW config flag, never the widened one (single-spinner D-5). */
  reducedMotion: boolean;
  /** The tool currently in flight, if any. */
  runningTool?: string;
  /** A context compaction is in flight; outranks the tool name and the phrase. */
  compacting?: boolean;
}

export interface RunRowPlanInput {
  /** Width of the row's container (the composer's content columns). */
  cols: number;
  /** Spinner + space + label, in display columns (the label's natural width). */
  labelCols: number;
  /** Display width of each hint clause, most urgent first. */
  hintClauseCols: readonly number[];
  /** Display width of the separator between clauses (` · ` or ` - `). */
  separatorCols: number;
  /** Display width of the right-aligned mode chip; 0 = no chip. */
  chipCols: number;
}

export interface RunRowPlan {
  /** Columns the label may occupy; below its natural width it is ellipsized. */
  labelCols: number;
  /** How many leading clauses to show; 0 = none (defensive tier only). */
  hintClauses: number;
  /** Whether the chip fits after everything else. */
  chip: boolean;
}

/** One leading space, matching the idle hint row's `'  '` indent. */
export const RUN_ROW_LEAD = 1;
/** Narrowest the label may be squeezed before a clause is dropped instead. */
export const RUN_ROW_MIN_LABEL_COLS = 10;
/** `steer` and `interrupt`: always whole while the row is enabled. */
export const RUN_ROW_REQUIRED_CLAUSES = 2;
/** Space kept between the last clause and the chip. */
export const RUN_ROW_CHIP_GAP = 2;

/** Non-finite or negative widths collapse to 0 so no input can make the plan throw. */
function width(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Width of the first `count` clauses joined by `separator`. */
function clausesWidth(clauses: readonly number[], count: number, separator: number): number {
  if (count <= 0) return 0;
  let total = separator * (count - 1);
  for (let i = 0; i < count; i += 1) total += clauses[i] ?? 0;
  return total;
}

export function planRunRow(input: RunRowPlanInput): RunRowPlan {
  const inner = Math.max(0, width(input.cols) - RUN_ROW_LEAD);
  const natural = width(input.labelCols);
  const separator = width(input.separatorCols);
  const chipCols = width(input.chipCols);
  const clauses = input.hintClauseCols.map(width);
  const total = clauses.length;
  const labelOnly: RunRowPlan = {
    labelCols: Math.min(natural, inner), hintClauses: 0, chip: false,
  };
  if (total < RUN_ROW_REQUIRED_CLAUSES) return labelOnly;

  // Tier 1: everything fits; the chip is the first thing to go.
  const everything = natural + separator + clausesWidth(clauses, total, separator);
  if (everything <= inner) {
    const chip = chipCols > 0 && everything + RUN_ROW_CHIP_GAP + chipCols <= inner;
    return { labelCols: natural, hintClauses: total, chip };
  }

  // Tier 2: drop clauses from the tail, but never below the required two; only the
  // label may be squeezed (down to its minimum) to make the remaining clauses fit.
  for (let kept = total - 1; kept >= RUN_ROW_REQUIRED_CLAUSES; kept -= 1) {
    const available = inner - separator - clausesWidth(clauses, kept, separator);
    if (available >= RUN_ROW_MIN_LABEL_COLS) {
      return { labelCols: Math.min(natural, available), hintClauses: kept, chip: false };
    }
  }

  // Tier 3 (defensive, below ~40 columns): the label alone. The status bar's own
  // `Esc x2 interrupt` carries the urgent hint at this width.
  return labelOnly;
}
