import { describe, expect, it } from 'vitest';
import { chromeBudget, viewportRows, HINT_MIN_ROWS } from '../ui/layout/budget.js';
import { frameHeight, MIN_FULLSCREEN_ROWS } from '../ui/layout/frame.js';
import { DRAFT_MAX_ROWS_HINT_TIER, draftMaxRows } from '../ui/composer-limits.js';

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
    expect(viewportRows(28)).toBe(24);
    expect(viewportRows(27)).toBe(23);
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
    // Unified document: header, activity and status are the only fixed rows.
    expect(viewportRows(24)).toBe(20);
    expect(viewportRows(30)).toBe(26);
    expect(viewportRows(19)).toBe(15);
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
    expect(viewportRows(HINT_MIN_ROWS)).toBe(viewportRows(HINT_MIN_ROWS - 1) + 1);
  });
});

/**
 * AC-8a / DoD #8 — this round did NOT touch the frame's row accounting.
 *
 * The activity line shares the already-budgeted toast row rather than adding a
 * slot (D-17), because a conditional bottom-chrome row inside a
 * `height={frameHeight(rows)}` frame does not grow the frame — it shrinks the
 * only `flexShrink={1}` child, the transcript — while this function keeps
 * returning the old number to five consumers. That failure reports nothing, so
 * the assertion lives here rather than in a manual step.
 */
describe('the activity line did not cost the viewport a row (AC-8a / R-11)', () => {
  it('still enumerates exactly header + toast + composer + status', () => {
    const budget = chromeBudget(24);
    expect(Object.keys(budget).sort()).toEqual(['composer', 'header', 'status', 'toast']);
    expect(budget.toast).toBe(1);
  });

  it('reports the same rows it did before the feature, at every height', () => {
    // Spec 5.1 again, restated as a regression baseline: if a future round adds
    // the bottom-chrome row this one declined to add, these numbers move.
    expect(viewportRows(24)).toBe(20);
    expect(viewportRows(30)).toBe(26);
    expect(viewportRows(19)).toBe(15);
    expect(viewportRows(27)).toBe(23);
    expect(viewportRows(28)).toBe(24);
  });
});

/**
 * `draftRows` (tui-paste-handling D-12 / T-14 / T-15).
 *
 * The composer used to be a CONSTANT three or four rows in this arithmetic while
 * Yoga silently took as many rows as the draft actually occupied. The parameter
 * closes that gap; the assertions below are what keep it from opening a new one.
 */
describe('viewportRows — the draftRows parameter (D-12)', () => {
  it('T-14: the one-argument form is identical to `draftRows = 1`, at every height', () => {
    // THE IDENTITY THAT KEEPS EVERY ASSERTION ABOVE HONEST. If it ever fails,
    // every number in this file is measuring something else.
    for (let rows = 1; rows <= 200; rows += 1) {
      expect(viewportRows(rows), `rows=${rows}`).toBe(viewportRows(rows, 1));
      expect(chromeBudget(rows).composer, `rows=${rows}`).toBe(chromeBudget(rows, 1).composer);
    }
  });

  it('keeps `viewportRows.length` at 1, so the A-4 arity check still means something', () => {
    // A parameter WITH A DEFAULT does not count toward `Function.length`, which
    // is why the pre-existing "takes no `empty` argument" case still passes.
    expect(viewportRows.length).toBe(1);
    expect(chromeBudget.length).toBe(1);
  });

  it('T-15: is non-increasing in `draftRows`', () => {
    for (const rows of [12, 19, 20, 24, 30, 60]) {
      let prev = Number.POSITIVE_INFINITY;
      for (let draft = 1; draft <= 20; draft += 1) {
        const v = viewportRows(rows, draft);
        expect(v, `rows=${rows} draft=${draft}`).toBeLessThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it('T-15: the composer term never exceeds 2 + draftMaxRows(rows) + 1', () => {
    for (const rows of [12, 19, 20, 24, 29, 30, 60, 200]) {
      const ceiling = 2 + draftMaxRows(rows) + (rows >= HINT_MIN_ROWS ? 1 : 0);
      for (const draft of [1, 3, 7, 40, 5000, Number.NaN]) {
        expect(chromeBudget(rows, draft).composer, `rows=${rows} draft=${draft}`).toBeLessThanOrEqual(
          ceiling,
        );
      }
    }
  });

  it('keeps the viewport budget independent of draft rows', () => {
    // R-12's first rule: past the ceiling the transcript stops moving, which is
    // what makes a 218-line draft and a 400-line draft look the same.
    expect(viewportRows(30, 1) - viewportRows(30, 2)).toBe(0);
    expect(viewportRows(30, 10)).toBe(viewportRows(30, 11));
    expect(viewportRows(30, 10)).toBe(viewportRows(30, 5000));
  });

  it('never returns a negative height, however tall the draft claims to be', () => {
    for (let rows = 12; rows <= 40; rows += 1) {
      expect(viewportRows(rows, 5000), `rows=${rows}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('draftMaxRows (section 5.5)', () => {
  it('is non-decreasing in terminal height', () => {
    let prev = 0;
    for (let rows = 1; rows <= 200; rows += 1) {
      const v = draftMaxRows(rows);
      expect(v, `rows=${rows}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('steps at exactly HINT_MIN_ROWS — the duplicated constant, pinned', () => {
    // `composer-limits.ts` deliberately holds its own copy of this number rather
    // than importing it, because `budget.ts` calls `draftMaxRows` and the import
    // would close an ESM cycle. This assertion is what stops the two drifting.
    expect(DRAFT_MAX_ROWS_HINT_TIER).toBe(HINT_MIN_ROWS);
    expect(draftMaxRows(HINT_MIN_ROWS - 1)).toBe(3);
    expect(draftMaxRows(HINT_MIN_ROWS)).toBe(6);
    expect(draftMaxRows(30)).toBe(10);
  });
});
