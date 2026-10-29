/**
 * The rail's two-section row allocation (todo-acceptance-criteria §6.9.2).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * ONE ROW IDENTITY, DEFINED BEFORE IT IS IMPLEMENTED, and it is the only
 * bookkeeping this feature does:
 *
 *   showGauge            1 row when the gauge rule fires (width >= 20, rows >= 8)
 *   + 1                  the TODO header row
 *   + (compact ? 0 : 1)  ONE blank row: the full rail has it, the compact rail does not
 *   + todoItemRows
 *   + Number(todoFooter)
 *   + (acc ? acc.headerRows + acc.itemRows : 0)
 *   <= rows
 *
 * `overhead = 3` appears only in the full rung with a `visible` second section:
 * 1 TODO header + 1 blank row + 1 ACCEPT header. THAT BLANK ROW IS THE SAME ROW
 * TWICE OVER - it is the breathing space under the TODO header AND the separator
 * between the two sections - so counting it twice overflows the box by one row,
 * and Ink's `overflow="hidden"` clips the overflow silently. The symptom a user
 * reports is "the panel only shows 2 criteria", which is why this comment is at
 * the top of the file rather than next to the arithmetic.
 *
 * PURE: no I/O, no timers, no imports from `ui/**`. The rail renders what this
 * returns; `/perf` reports the `acceptance.reason` it returns; the status-bar chip
 * asks it whether the rail is already reporting the count. One number, one owner.
 */

import { TODO_LIMITS } from './limits.js';
import type { PlanPhase } from './types.js';

export interface PlanSectionsInput {
  /** The rail's whole row budget (`TodoPanel`'s `rows` prop). */
  rows: number;
  /** The rail's whole column budget, chrome included. */
  width: number;
  phase: PlanPhase;
  todoCount: number;
  /** 0 means "no acceptance section at all". */
  acceptanceCount: number;
  /** Decided by `TodoPanel` under the existing gauge rule (width >= 20, rows >= 8). */
  showGauge: boolean;
}

/**
 * `visible` - header row plus item rows.
 * `summary` - one row only (`AC 2/5`), no header, no items.
 * `absent`  - nothing at all; the count has to reach the status-bar chip (I-7).
 */
export type AcceptanceSectionReason = 'visible' | 'summary' | 'absent';

export interface PlanSections {
  todoItemRows: number;
  /** Whether the `-N +M` footer is drawn (the existing `compactFooter` semantics). */
  todoFooter: boolean;
  acceptance: {
    reason: AcceptanceSectionReason;
    /** 1 = header row drawn; 0 = summary row only. */
    headerRows: number;
    /** > 0 to draw item rows. */
    itemRows: number;
  } | null;
}

/**
 * Clamp, and NEVER silently reverse: `clampRows` requires `lo <= hi` at the call
 * site, which every branch below establishes before it calls (§6.9.2, P2-5).
 * `clampRows(x, 1, 0)` would return 0 - a panel that draws no acceptance rows and
 * says nothing about why.
 */
function clampRows(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * The share of the item budget a `work`/`done` rail gives the criteria: 0.3, so the
 * two sections trade rows rather than one starving the other (§6.9.2 step 6). The
 * `verify` phase does not use it - there the criteria take everything above one row.
 */
const ACCEPTANCE_SHARE = 0.3;

export function buildPlanSections(input: PlanSectionsInput): PlanSections {
  const rows = Math.max(0, Math.floor(input.rows));
  const acceptanceCount = Math.max(0, Math.floor(input.acceptanceCount));
  const todoCount = Math.max(0, Math.floor(input.todoCount));
  // 1. The existing definition of "compact", unchanged.
  const compact = rows < TODO_LIMITS.panelFullRows;
  // 2. What is left after the gauge, unchanged.
  const available = rows - Number(input.showGauge);
  // 3. The existing footer rule, unchanged.
  const todoFooter = compact && todoCount > rows - 1;

  // 4. No criteria: BYTE-IDENTICAL to the pre-feature arithmetic (I-5).
  if (acceptanceCount === 0) {
    return {
      todoItemRows: compact
        ? rows - 1 - Number(todoFooter)
        : rows - 2 - Number(input.showGauge),
      todoFooter,
      acceptance: null,
    };
  }

  // 5. Compact rung: rows in {3,4,5}, the gauge never fires, available === rows.
  if (compact) {
    const base = rows - 1 - Number(todoFooter);
    // Lend one row to the summary line, but never the TODO window's last row.
    // `absent` is reachable ONLY at rows === 3 with a footer (base === 1), which
    // is the one "panel is up, section is not" combination (AC-34).
    if (base - 1 >= 1) {
      return {
        todoItemRows: base - 1,
        todoFooter,
        acceptance: { reason: 'summary', headerRows: 0, itemRows: 1 },
      };
    }
    return {
      todoItemRows: base,
      todoFooter,
      acceptance: { reason: 'absent', headerRows: 0, itemRows: 0 },
    };
  }

  // 6. Full rung: rows >= 6. Three rows of chrome for the second section.
  const budget = available - 3;
  if (input.phase === 'verify') {
    // Every step is done, so the step list carries no information - one row says
    // so and the rest goes to the criteria the eye is actually on (D-7).
    return {
      todoItemRows: 1,
      todoFooter: false,
      acceptance: {
        reason: 'visible',
        headerRows: 1,
        itemRows: clampRows(budget - 1, 1, acceptanceCount),
      },
    };
  }

  // `work` AND `done` share this branch on purpose: a plan that just passed every
  // criterion must keep showing the table it passed - that is the screen the user
  // wants to read - rather than fold like `verify` does.
  const accItemRows = clampRows(
    Math.round(budget * ACCEPTANCE_SHARE),
    1,
    Math.min(acceptanceCount, budget - 1),
  );
  return {
    todoItemRows: budget - accItemRows,
    todoFooter: false,
    acceptance: { reason: 'visible', headerRows: 1, itemRows: accItemRows },
  };
}
