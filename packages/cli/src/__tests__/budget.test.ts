import { describe, expect, it } from 'vitest';
import { chromeBudget, viewportRows, HINT_MIN_ROWS } from '../ui/layout/budget.js';
import { frameHeight, MIN_FULLSCREEN_ROWS } from '../ui/layout/frame.js';

/**
 * These are PURE-FUNCTION assertions on purpose (R-P1-1).
 *
 * The obvious alternative — mount the app at many terminal heights and measure
 * the frames — cannot work here: `ink-testing-library`'s stdout stub exposes
 * `columns` and no `rows`, so `useTerminalSize` reports the 24-row fallback
 * forever and a loop over `rows` would silently assert the same case 189 times.
 */
describe('viewportRows (A-3 / A-4)', () => {
  it('is non-decreasing across the whole usable range', () => {
    // The regression this exists to prevent: at rows=27 the header was a 2-row
    // banner and the viewport was 18; at rows=28 the 8-row wordmark tier kicked
    // in and the viewport DROPPED to 13. Making the terminal taller made the
    // visible content shorter.
    let prev = -1;
    for (let rows = 12; rows <= 200; rows += 1) {
      const v = viewportRows(rows);
      expect(v, `rows=${rows}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('specifically does not regress at the old 27 -> 28 cliff', () => {
    expect(viewportRows(28)).toBeGreaterThanOrEqual(viewportRows(27));
    expect(viewportRows(28)).toBe(20);
    expect(viewportRows(27)).toBe(19);
  });

  it('takes no `empty` argument, so the first submit cannot change it (A-4)', () => {
    // Encoded as an arity check plus determinism: there is no session-state
    // input the layout could react to, which is exactly the property that makes
    // the header stop jumping by 7 rows on the first message.
    expect(viewportRows.length).toBe(1);
    for (const rows of [12, 18, 24, 27, 28, 30, 40, 200]) {
      const first = viewportRows(rows);
      for (let i = 0; i < 5; i += 1) expect(viewportRows(rows)).toBe(first);
    }
  });

  it('returns 0 below the full-screen floor rather than a negative height', () => {
    for (let rows = -5; rows < MIN_FULLSCREEN_ROWS; rows += 1) {
      expect(viewportRows(rows), `rows=${rows}`).toBe(0);
    }
    expect(viewportRows(Number.NaN)).toBe(0);
  });

  it('never claims more rows than the frame it lives in (I-1 stays true)', () => {
    for (let rows = 12; rows <= 200; rows += 1) {
      expect(viewportRows(rows)).toBeLessThan(frameHeight(rows));
    }
  });

  it('matches the published layout budget exactly', () => {
    // Spec 5.1: rows-8 with the hint row, rows-7 without.
    expect(viewportRows(24)).toBe(16);
    expect(viewportRows(30)).toBe(22);
    expect(viewportRows(19)).toBe(12);
  });
});

describe('chromeBudget', () => {
  it('keeps the header at exactly one row at every size', () => {
    for (const rows of [12, 19, 20, 24, 28, 200]) {
      expect(chromeBudget(rows).header, `rows=${rows}`).toBe(1);
    }
  });

  it('adds the composer hint row only from HINT_MIN_ROWS up', () => {
    expect(chromeBudget(HINT_MIN_ROWS - 1).composer).toBe(3);
    expect(chromeBudget(HINT_MIN_ROWS).composer).toBe(4);
  });

  it('spends the extra hint row out of the row the terminal just gained', () => {
    // This is why the hint step does not create a dip in `viewportRows`.
    expect(viewportRows(HINT_MIN_ROWS)).toBe(viewportRows(HINT_MIN_ROWS - 1));
  });
});
