import { describe, expect, it } from 'vitest';
import { buildFrameBudget, clampDraftRows } from '../ui/layout/budget.js';

const budget = (rows = 24, cols = 80, draftRows = 1, popupRows = 0, statusExpanded = false) =>
  buildFrameBudget({ rows, cols, draftRows, popupRows, statusExpanded });
describe('fixed frame budget', () => {
  it('allocates one status row and a separate composer', () => {
    expect(budget()).toMatchObject({ frameRows: 23, viewportRows: 18, composerRows: 3,
      composerSlotRows: 3, statusRows: 1, composerCols: 79 });
    expect(budget(24, 80, 1, 0, true).viewportRows).toBe(17);
    expect(budget(12, 40, 3, 0, true).viewportRows).toBe(3);
  });
  it('conserves height across draft, popup, mode and size combinations', () => {
    for (const rows of [12, 19, 24, 50, 200]) for (const cols of [40, 48, 60, 80, 120, 200])
      for (const draft of [1, 3, 50, NaN]) for (const popup of [0, 1, 3, 9, 999])
        for (const expanded of [false, true]) {
          const b = budget(rows, cols, draft, popup, expanded);
          expect(b.headerRows + b.viewportRows + b.composerSlotRows + b.statusRows).toBe(rows - 1);
          expect(b.viewportRows).toBeGreaterThanOrEqual(1);
          expect(b.composerRows).toBe(2 + clampDraftRows(rows, draft));
          expect(b.popupRows === 0 || b.popupRows >= 3).toBe(true);
          expect(b.popupRows).toBeLessThanOrEqual(b.popupMaxHeight);
        }
  });
  it('normalizes invalid dimensions but never enlarges a real small terminal', () => {
    for (const value of [undefined, NaN, Infinity, 0, -1])
      expect(budget(value, value)).toMatchObject({ rows: 24, cols: 80, inactive: false });
    expect(budget(24.8, 80.8)).toMatchObject({ rows: 24, cols: 80 });
    for (const [rows, cols] of [[1, 80], [11, 80], [24, 39]]) {
      const b = budget(rows, cols);
      expect(b.inactive).toBe(true);
      expect(b.frameRows).toBe(rows - 1);
      for (const key of ['headerRows', 'composerRows', 'composerSlotRows', 'popupRows',
        'viewportRows', 'statusRows'] as const) expect(b[key]).toBe(0);
    }
  });
});
