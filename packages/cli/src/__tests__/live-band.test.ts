/**
 * `buildLiveBand` - the height/column allocator of the native panel band
 * (release-gate-and-native-panels AC-9..AC-14, AC-34; tui-full-height-live-region
 * AC-F3/F4).
 *
 * The band decides how many rows the TODO rail, the subagent roster and the tail get.
 * `bandRows <= remaining` is not a style preference: the live region plus the composer
 * must stay one row shorter than the terminal, or Ink writes `clearTerminal` (which
 * erases the user's scrollback).
 *
 * `fill` IS ALWAYS TRUE IN PRODUCTION AND ALWAYS TRUE HERE. In `fill` mode the band takes
 * the whole pool, which is what makes the region the screen; the two row caps that used
 * to clamp the tail (`previewCap` / `previewWanted`) are retired, so their axes are gone
 * from the matrices below rather than being tested at a value nothing can supply.
 *
 * A PURE FUNCTION IS THE REASON THESE CAN BE PROPERTIES rather than examples: no clock,
 * no terminal, no config, so the whole input space is enumerable here. The matrices are
 * complete over the axes that matter and each assertion states an invariant, not a
 * golden number.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLiveBand, type LiveBand, type LiveBandInput } from '../ui/scrollback/band.js';
import { todoRailWidth } from '../ui/layout/rail.js';
import { TODO_LIMITS } from '../todo/limits.js';

const BASE: LiveBandInput = {
  remaining: 20,
  contentCols: 100,
  railCols: 18,
  itemCount: 0,
  panelEnabled: true,
  overlayOpen: false,
  teamRowsNatural: 0,
  heldRailRows: 0,
  heldTeamRows: 0,
  fill: true,
};

function band(overrides: Partial<LiveBandInput> = {}): LiveBand {
  return buildLiveBand({ ...BASE, ...overrides });
}

/** A plan of 5 items with a rail narrow enough for every terminal in the matrix. */
const WITH_PLAN: Partial<LiveBandInput> = { itemCount: 5 };

describe('buildLiveBand - row invariant (AC-9)', () => {
  it('never allocates more rows than the region has, over the whole input space', () => {
    for (const remaining of [0, 1, 2, 3, 4, 5, 6, 8, 12, 20, 40, 80, 200]) {
      for (const teamRowsNatural of [0, 1, 2, 5, 10]) {
        for (const overlayOpen of [false, true]) {
          for (const itemCount of [0, 5]) {
            const result = band({
              remaining, teamRowsNatural, overlayOpen, itemCount,
            });
            expect(result.bandRows).toBeLessThanOrEqual(remaining);
            if (result.railRows > 0) expect(result.railRows).toBe(result.bandRows);
            if (overlayOpen) {
              // The overlay owns the pool; the band draws none of its own parts.
              expect(result.bandRows).toBe(remaining);
              expect(result.teamRows + result.previewRows).toBe(0);
            } else {
              // Otherwise the parts fill the band exactly (no leftover row, no overflow).
              expect(result.teamRows + result.previewRows).toBe(result.bandRows);
            }
          }
        }
      }
    }
  });

  it('the band is the top of the region, so the frame stays one row short (I-4)', () => {
    // The identity `liveRows = header + topRows + composer + status` is
    // `buildScrollbackBudget`'s; here we satisfy its premise: the band fits in `remaining`.
    const result = band({ remaining: 13, teamRowsNatural: 4, ...WITH_PLAN });
    expect(result.bandRows).toBe(13);
  });

  it('fill_owns_the_whole_pool (AC-F3): bandRows and the rail are the pool', () => {
    for (const remaining of [1, 2, 4, 6, 12, 24, 60]) {
      const result = band({ remaining, ...WITH_PLAN });
      expect(result.bandRows).toBe(remaining);
      // The rail spans every row above the composer, whatever the reason turns out to be.
      expect(result.railRows).toBe(result.reason === 'visible' ? remaining : 0);
    }
  });

  it('fill_rail_always_spans_the_band (AC-F3/F7)', () => {
    const wide = band({ remaining: 24, ...WITH_PLAN });
    expect(wide.reason).toBe('visible');
    expect(wide.railRows).toBe(24);
    expect(wide.previewRows).toBe(24);
  });

  it('the tail takes exactly what the roster leaves (AC-F4)', () => {
    for (const remaining of [6, 12, 20, 24]) {
      for (const teamRowsNatural of [0, 1, 3, 5, 10]) {
        const result = band({ remaining, teamRowsNatural, ...WITH_PLAN });
        expect(result.previewRows).toBe(result.bandRows - result.teamRows);
        expect(result.teamRows + result.previewRows).toBe(remaining);
      }
    }
  });

  it('retired_caps_are_not_inputs: nothing can shrink the tail below the pool', () => {
    // The two fields that used to clamp this (`previewCap` / `previewWanted`) are gone
    // from the type, so the tail column is the pool and an excess of content can only
    // scroll inside its box. A re-introduced cap would show up as the second assertion.
    expect(band({ remaining: 40, ...WITH_PLAN }).previewRows).toBe(40);
    expect(band({ remaining: 2, ...WITH_PLAN }).previewRows).toBeLessThan(40);
  });
});

