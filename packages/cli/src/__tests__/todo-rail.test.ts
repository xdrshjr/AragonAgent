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
  todoRailRows,
  todoRailWidth,
} from '../ui/layout/rail.js';
import { TODO_LIMITS } from '../todo/limits.js';

describe('todoRailWidth', () => {
  it('AC-20: 0 below 80 columns, 18 at 80, 24 at 120, 36 at 200', () => {
    expect(todoRailWidth(79)).toBe(0);
    expect(todoRailWidth(TODO_RAIL_MIN_TOTAL_COLS)).toBe(18);
    expect(todoRailWidth(120)).toBe(24);
    expect(todoRailWidth(200)).toBe(TODO_RAIL_MAX_COLS);
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

  it('clamps at both ends rather than taking a literal 20%', () => {
    // Unclamped, 20% is an unreadable strip at the bottom and 40 columns of
    // whitespace at the top (D-8).
    expect(todoRailWidth(85)).toBe(TODO_RAIL_MIN_COLS);
    expect(todoRailWidth(1000)).toBe(TODO_RAIL_MAX_COLS);
  });

  it('treats a missing or nonsense width as "no rail" rather than throwing', () => {
    expect(todoRailWidth(Number.NaN)).toBe(0);
    expect(todoRailWidth(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('todoRailRows (AC-39)', () => {
  it('subtracts the team roster worst case, and only when a dispatch is live', () => {
    // IT IS NOT `viewportBudget` (P1-3). `viewportRows()` subtracts the STATIC
    // chrome only; the live roster costs up to 8 rows inside `AppShell`'s
    // measured bottom box that the budget knows nothing about. Ink clips from
    // the bottom, so over-requesting silently eats the `+N below` marker.
    expect(todoRailRows(20, false)).toBe(20);
    expect(todoRailRows(20, true)).toBe(20 - TODO_LIMITS.railReservedRows);
  });

  it('floors at zero rather than going negative', () => {
    expect(todoRailRows(3, true)).toBe(0);
    expect(todoRailRows(0, false)).toBe(0);
    expect(todoRailRows(Number.NaN, false)).toBe(0);
  });

  it('reserves the FULL worst case rather than a measurement (D-23)', () => {
    // Over-subtracting costs one item row; under-subtracting costs the overflow
    // marker, whose absence is indistinguishable from "the list is short". Those
    // two mistakes are not equally bad.
    expect(TODO_LIMITS.railReservedRows).toBeGreaterThanOrEqual(8);
  });
});
