/**
 * Height budget of the native-scroll LIVE REGION
 * (tui-native-terminal-scroll §4.6, tui-full-height-live-region D1/D3/D5).
 *
 * I-S1 · `liveRows <= max(0, rows - 1)` for every input. Ink writes
 * `clearTerminal` (which contains `ESC[3J`, erasing the user's scrollback) as soon
 * as a frame is as tall as the terminal. This feature takes I-S1's ONE row of margin
 * and nothing else: `liveRows === rows - 1` exactly, which is why the frame-height
 * guard (I-F13 / AC-F17) exists - there is no slack left to absorb a stray row.
 *
 * THE REGION IS THE SCREEN. The region used to be only as tall as the band asked for,
 * and every row it did not ask for became `gap` - blank rows ABOVE the content, which
 * is what the user reported as "the app starts halfway down the screen" and as "a big
 * blank between the result and the running card". The band now takes the whole pool
 * (`fill`), so the region is `[header][band][composer][status]` top to bottom and
 * `gap` cannot exist: `resolveCanvasLayout` is given `frameRows === capacity` and
 * derives `gap = 0` (see the spec's §5.5 proof, which is why the writer needs no
 * change at all).
 *
 * The composer, popup and status rows come from the SAME `buildFrameBudget` the
 * full-screen layout uses, so the two modes cannot disagree about how tall the
 * editor is. What differs is the top: the header is a real slot here (D3), and the
 * row it occupies is spent from the region, not from the printed transcript.
 *
 * THIS IS THE ONLY CALL SITE OF `buildLiveBand` (I-8). `remaining` is computed here
 * once and handed to the band; an `App` that computed its own copy would make
 * `liveRows <= rows - 1` depend on two numbers happening to agree instead of on the
 * construction that proves it.
 */

import { buildLiveBand, type LiveBand, type LiveBandInput } from './band.js';
import { buildFrameBudget, type FrameBudgetInput } from '../layout/budget.js';
import { todoRailWidth } from '../layout/rail.js';

/**
 * Everything the band needs that this module derives for itself: `remaining`,
 * `contentCols`, `railCols`, `overlayOpen` and `fill` are computed below - `fill` is
 * NOT part of the caller's input (I-8: the budget decides it, and "the band fills the
 * pool" is not a preference an `App` may hold). The caller supplies only the facts it
 * alone knows (plan, panel switch, roster size, hysteresis), never a number this
 * module is supposed to own.
 */
export type ScrollbackBandInput = Omit<
  LiveBandInput,
  'remaining' | 'contentCols' | 'railCols' | 'overlayOpen' | 'fill'
>;

export interface ScrollbackBudgetInput extends FrameBudgetInput {
  overlayOpen: boolean;
  /** The writer tripped its tall-frame guard: degrade to the placeholder until a resize. */
  forceInactive?: boolean;
  /**
   * REQUIRED, not optional (the same rule `TeamPanel`'s header records as D-13). An
   * optional band would mean "forgot to pass it" renders silently without panels -
   * exactly the defect this feature exists to remove - while a required field is a
   * compile error at the one place that forgets.
   */
  band: ScrollbackBandInput;
}

export interface ScrollbackBudget {
  rows: number;
  cols: number;
  /** Width everything is rendered and printed at (`cols - 1`, D5). */
  contentCols: number;
  /** Terminal below the 40x12 floor: the region is a one-row placeholder. */
  inactive: boolean;
  /**
   * The header slot, a real row inside the region (D3). 0 on a degraded frame: the
   * placeholder draws no header, and reporting 1 there would break the row identity
   * (I-F4) on exactly the frames `/perf` is read to explain.
   */
  headerRows: number;
  statusRows: 0 | 1 | 2;
  composerRows: number;
  composerSlotRows: number;
  composerCols: number;
  popupRows: number;
  popupMaxHeight: number;
  overlayRows: number;
  /** Tail rows: the band's left column below the roster (`= band.previewRows`). */
  liveTailRows: number;
  /** Rows above the composer: `= band.bandRows = remaining`. */
  topRows: number;
  /** Total live-region height: `rows - 1`, the whole screen above the parked row. */
  liveRows: number;
  /** Height and column allocation of the panel band; the single authority is `band.ts`. */
  band: LiveBand;
  /** Preview/tail width: `contentCols - railCols`. Printing keeps `contentCols`. */
  previewCols: number;
}