describe('buildLiveBand - columns (AC-10)', () => {
  it('preview plus rail always equals the content width', () => {
    for (const contentCols of [10, 61, 75, 76, 80, 100, 120, 200]) {
      for (const itemCount of [0, 1, 5]) {
        for (const panelEnabled of [false, true]) {
          const railCols = todoRailWidth(contentCols);
          const result = band({ contentCols, railCols, itemCount, panelEnabled });
          expect(result.previewCols + result.railCols).toBe(contentCols);
        }
      }
    }
  });

  it('a visible rail is at least panelMinRows tall and as wide as todoRailWidth says', () => {
    const result = band({ contentCols: 120, railCols: todoRailWidth(120), ...WITH_PLAN });
    expect(result.reason).toBe('visible');
    expect(result.railRows).toBeGreaterThanOrEqual(TODO_LIMITS.panelMinRows);
    expect(result.railCols).toBe(todoRailWidth(120));
  });

  it('a hidden rail reports 0x0 and hands the whole width to the preview', () => {
    for (const overrides of [
      { panelEnabled: false },
      { itemCount: 0 },
      { contentCols: 75, railCols: todoRailWidth(75) },
      { remaining: 3 },
    ]) {
      const result = band({ ...WITH_PLAN, ...overrides });
      expect(result.railRows).toBe(0);
      expect(result.railCols).toBe(0);
      // The whole width, not "the rail's width kept conservatively": nothing is drawn in
      // that column, so the preview would otherwise lose 15 columns for free.
      expect(result.previewCols).toBe(overrides.contentCols ?? BASE.contentCols);
    }
  });
});

describe('buildLiveBand - reasons (AC-11)', () => {
  it('names all six reasons, and only visible seats the rail', () => {
    const reasons = {
      visible: band({ ...WITH_PLAN }),
      empty: band({ itemCount: 0 }),
      disabled: band({ panelEnabled: false, ...WITH_PLAN }),
      narrow: band({ contentCols: 75, railCols: todoRailWidth(75), ...WITH_PLAN }),
      short: band({ remaining: TODO_LIMITS.panelMinRows, ...WITH_PLAN }),
      overlay: band({ overlayOpen: true, ...WITH_PLAN }),
    } as const;
    for (const [reason, result] of Object.entries(reasons)) {
      expect(result.reason).toBe(reason);
      if (reason !== 'visible') expect(result.railRows).toBe(0);
    }
    expect(reasons.visible.railRows).toBeGreaterThan(0);
  });

  it('an overlay takes the whole pool: no roster, no preview, no rail', () => {
    const result = band({ overlayOpen: true, remaining: 30, teamRowsNatural: 5 });
    expect(result).toMatchObject({
      reason: 'overlay', bandRows: 30, teamRows: 0, previewRows: 0, railRows: 0, railCols: 0,
    });
    expect(result.previewCols).toBe(BASE.contentCols);
  });
});

