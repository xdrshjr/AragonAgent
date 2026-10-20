/**
 * The row budget of the top give-way
 * (tui-final-reply-truncated-unscrollable, plan A-prime / B3; assertions A1-A12).
 *
 * These are the arithmetic tests: no Ink, no terminal, no `App`. The end-to-end proof that
 * the plan reaches a real screen is `scrollback-top-give-way.test.tsx`; this file pins the
 * four decisions the whole fix rests on - which rows are hidden, where the plan stops, that
 * a width change is a seam rather than a silent skip, and that the per-entry cap keeps the
 * rows the reader is looking at.
 */

import { describe, expect, it } from 'vitest';
import type { Entry } from '../agent/reducer.js';
import { SCROLLBACK_LIMITS } from '../ui/scrollback/limits.js';
import {
  capPrintedRows,
  elisionRow,
  planOverflowPrint,
  reflowSeamRow,
  type OverflowWindowEntry,
} from '../ui/scrollback/overflow-print.js';
import { resolveTailAnchor, tailAnchor } from '../ui/scrollback/tail-anchor.js';

const notice = (id: string, text = 'row'): Entry => ({
  id, kind: 'notice', level: 'info', text,
});

const item = (
  id: string, rows: number, printed = 0, stable = true,
): OverflowWindowEntry => ({ entry: notice(id), rows, printed, stable });

describe('planOverflowPrint: what the box hides', () => {
  it('prints nothing when the window fits (the everyday frame)', () => {
    const plan = planOverflowPrint([item('a', 2), item('b', 3)], 24);
    expect(plan.segments).toEqual([]);
    expect(plan.hiddenRows).toBe(0);
    expect(plan.totalRows).toBe(5);
  });

  it('prints the head of one answer that is taller than the box (A1)', () => {
    // 60 rows in a 24-row box: rows 0-35 are above the top edge, rows 36-59 are on screen.
    const plan = planOverflowPrint([item('answer', 60)], 24);
    expect(plan.hiddenRows).toBe(36);
    expect(plan.segments).toEqual([{ index: 0, id: 'answer', fromRow: 0, toRow: 36 }]);
  });

  it('stops at the row that is still visible, so nothing prints twice (A3)', () => {
    // Three entries, 10 rows each, a 12-row box: 18 rows are hidden, so `a` prints whole and
    // `b` prints 8 of its 10 rows. The plan stops there because the rest of `b` and all of
    // `c` are on screen - printing them would put the same row in two places.
    const plan = planOverflowPrint([item('a', 10), item('b', 10), item('c', 10)], 12);
    expect(plan.hiddenRows).toBe(18);
    expect(plan.segments).toEqual([
      { index: 0, id: 'a', fromRow: 0, toRow: 10 },
      { index: 1, id: 'b', fromRow: 0, toRow: 8 },
    ]);
    const printedRows = plan.segments.reduce(
      (sum, segment) => sum + segment.toRow - segment.fromRow, 0,
    );
    expect(printedRows).toBe(plan.hiddenRows);
  });

  it('continues where the previous pass stopped instead of reprinting (A8)', () => {
    const plan = planOverflowPrint([item('answer', 60, 36)], 24);
    // Rows 0-35 are already in the scrollback, so a pass that finds the same overflow has
    // nothing left to do - and a LONGER answer prints only the new hidden rows.
    expect(plan.segments).toEqual([]);
    const grown = planOverflowPrint([item('answer', 70, 36)], 24);
    expect(grown.segments).toEqual([{ index: 0, id: 'answer', fromRow: 36, toRow: 46 }]);
  });

  it('stops at the first unstable entry - the wall rule (A12)', () => {
    // `[streaming assistant, notice]`: the notice IS stable, but it comes after an entry the
    // reducer is still writing, and rows may never enter the scrollback out of order.
    const plan = planOverflowPrint([item('streaming', 40, 0, false), item('notice', 2)], 24);
    expect(plan.segments).toEqual([]);
    // The wall is a HARD stop, not a skip: a stable entry AFTER it may not print either -
    // while a stable entry BEFORE it still may, because that one is in order.
    const afterWall = planOverflowPrint(
      [item('a', 2), item('streaming', 40, 0, false), item('notice', 2)], 20,
    );
    expect(afterWall.segments).toEqual([{ index: 0, id: 'a', fromRow: 0, toRow: 2 }]);
    expect(afterWall.segments.some((segment) => segment.id === 'notice')).toBe(false);
    expect(afterWall.hiddenRows).toBe(24);
  });

  it('handles the degenerate budgets without inventing rows', () => {
    expect(planOverflowPrint([], 24).segments).toEqual([]);
    // A zero-row box hides everything, so every stable row is printable.
    expect(planOverflowPrint([item('a', 3)], 0).segments)
      .toEqual([{ index: 0, id: 'a', fromRow: 0, toRow: 3 }]);
    // A one-row box hides all but the last row.
    expect(planOverflowPrint([item('a', 3)], 1).segments)
      .toEqual([{ index: 0, id: 'a', fromRow: 0, toRow: 2 }]);
    // An entry that renders as nothing contributes nothing.
    const empty = planOverflowPrint([item('a', 0), item('b', 4)], 2);
    expect(empty.totalRows).toBe(4);
    expect(empty.segments).toEqual([{ index: 1, id: 'b', fromRow: 0, toRow: 2 }]);
  });

  it('never asks for a negative or fractional row range', () => {
    for (const [rows, budget] of [[3, -5], [2.7, 1.2], [Number.NaN, 4]] as const) {
      for (const segment of planOverflowPrint([item('a', rows)], budget).segments) {
        expect(segment.fromRow).toBeGreaterThanOrEqual(0);
        expect(segment.toRow).toBeGreaterThan(segment.fromRow);
        expect(Number.isInteger(segment.toRow)).toBe(true);
      }
    }
  });
});