/**
 * The band of a frame that shows no content at all (below the 40x12 floor, or after
 * the writer's tall-frame guard tripped). It is a REAL value rather than `undefined`
 * because `/perf` and the render tests must be able to read the reason on exactly the
 * frames where something went wrong (I-14 / AC-23).
 */
function degradedBand(contentCols: number): LiveBand {
  return {
    reason: 'short', bandRows: 0, teamRows: 0, previewRows: 0,
    railRows: 0, railCols: 0, previewCols: contentCols, heldRailRows: 0, heldTeamRows: 0,
  };
}

export function buildScrollbackBudget(input: ScrollbackBudgetInput): ScrollbackBudget {
  const base = buildFrameBudget(input);
  const contentCols = Math.max(1, base.cols - 1);
  if (base.inactive || input.forceInactive === true) {
    return {
      rows: base.rows, cols: base.cols, contentCols, inactive: true, headerRows: 0,
      statusRows: 0, composerRows: 0, composerSlotRows: 0, composerCols: base.composerCols,
      popupRows: 0, popupMaxHeight: 0, overlayRows: 0, liveTailRows: 0, topRows: 0,
      liveRows: Math.max(0, Math.min(1, base.rows - 1)),
      band: degradedBand(contentCols), previewCols: contentCols,
    };
  }
  // D1 · H = C. `frameRows` is `rows - 1` by construction (`layout/budget.ts`), so the
  // region ends exactly on the row above the writer's parked cursor.
  const headerRows = 1;
  const liveRows = Math.max(1, base.frameRows);
  // The whole pool: everything between the header and the status line. Two independent
  // derivations put its floor at 1, so `max(0, ...)` is defensive only:
  //  1. `composerSlotRows = 2 + clampDraftRows(rows, draftRows)` and
  //     `draftMaxRows(rows) = max(1, min(6, floor(rows / 4)))`, so on the narrowest
  //     full-screen frame (`rows = 12`) `remaining >= 11 - 1 - 5 - 1 = 4`;
  //  2. with the completion menu at its maximum, `popupMaxHeight` already subtracts
  //     this same pair of rows, so `remaining = popupMaxHeight + 1 - popupRows >= 1`.
  const remaining = Math.max(
    0, liveRows - headerRows - base.composerSlotRows - base.statusRows,
  );
  const band = buildLiveBand({
    ...input.band,
    remaining,
    contentCols,
    railCols: todoRailWidth(contentCols),
    // The band fills the pool: no row of the region is left blank, which is the whole
    // point of the feature (D5). Taken from HERE, never from `input.band`.
    fill: true,
    // Taken from THIS input, never from `input.band`: an overlay that the frame knows
    // about but the band did not would draw no overlay at all, and the shell keys the
    // overlay's rows off the band.
    overlayOpen: input.overlayOpen,
  });
  const overlayRows = band.reason === 'overlay' ? band.bandRows : 0;
  const liveTailRows = band.previewRows;
  const topRows = band.bandRows;
  return {
    rows: base.rows, cols: base.cols, contentCols, inactive: false, headerRows,
    statusRows: base.statusRows, composerRows: base.composerRows,
    composerSlotRows: base.composerSlotRows, composerCols: base.composerCols,
    popupRows: base.popupRows, popupMaxHeight: base.popupMaxHeight, overlayRows,
    liveTailRows, topRows, liveRows,
    band, previewCols: band.previewCols,
  };
}