describe('buildLiveBand - the roster leaves room for the rail (AC-12)', () => {
  it('never seats a roster that would starve the rail and the preview', () => {
    for (const remaining of [4, 5, 6, 7, 8, 12, 20]) {
      for (const teamRowsNatural of [1, 3, 5, 10]) {
        const result = band({ remaining, teamRowsNatural, ...WITH_PLAN });
        if (result.teamRows > 0) {
          expect(remaining - result.teamRows).toBeGreaterThanOrEqual(TODO_LIMITS.panelMinRows + 1);
        }
      }
    }
  });
});

describe('buildLiveBand - hysteresis (AC-13)', () => {
  it('is idempotent for identical input', () => {
    const input = { ...BASE, ...WITH_PLAN, teamRowsNatural: 3 };
    expect(buildLiveBand(input)).toEqual(buildLiveBand(input));
  });

  it('remembers the rows it used when the space shrinks, and follows it when it grows', () => {
    const wide = band({ ...WITH_PLAN, remaining: 30, teamRowsNatural: 3 });
    expect(wide.heldRailRows).toBeGreaterThan(0);
    const squeezed = band({
      ...WITH_PLAN, remaining: 6, teamRowsNatural: 3,
      heldRailRows: wide.heldRailRows, heldTeamRows: wide.heldTeamRows,
    });
    // The roster is seated at its natural height (IF-1: seeding it from the memory
    // would deadlock the very first frame), so what the input memory buys is the row
    // count the band reports back: it never shrinks below what a wider frame used.
    expect(squeezed.heldRailRows).toBeGreaterThanOrEqual(wide.heldRailRows);
    expect(squeezed.heldTeamRows).toBeGreaterThanOrEqual(wide.heldTeamRows);

    const restored = band({
      ...WITH_PLAN, remaining: 30, teamRowsNatural: 3,
      heldRailRows: wide.heldRailRows, heldTeamRows: wide.heldTeamRows,
    });
    expect(restored.railRows).toBe(restored.bandRows);
  });
});

describe('buildLiveBand - invalid geometry (AC-14)', () => {
  it('treats NaN, Infinity and negatives as zero instead of throwing', () => {
    const result = band({
      // `...WITH_PLAN` first: it carries an `itemCount` of its own, and spreading it last
      // would silently overwrite the deliberately invalid value this case feeds in.
      ...WITH_PLAN,
      remaining: Number.NaN,
      contentCols: Number.POSITIVE_INFINITY,
      railCols: -5,
      itemCount: Number.NEGATIVE_INFINITY,
      teamRowsNatural: Number.NaN,
      heldRailRows: -3,
      heldTeamRows: Number.NaN,
    });
    expect(result).toMatchObject({
      bandRows: 0, teamRows: 0, previewRows: 0, railRows: 0, railCols: 0, previewCols: 0,
    });
  });
});

describe('buildLiveBand - the roster layout never reads the band back (AC-34)', () => {
  it('sizes the roster from the viewport, not from the rail the band allocated', () => {
    // `availableRows = remaining - band.railRows` would close a loop: the band derives
    // `teamRows` from `layout.rowCount`, and `collapsed` is a threshold ON `availableRows`,
    // so the roster could flip between collapsed and expanded on alternating frames. The
    // edge is invisible to the type checker and obvious only in a wobbling frame, so the
    // wiring is asserted where it is written. (tui-full-height-live-region RV-P1-3: the
    // pool is `frameBudget.viewportRows`, which equals `remaining` by construction, so the
    // band never has to be read - this test must stay green WITHOUT being edited.)
    const source = readFileSync(new URL('../ui/App.tsx', import.meta.url), 'utf8');
    const call = /buildTeamPanelLayout\(\{([\s\S]*?)\}\)/.exec(source);
    expect(call).not.toBeNull();
    expect(call![1]).toContain('availableRows');
    expect(call![1]).not.toContain('railRows');
    expect(call![1]).not.toContain('band.');
  });
});
