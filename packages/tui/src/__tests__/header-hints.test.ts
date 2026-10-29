/**
 * The header's right-hand column (tui-shortcut-drawer-and-task-summary §4.2).
 *
 * THIS FILE REPLACES A 24-CASE LADDER SUITE. The ladder is gone (D-1), so the cases
 * that asserted rung-by-rung clause sets are deleted BY DESIGN and not by accident;
 * the one property worth keeping from the old table - `T-41`, "the two halves always
 * add up to the terminal width" - is PROMOTED rather than dropped, and now lives in
 * `header-left.test.ts` as AC-2b because it spans both planners.
 *
 * What remains is what the requirement can be checked against: three states, the
 * chip, the threshold formula, and the input normalisation the old suite had.
 */

import { describe, expect, it } from 'vitest';
import {
  HEADER_HINTS,
  HEADER_HINT_LIMITS,
  headerHintFits,
  headerHintThreshold,
  planHeaderHints,
  type HeaderPanelState,
} from '../ui/layout/header-hints.js';

const STATES: HeaderPanelState[] = ['none', 'shortcuts', 'other'];
const WIDTHS = [20, 32, 34, 35, 40, 48, 60, 80, 120, 200];

/** The plan for one width, with the chip off unless a test asks for it. */
const plan = (columns: number, panel: HeaderPanelState = 'none', scrolledLines = 0) =>
  planHeaderHints({ columns, panel, scrolledLines });

describe('planHeaderHints (AC-1 / AC-2)', () => {
  it('renders exactly one clause in every state, at every width', () => {
    for (const columns of WIDTHS) {
      expect(plan(columns, 'none').text).toBe('^G more');
      expect(plan(columns, 'shortcuts').text).toBe('^G close');
      expect(plan(columns, 'other').text).toBe('Esc close');
    }
  });

  it('never mentions the retired ladder keys anywhere', () => {
    for (const columns of WIDTHS) {
      for (const panel of STATES) {
        const { text } = plan(columns, panel);
        // `^L`, `^I`, `^K` and `^P` are the removed clauses. `^G` is the survivor.
        for (const retired of ['^L', '^I', '^K', '^P']) {
          expect(text.includes(retired), `${columns}/${panel}`).toBe(false);
        }
      }
    }
  });

  it('reports the cell width the renderer uses', () => {
    for (const panel of STATES) {
      const result = plan(80, panel);
      expect(result.cells).toBe(HEADER_HINTS[panel].length);
      expect(result.scrollCells).toBe(0);
    }
  });
});

describe('the scroll chip', () => {
  it('prefixes the clause and carries its own spacing', () => {
    // Two spaces before the body with no overlay, one while an overlay is open -
    // the chip owns that spacing so a reader never has to look in `Header` for it.
    expect(plan(80, 'none', 7).text).toBe('^7  ^G more');
    expect(plan(80, 'other', 7).text).toBe('^7 Esc close');
    expect(plan(80, 'none', 7).scrollCells).toBe('^7  '.length);
  });

  it('saturates at 9999 and stays put', () => {
    expect(plan(120, 'none', 12_345).text).toBe('^9999+  ^G more');
  });

  it('is absent at zero', () => {
    expect(plan(120, 'none', 0).scrollCells).toBe(0);
  });
});

describe('fits() thresholds', () => {
  it('is a formula, not a magic number (v2 replaced "any width >= 35")', () => {
    for (const panel of STATES) {
      const threshold = headerHintThreshold(panel);
      expect(threshold).toBe(
        HEADER_HINTS[panel].length
          + HEADER_HINT_LIMITS.minLeftCells
          + HEADER_HINT_LIMITS.separatorCells,
      );
      expect(headerHintFits(threshold, panel)).toBe(true);
      expect(headerHintFits(threshold - 1, panel)).toBe(false);
    }
    // The three documented answers, measured on the REAL strings: `G more` is 7
    // cells (v2's table said 6), so the widths are 33 / 34 / 35.
    expect(headerHintThreshold('none')).toBe(33);
    expect(headerHintThreshold('shortcuts')).toBe(34);
    expect(headerHintThreshold('other')).toBe(35);
  });
});

describe('input normalisation (kept from the old suite)', () => {
  it('falls back to 80 for a nonsense width and never goes below zero on the chip', () => {
    expect(planHeaderHints({ columns: Number.NaN, panel: 'none', scrolledLines: 0 }).text)
      .toBe('^G more');
    expect(planHeaderHints({ columns: 0, panel: 'none', scrolledLines: 0 }).text)
      .toBe('^G more');
    expect(planHeaderHints({ columns: 80, panel: 'none', scrolledLines: -4 }).scrollCells).toBe(0);
  });

  it('floors a fractional width and a fractional offset', () => {
    expect(planHeaderHints({ columns: 80.9, panel: 'none', scrolledLines: 2.7 }).text)
      .toBe('^2  ^G more');
  });
});
