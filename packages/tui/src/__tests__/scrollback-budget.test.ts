import { describe, expect, it } from 'vitest';
import {
  buildScrollbackBudget,
  type ScrollbackBandInput,
  type ScrollbackBudget,
} from '../ui/scrollback/budget.js';

/**
 * The region IS the screen (tui-full-height-live-region AC-F1..AC-F4).
 *
 * The old file asserted the opposite identity - "an idle region is just the editor and
 * the status line" - because the region used to be sized to what the band asked for and
 * the leftover rows became the canvas `gap`. That gap was the reported defect, so the
 * assertion is inverted rather than deleted: `topRows` is now the whole pool.
 *
 * `band` is REQUIRED on purpose (RV-P1-6): a forgotten band is a compile error, not a
 * silently panel-free frame.
 */
const NO_BAND: ScrollbackBandInput = {
  itemCount: 0,
  panelEnabled: true,
  teamRowsNatural: 0,
  heldRailRows: 0,
  heldTeamRows: 0,
};

function budget(overrides: Partial<Parameters<typeof buildScrollbackBudget>[0]> = {}):
ScrollbackBudget {
  return buildScrollbackBudget({
    rows: 30, cols: 100, draftRows: 1, popupRows: 0, statusExpanded: false,
    overlayOpen: false, band: NO_BAND, ...overrides,
  });
}

