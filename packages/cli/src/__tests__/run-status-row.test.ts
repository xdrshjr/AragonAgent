/**
 * `planRunRow` - the run status row's per-clause width ladder
 * (tui-scrollbar-edge-and-run-row §3.3.3 / T6).
 */

import { describe, expect, it } from 'vitest';
import {
  RUN_ROW_LEAD,
  RUN_ROW_MIN_LABEL_COLS,
  RUN_ROW_REQUIRED_CLAUSES,
  planRunRow,
  type RunRowPlanInput,
} from '../ui/run-status-row.js';

// "Percolating..." -> spinner(2) + 12 = 14; clauses: queue 6, interrupt 15, exit 13.
const BASE: RunRowPlanInput = {
  cols: 120,
  labelCols: 14,
  hintClauseCols: [7, 15, 13],
  separatorCols: 3,
  chipCols: 7,
};
const plan = (over: Partial<RunRowPlanInput>) => planRunRow({ ...BASE, ...over });

describe('planRunRow - the §3.3.3 table', () => {
  it('120 columns: everything plus the chip', () => {
    expect(plan({ cols: 120 })).toEqual({ labelCols: 14, hintClauses: 3, chip: true });
  });

  it('80 columns: all clauses and the plan chip still fit', () => {
    // 14 + 3 + 41 = 58; + 2 + 7 = 67 <= 78
    expect(plan({ cols: 79 })).toEqual({ labelCols: 14, hintClauses: 3, chip: true });
  });

  it('drops the chip before any clause', () => {
    // inner 60: everything = 58 fits, 58 + 9 = 67 does not
    expect(plan({ cols: 61 })).toEqual({ labelCols: 14, hintClauses: 3, chip: false });
  });

  it('53 columns: exit is dropped whole, the label stays natural', () => {
    // inner 52; k=2 -> avail 52 - 3 - 25 = 24
    expect(plan({ cols: 53 })).toEqual({ labelCols: 14, hintClauses: 2, chip: false });
  });

  it('39 columns: label squeezed to 10, queue and interrupt stay whole', () => {
    expect(plan({ cols: 39 })).toEqual({ labelCols: 10, hintClauses: 2, chip: false });
  });

  it('a long tool label is the one that gives way', () => {
    // "Running mcp__playwright__browser_navigate" = 41 chars + spinner(2) = 43
    expect(plan({ cols: 53, labelCols: 43 })).toEqual({ labelCols: 24, hintClauses: 2, chip: false });
  });

  it('four clauses (background services) at 80 columns', () => {
    // queue 6, interrupt 15, stop N 13, exit 13 -> 47 + 9 = 56; 14 + 3 + 56 = 73 <= 78
    const out = plan({ cols: 79, hintClauseCols: [7, 15, 13, 13] });
    expect(out).toEqual({ labelCols: 14, hintClauses: 4, chip: false });
  });

  it('four clauses drop exit first, then stop N', () => {
    const four = { hintClauseCols: [7, 15, 13, 13] };
    expect(plan({ cols: 62, ...four })).toEqual({ labelCols: 14, hintClauses: 3, chip: false });
    expect(plan({ cols: 53, ...four })).toEqual({ labelCols: 14, hintClauses: 2, chip: false });
  });
});

describe('planRunRow - boundaries and robustness', () => {
  it('inner 38 is the last width that keeps both required clauses; 37 falls to label only', () => {
    expect(plan({ cols: 39 }).hintClauses).toBe(2); // inner 38
    expect(plan({ cols: 38 })).toEqual({ labelCols: 14, hintClauses: 0, chip: false }); // inner 37
  });

  it('never throws and never returns negative numbers on hostile input', () => {
    const hostile = [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1, 2, 3.7];
    for (const cols of hostile) {
      for (const labelCols of hostile) {
        const out = planRunRow({ ...BASE, cols, labelCols });
        expect(out.labelCols).toBeGreaterThanOrEqual(0);
        expect(out.hintClauses).toBeGreaterThanOrEqual(0);
      }
    }
    expect(planRunRow({ ...BASE, cols: 0 })).toEqual({ labelCols: 0, hintClauses: 0, chip: false });
  });

  it('fewer than two clauses degrades to the label alone', () => {
    expect(plan({ hintClauseCols: [] })).toEqual({ labelCols: 14, hintClauses: 0, chip: false });
    expect(plan({ hintClauseCols: [7] })).toEqual({ labelCols: 14, hintClauses: 0, chip: false });
  });

  it('keeps queue and interrupt whole at every width where any clause is shown', () => {
    const clauses = [7, 15, 13, 13];
    for (let cols = 1; cols <= 200; cols += 1) {
      for (const labelCols of [3, 14, 43, 80]) {
        for (const count of [3, 4]) {
          const input = { ...BASE, cols, labelCols, hintClauseCols: clauses.slice(0, count) };
          const out = planRunRow(input);
          if (out.hintClauses === 0) continue;
          expect(out.hintClauses).toBeGreaterThanOrEqual(RUN_ROW_REQUIRED_CLAUSES);
          const shown = clauses.slice(0, out.hintClauses);
          const used = out.labelCols + 3 + shown.reduce((a, b) => a + b, 0) + 3 * (shown.length - 1);
          expect(used).toBeLessThanOrEqual(cols - RUN_ROW_LEAD);
          expect(out.labelCols).toBeLessThanOrEqual(labelCols);
          if (out.labelCols < labelCols) expect(out.labelCols).toBeGreaterThanOrEqual(RUN_ROW_MIN_LABEL_COLS);
        }
      }
    }
  });
});