describe('capPrintedRows: the per-entry ceiling, split in two', () => {
  const cap = SCROLLBACK_LIMITS.maxRowsPerEntry;
  const rows = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `row ${index}`);

  it('returns the remainder untouched when it fits', () => {
    expect(capPrintedRows(rows(3), 0)).toEqual(rows(3));
  });

  it('keeps the FIRST rows and says how many were dropped, with no head printed yet', () => {
    const out = capPrintedRows(rows(cap + 100), 0);
    expect(out).toHaveLength(cap);
    expect(out[0]).toBe('row 0');
    expect(out[cap - 1]).toBe(elisionRow(101));
  });

  it('keeps the LAST rows when the head is already in the scrollback (A11)', () => {
    // The elision notice goes FIRST and the tail follows, because the tail is the part the
    // reader is looking at on screen: eliding it would delete the answer they just read.
    // One row of the cap is spent on the notice itself.
    const out = capPrintedRows(rows(cap + 100), 40);
    expect(out).toHaveLength(cap - 40);
    expect(out[0]).toBe(elisionRow(cap + 100 - (cap - 41)));
    expect(out[out.length - 1]).toBe(`row ${cap + 99}`);
  });
});

describe('reflowSeamRow: a width change is announced, never silent', () => {
  it('names both widths and the rows above it', () => {
    const seam = reflowSeamRow(37, 78, 98);
    expect(seam).toContain('reflowed');
    expect(seam).toContain('37');
    expect(seam).toContain('78');
    expect(seam).toContain('98');
    // The scrollback is written by ASCII-only code (glyphs.test.ts scans this tree).
    for (const char of seam) expect(char.charCodeAt(0)).toBeLessThan(128);
  });
});

describe('resolveTailAnchor: the measurement decides, the estimate stands in', () => {
  const entries: Entry[] = [notice('a'), notice('b')];

  it('falls back to the estimate when nothing is measured', () => {
    expect(resolveTailAnchor({ entries, budgetRows: 24, rowOf: () => 2, measuredRows: undefined }))
      .toBe('top');
    expect(resolveTailAnchor({ entries, budgetRows: 4, rowOf: () => 20, measuredRows: undefined }))
      .toBe('bottom');
  });

  it('uses the measured height even where the estimate disagrees', () => {
    // The estimate claims overflow (20 rows against a 6-row box) while the measurement says
    // the content fits: the block belongs at the TOP, with the unused rows below it.
    expect(tailAnchor(entries, 6, () => 20)).toBe('bottom');
    expect(resolveTailAnchor({ entries, budgetRows: 6, rowOf: () => 20, measuredRows: 4 }))
      .toBe('top');
    // ... and the other direction, which is the one that used to clip the newest rows.
    expect(tailAnchor(entries, 24, () => 2)).toBe('top');
    expect(resolveTailAnchor({ entries, budgetRows: 24, rowOf: () => 2, measuredRows: 25 }))
      .toBe('bottom');
  });

  it('is exactly "does it fit" at the boundary', () => {
    expect(resolveTailAnchor({ entries, budgetRows: 24, rowOf: () => 1, measuredRows: 24 }))
      .toBe('top');
    expect(resolveTailAnchor({ entries, budgetRows: 24, rowOf: () => 1, measuredRows: 25 }))
      .toBe('bottom');
  });
});
