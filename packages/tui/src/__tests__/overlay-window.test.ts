import { describe, expect, it } from 'vitest';
import { overlayListLimit, sliceWindow } from '../ui/layout/overlay-window.js';

describe('sliceWindow (A-2)', () => {
  it('always produces an in-bounds window, for any offset', () => {
    // `/help` is 29 rows; a 30-row terminal gives the overlay 15. Every offset a
    // user could reach with PgUp/PgDn -- and every offset a bug could hand it --
    // must still yield a slice that exists.
    for (let offset = -5; offset <= 40; offset += 1) {
      const w = sliceWindow(29, offset, 15);
      expect(w.start, `offset=${offset}`).toBeGreaterThanOrEqual(0);
      expect(w.start + w.visible, `offset=${offset}`).toBeLessThanOrEqual(29);
      expect(w.visible).toBe(15);
    }
  });

  it('clamps past-the-end offsets to the last full page', () => {
    expect(sliceWindow(29, 100, 15).clamped).toBe(14);
    expect(sliceWindow(29, 100, 15).start).toBe(14);
    expect(sliceWindow(29, -100, 15).clamped).toBe(0);
  });

  it('shows everything and refuses to scroll when it already fits', () => {
    const w = sliceWindow(6, 3, 20);
    expect(w.visible).toBe(6);
    expect(w.start).toBe(0);
    expect(w.clamped).toBe(0);
  });

  it('handles the degenerate inputs without producing NaN', () => {
    for (const [total, offset, height] of [
      [0, 0, 10],
      [0, 5, 0],
      [10, 0, 0],
      [Number.NaN, 0, 5],
      [10, Number.NaN, 5],
      [10, 0, Number.NaN],
      [-3, -3, -3],
    ] as const) {
      const w = sliceWindow(total, offset, height);
      for (const v of [w.start, w.visible, w.total, w.clamped]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
      expect(w.start + w.visible).toBeLessThanOrEqual(w.total);
    }
  });
});

describe('overlayListLimit (A-11)', () => {
  it('never returns less than 3, even at absurd heights', () => {
    for (let maxRows = 0; maxRows <= 200; maxRows += 1) {
      const n = overlayListLimit(maxRows);
      expect(Number.isFinite(n), `maxRows=${maxRows}`).toBe(true);
      expect(n, `maxRows=${maxRows}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('leaves room for the frame chrome once the height allows it', () => {
    // Title + footer + two borders + the frame's own margin row = 5 rows the
    // list cannot have. Counting only the four visible ones renders the picker
    // one row past the viewport, where `overflow: hidden` takes the border.
    for (let maxRows = 8; maxRows <= 24; maxRows += 1) {
      expect(overlayListLimit(maxRows), `maxRows=${maxRows}`).toBeLessThanOrEqual(maxRows - 5);
    }
  });

  it('caps out rather than growing without bound', () => {
    expect(overlayListLimit(1000)).toBe(20);
    expect(overlayListLimit(Number.POSITIVE_INFINITY)).toBe(20);
  });

  it('is monotonic in the height it is given', () => {
    let prev = -1;
    for (let maxRows = 0; maxRows <= 200; maxRows += 1) {
      const n = overlayListLimit(maxRows);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});


// Every focused overlay uses the same reduced chrome allowance at V=3.
describe('short overlay body budget', () => {
  it('keeps one traversable body row between title and actions', async () => {
    const { overlayBodyRows } = await import('../ui/layout/OverlayFrame.js');
    for (const cols of [40, 80, 120]) {
      expect(overlayBodyRows(3, cols)).toBe(1);
      expect(overlayBodyRows(4, cols)).toBeGreaterThanOrEqual(1);
    }
  });
});

// DEFECT 11. A PgUp/PgDn - and a Shift+wheel notch - inside a controlled overlay
// moved a constant eight rows. `/help` on a 100x24 terminal shows 19 rows, so that
// was 42% of a page with eleven rows of overlap on every turn. The step is now the
// overlay's own window minus the two context rows the transcript's page keeps.
describe('overlay page size', () => {
  it('turns one window minus two rows of context', async () => {
    const { overlayBodyRows, overlayPageSize } = await import('../ui/layout/OverlayFrame.js');
    for (const [maxRows, cols] of [[24, 100], [30, 100], [40, 80], [12, 60]] as const) {
      const body = overlayBodyRows(maxRows, cols);
      expect(overlayPageSize(maxRows, cols)).toBe(Math.max(1, body - 2));
    }
  });

  it('never returns zero, even for a body too short to overlap', async () => {
    const { overlayPageSize } = await import('../ui/layout/OverlayFrame.js');
    expect(overlayPageSize(6, 100)).toBe(1);
  });

  it('is larger than the old constant on a normal terminal', async () => {
    const { overlayPageSize } = await import('../ui/layout/OverlayFrame.js');
    // 21 usable overlay rows on 100x24 => a 16-row body => a 14-row page.
    expect(overlayPageSize(21, 100)).toBe(14);
  });
});
