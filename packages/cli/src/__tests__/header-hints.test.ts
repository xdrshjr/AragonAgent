/**
 * The header hint budget (tui-branch-terminal-shortcut 7.1 T-36..T-43, T-51).
 *
 * THE FOUR BOUNDARY CASES ARE THE POINT. A ladder is easy to write and easy to get
 * off by one cell, and an off-by-one here is invisible in review: the only thing it
 * loses is the last character of a hint. T-42 therefore asserts 51/52/61/62 exactly,
 * because those are the two thresholds `^I` moved to (D-11).
 */

import { describe, expect, it } from 'vitest';
import { HEADER_HINT_LIMITS, planHeaderHints } from '../ui/layout/header-hints.js';

const plan = (columns: number, extra: Partial<Parameters<typeof planHeaderHints>[0]> = {}) =>
  planHeaderHints({
    columns,
    statusExpanded: false,
    overlayOpen: false,
    scrolledLines: 0,
    ...extra,
  });

describe('T-36 / T-37: the full ladder at 120 columns', () => {
  it('names all three affordances in the order branch, index, detail', () => {
    const result = plan(120);
    expect(result.text).toBe('^L branch  ^I Index  ^G more');
    expect(result.clauses.map((clause) => clause.id)).toEqual(['branch', 'index', 'detail']);
  });

  it('spells the actions out when the status detail is expanded', () => {
    // `^K switch kit` JOINS THIS RUNG (agent-model-kits RV-P1-2): the expanded
    // ladder is the only place the kit key is taught, and it sits AFTER `^I`
    // so that every width below 79 columns keeps its pre-feature answer.
    expect(plan(120, { statusExpanded: true }).text)
      .toBe('^L new branch  ^I build index  ^K switch kit  ^G less');
  });
});

describe('T-39: a medium terminal drops ^I first', () => {
  it('keeps ^L and ^G at 50 columns and reports exactly 18 cells', () => {
    const result = plan(50);
    expect(result.text).toBe('^L branch  ^G more');
    expect(result.text).not.toContain('^I');
    expect(result.cells).toBe(18);
  });
});

describe('T-38: the widest chip still leaves room for the two survivors', () => {
  it('saturates the chip at ^9999+ and fits into the budget at 40 columns', () => {
    const result = plan(40, { scrolledLines: 10000 });
    expect(result.text).toBe('^9999+  ^G more');
    expect(result.text).not.toContain('^L');
    expect(result.text).not.toContain('^I');
    // 6 cells of chip (`^9999+`) + 2 of spacing + 7 of `^G more`. The spec's "16"
    // is the CEILING this case has to stay under, and the real number is 15.
    expect(result.cells).toBe(15);
    expect(result.cells).toBeLessThanOrEqual(16);
    expect(result.cells).toBeLessThanOrEqual(40 - HEADER_HINT_LIMITS.minLeftCells);
  });
});

describe('T-42 / D-11: the explicit ^I thresholds are 54 and 64', () => {
  // BOTH THRESHOLDS MOVED RIGHT BY TWO CELLS (defect 12). The header now spends
  // `HEADER_HINT_LIMITS.separatorCells` between its left half and this column, and
  // the planner's budget is `columns - minLeftCells - separatorCells`; the ladder
  // itself is unchanged, so the boundary is exactly two columns later than it was.
  it('adds ^I at exactly 54 columns when collapsed', () => {
    expect(plan(53).text).not.toContain('^I');
    expect(plan(54).text).toBe('^L branch  ^I Index  ^G more');
  });

  it('adds ^I at exactly 64 columns when expanded', () => {
    expect(plan(63, { statusExpanded: true }).text).not.toContain('^I');
    expect(plan(64, { statusExpanded: true })).toMatchObject({
      text: '^L new branch  ^I build index  ^G less',
    });
  });

  it('spends the separator out of the budget rather than out of the left half', () => {
    // The widest rung is 38 cells, so it needs `38 + minLeftCells + separatorCells`
    // columns. Forgetting the separator in that budget is exactly the two-cell
    // regression the thresholds above would hide.
    const widest = 38;
    const need = widest + HEADER_HINT_LIMITS.minLeftCells + HEADER_HINT_LIMITS.separatorCells;
    expect(plan(need - 1, { statusExpanded: true }).text).not.toContain('^I');
    expect(plan(need, { statusExpanded: true }).text).toContain('^I');
    expect(need).toBe(64);
  });
});

