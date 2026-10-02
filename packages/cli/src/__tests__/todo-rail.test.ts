/**
 * Rail geometry (AC-19, AC-20, AC-21, AC-39).
 *
 * Pinned as arithmetic for the reason `budget.test.ts` records: the viewport was
 * NON-MONOTONIC in `rows` for a whole release before anyone measured it, and a
 * width that shrinks as the window grows is the same class of defect one axis
 * over.
 */

import { describe, expect, it } from 'vitest';
import {
  TODO_RAIL_MAX_COLS,
  TODO_RAIL_MIN_COLS,
  TODO_RAIL_MIN_TOTAL_COLS,
  todoRailWidth,
} from '../ui/layout/rail.js';

describe('todoRailWidth', () => {
  it('按十五个百分点分配并保留正文下限', () => {
    for (const [cols, expected] of [[75, 0], [76, 14], [80, 14], [100, 15],
      [120, 18], [160, 24], [200, 30], [240, 36], [300, 36], [75.9, 0]]) {
      expect(todoRailWidth(cols!)).toBe(expected);
    }
  });

  it('AC-19: non-decreasing across [40, 300]', () => {
    // A user dragging a window WIDER must never see the rail get narrower.
    let previous = 0;
    for (let cols = 40; cols <= 300; cols += 1) {
      const width = todoRailWidth(cols);
      expect(width, `cols=${cols}`).toBeGreaterThanOrEqual(previous);
      previous = width;
    }
  });

  it('AC-21: the transcript keeps at least 62 columns at every width', () => {
    // Every existing width heuristic inside the viewport — `TERSE_HINT_COLS` 42,
    // `MIN_INDICATOR_COLS` 50, the status bar's 60 / 72 steps — sits below that
    // floor, so no existing behaviour changes because a rail appeared (R-3).
    for (let cols = TODO_RAIL_MIN_TOTAL_COLS; cols <= 300; cols += 1) {
      expect(cols - todoRailWidth(cols), `cols=${cols}`).toBeGreaterThanOrEqual(62);
    }
  });

  it('clamps at both ends rather than taking a literal 15%', () => {
    // Unclamped, 15% is an unreadable strip at the bottom and 40 columns of
    // whitespace at the top (D-8).
    expect(todoRailWidth(85)).toBe(TODO_RAIL_MIN_COLS);
    expect(todoRailWidth(1000)).toBe(TODO_RAIL_MAX_COLS);
  });

  it('treats a missing or nonsense width as "no rail" rather than throwing', () => {
    expect(todoRailWidth(Number.NaN)).toBe(0);
    expect(todoRailWidth(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