describe('buildScrollbackBudget', () => {
  it('I-S1: liveRows never reaches the terminal height, for every size and input (AC-F2)', () => {
    for (const rows of [1, 2, 5, 11, 12, 13, 20, 24, 40, 60, 100, 200]) {
      for (const cols of [1, 20, 39, 40, 41, 80, 120, 200]) {
        for (const draftRows of [1, 3, 8, 50]) {
          for (const popupRows of [0, 3, 10, 40]) {
            for (const statusExpanded of [false, true]) {
              for (const overlayOpen of [false, true]) {
                for (const forceInactive of [false, true]) {
                  const result = budget({
                    rows, cols, draftRows, popupRows, statusExpanded, overlayOpen, forceInactive,
                  });
                  expect(result.liveRows).toBeLessThanOrEqual(Math.max(0, rows - 1));
                  expect(result.liveRows).toBeGreaterThanOrEqual(0);
                  expect(result.contentCols).toBe(Math.max(1, cols - 1));
                  if (!result.inactive) {
                    // I-S1 taken to EQUALITY: the region uses the one row of margin Ink
                    // leaves between a whole frame and `clearTerminal` (D1).
                    expect(result.liveRows).toBe(rows - 1);
                  }
                }
              }
            }
          }
        }
      }
    }
  });

  it('region_is_the_whole_canvas (AC-F1)', () => {
    const result = budget({ rows: 30 });
    expect(result.inactive).toBe(false);
    expect(result.liveRows).toBe(29);
    expect(result.headerRows).toBe(1);
    // R=30, draftRows=1: the pool is 24 - the number the TODO rail has to span.
    expect(result.topRows).toBe(24);
    expect(result.liveRows).toBe(result.headerRows + result.topRows
      + result.composerSlotRows + result.statusRows);
  });

  it('rows_are_conserved over the whole input space (AC-F1 / I-F4)', () => {
    for (const rows of [12, 13, 20, 24, 30, 40, 60]) {
      for (const draftRows of [1, 2, 4, 8]) {
        for (const popupRows of [0, 3, 12, 30]) {
          for (const statusExpanded of [false, true]) {
            for (const overlayOpen of [false, true]) {
              const result = budget({ rows, draftRows, popupRows, statusExpanded, overlayOpen });
              expect(
                result.headerRows + result.topRows + result.composerSlotRows + result.statusRows,
              ).toBe(result.liveRows);
            }
          }
        }
      }
    }
  });

  it('band_owns_the_pool (AC-F3)', () => {
    // The inversion of the old `an idle region is just the editor and the status line`:
    // with no plan and no roster the band still owns every row above the composer.
    const idle = budget();
    expect(idle.topRows).toBe(idle.liveRows - 1 - idle.composerSlotRows - idle.statusRows);
    expect(idle.band.bandRows).toBe(idle.topRows);
    expect(idle.band.previewRows).toBe(idle.topRows);

    const withPlan = budget({
      band: { ...NO_BAND, itemCount: 5, teamRowsNatural: 3 },
    });
    expect(withPlan.band.bandRows).toBe(withPlan.topRows);
    // The rail spans the ROW REGION, which is the pool minus the full-width roster
    // (tui-subagent-panel §4.1.2 / D-3): the two slots no longer overlap, so the rail is
    // shorter by exactly `teamRows` and never by more (I-6).
    expect(withPlan.band.railRows).toBe(withPlan.topRows - withPlan.band.teamRows);
    expect(withPlan.band.previewRows).toBe(withPlan.topRows - withPlan.band.teamRows);
  });

  it('retired_preview_caps_are_gone (AC-F4)', () => {
    // No input asks for a preview height any more, and no output reports one: the tail
    // column is `band.previewRows`, decided by the pool. A `previewWanted` field coming
    // back would mean someone re-introduced the second authority D9 retired.
    const result = budget({ rows: 100, cols: 200 });
    expect(result).not.toHaveProperty('previewWanted');
    expect(result.liveTailRows).toBe(result.band.previewRows);
    expect(result.previewCols + result.band.railCols).toBe(result.contentCols);
    // A taller terminal carries a taller tail column, with no cap in between.
    expect(budget({ rows: 100 }).liveTailRows).toBeGreaterThan(budget({ rows: 30 }).liveTailRows);
  });

  it('below 40x12 the region is a single placeholder row, with no header slot (RV-P2-4)', () => {
    const base = { cols: 80, draftRows: 1, popupRows: 0, statusExpanded: false,
      overlayOpen: false, band: NO_BAND };
    expect(buildScrollbackBudget({ ...base, rows: 11 })).toMatchObject({
      inactive: true, liveRows: 1, headerRows: 0,
    });
    expect(buildScrollbackBudget({ ...base, rows: 1 })).toMatchObject({
      inactive: true, liveRows: 0, headerRows: 0,
    });
    expect(buildScrollbackBudget({ ...base, rows: 30, cols: 39 })).toMatchObject({
      inactive: true, liveRows: 1, headerRows: 0,
    });
  });

  it('degraded_frame_reports_no_header', () => {
    // The writer's tall-frame guard degrades to the one-row placeholder. Reporting the
    // header row there would break I-F4 on exactly the frame `/perf` is read to explain.
    const result = budget({ forceInactive: true });
    expect(result.inactive).toBe(true);
    expect(result.headerRows).toBe(0);
    expect(result.liveRows).toBeLessThanOrEqual(1);
    expect(result.band.bandRows).toBe(0);
  });

  it('an open overlay takes the whole top pool and suppresses the tail', () => {
    const result = budget({ overlayOpen: true });
    expect(result.liveTailRows).toBe(0);
    expect(result.overlayRows).toBe(result.topRows);
    expect(result.liveRows).toBe(result.rows - 1);
    expect(result.headerRows + result.overlayRows + result.composerSlotRows + result.statusRows)
      .toBe(result.liveRows);
  });

  it('the composer and status rows match the full-screen budget', async () => {
    const { buildFrameBudget } = await import('../ui/layout/budget.js');
    const input = { rows: 30, cols: 100, draftRows: 4, popupRows: 5, statusExpanded: true };
    const full = buildFrameBudget(input);
    const native = budget(input);
    expect(native.composerSlotRows).toBe(full.composerSlotRows);
    expect(native.statusRows).toBe(full.statusRows);
    expect(native.popupMaxHeight).toBe(full.popupMaxHeight);
  });
});