describe('T-43 / R-8: the scroll chip owns its own trailing spacing', () => {
  it('uses two spaces normally and ONE space while an overlay is open', () => {
    expect(plan(120, { scrolledLines: 12 }).text.startsWith('^12  ')).toBe(true);
    const overlay = plan(120, { scrolledLines: 12, overlayOpen: true }).text;
    expect(overlay.startsWith('^12 ')).toBe(true);
    // The single-space form is the one the old JSX had, and it is why the chip
    // cannot be "a fixed two spaces plus a separate gap" (R-8).
    expect(overlay.startsWith('^12  ')).toBe(false);
  });
});

describe('T-40: an overlay keeps only the detail word', () => {
  it('reports detailsOnly with no key hint at all', () => {
    const overlayOnly = plan(120, { overlayOpen: true });
    expect(overlayOnly.detailsOnly).toBe(true);
    expect(overlayOnly.text).toBe('Details off');
    expect(plan(120, { overlayOpen: true, statusExpanded: true }).text).toBe('Details on');
    expect(overlayOnly.text).not.toContain('^');
  });
});

describe('T-41: the right column never eats the left one', () => {
  it('holds cells <= columns - 24 for every width and state in [40, 200]', () => {
    for (let columns = 40; columns <= 200; columns += 1) {
      for (const statusExpanded of [false, true]) {
        for (const scrolledLines of [0, 7, 10000]) {
          const result = plan(columns, { statusExpanded, scrolledLines });
          expect(result.cells).toBeLessThanOrEqual(columns - HEADER_HINT_LIMITS.minLeftCells);
          // The planner never returns an EMPTY right column: `^G` is the only entry
          // in the table that may not be dropped.
          expect(result.text.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('T-51 / R-14: inputs are normalised, not trusted', () => {
  it('treats NaN, 0 and a negative width as 80 columns', () => {
    const reference = plan(80);
    for (const columns of [Number.NaN, 0, -5]) {
      expect(plan(columns)).toEqual(reference);
    }
  });

  it('treats a non-finite scrolled line count as no chip', () => {
    expect(plan(120, { scrolledLines: Number.NaN }).scrollCells).toBe(0);
    expect(plan(120, { scrolledLines: -3 }).scrollCells).toBe(0);
  });
});

describe('T-52 / AC-33: the kit rung is added LAST in the expanded ladder', () => {
  /**
   * THE WHOLE POINT OF THIS TABLE (agent-model-kits RV-P1-2). Six rungs, and the
   * only difference from the pre-feature ladder is that `^K` appears at >= 79
   * columns and swaps in for `^I` at 63-78. Every baseline answer - 64 columns,
   * 48 columns, the collapsed row at any width - is asserted to be UNCHANGED,
   * because that is what makes this an addition rather than a trade.
   */
  const expanded = (columns: number) => plan(columns, { statusExpanded: true });

  it('needs 79 columns for the full row, and reports exactly 53 cells', () => {
    expect(expanded(79).text).toBe('^L new branch  ^I build index  ^K switch kit  ^G less');
    expect(expanded(79).cells).toBe(53);
    expect(expanded(120).cells).toBe(53);
    expect(expanded(78).text).not.toContain('^K');
  });

  it('keeps ^I visible from 64 columns while ^K waits', () => {
    expect(expanded(78).text).toContain('^I build index');
    expect(expanded(64).text).toBe('^L new branch  ^I build index  ^G less');
    expect(expanded(64).cells).toBe(38);
  });

  it('offers ^K alone at 63 columns, where ^I no longer fits', () => {
    expect(expanded(63).text).toBe('^L new branch  ^K switch kit  ^G less');
    expect(expanded(63).cells).toBe(37);
    expect(expanded(63).text).not.toContain('^I');
  });

  it('leaves the three narrowest rungs exactly as they were', () => {
    expect(expanded(48).text).toBe('^L new branch  ^G less');
    expect(expanded(37).text).toBe('^L  ^G less');
    expect(expanded(20).text).toBe('^G less');
  });

  it('never teaches ^K before ctrl+G has been pressed', () => {
    for (const columns of [60, 72, 80, 120]) {
      expect(plan(columns).text).not.toContain('^K');
    }
  });

  it('degrades to the pre-feature expanded ladder when kitHint is false', () => {
    for (const columns of [37, 48, 63, 64, 78, 79, 120]) {
      const withoutKit = plan(columns, { statusExpanded: true, kitHint: false });
      expect(withoutKit.text).not.toContain('^K');
      expect(withoutKit.text).toBe(expanded(columns).text.replace('  ^K switch kit', ''));
    }
  });
});
