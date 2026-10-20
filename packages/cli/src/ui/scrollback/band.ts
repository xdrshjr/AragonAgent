/**
 * Height and column budget of the native-scroll PANEL BAND
 * (release-gate-and-native-panels §6.2, tui-full-height-live-region D5).
 *
 * Native scroll mode drops the fixed frame, so it used to drop the panels with it:
 * the TODO rail lived in `AppShell`'s middle band and the subagent roster in the
 * viewport footer, and neither is rendered once `ScrollbackShell` takes over. The
 * band is the replacement - one row pool shared by the roster (`TeamPanel`), the tail
 * and the rail (`TodoPanel`), sitting directly above the composer.
 *
 * `fill` IS THE FEATURE (D5). In `fill` mode the band takes the WHOLE pool:
 * `bandRows = remaining`, `railRows = bandRows` (so the rail spans every row the user
 * can see) and `previewRows = bandRows - teamRows` (so the tail column ends against
 * the composer). Before `fill`, the band asked for "just enough" rows and every row it
 * did not ask for became the canvas `gap` - the blank band between the result and the
 * running card that this feature removes.
 *
 * PURE: no Ink, no clock, no terminal, no config read. Every invariant below is
 * therefore established BY CONSTRUCTION for all input combinations and can be
 * enumerated by a property test (AC-9..AC-14, AC-34, AC-F3/F4):
 *
 *  - `bandRows <= remaining` and therefore `liveRows <= rows - 1` (I-4). Ink writes
 *    `clearTerminal` - which contains `ESC[3J`, erasing the user's scrollback - as
 *    soon as a frame is as tall as the terminal.
 *  - `previewCols + railCols === contentCols`, always (AC-10). The rail is a column
 *    INSIDE the region, so the preview loses exactly the columns the rail takes and
 *    nothing else (I-5: printing keeps the full `contentCols`).
 *  - `teamRows > 0` leaves room for the rail plus one preview row (AC-12).
 *  - `fill` mode: `bandRows === remaining`, `railRows === bandRows` when the rail is
 *    visible, and `teamRows + previewRows === bandRows`.
 *
 * THERE IS EXACTLY ONE CALL SITE: `buildScrollbackBudget` (I-8). This module is
 * exported so it can be tested, not so a second caller can allocate rows of its own
 * - `remaining` is computed there, and a second copy of it is a second authority.
 */

import { TODO_LIMITS } from '../../todo/limits.js';
import { SCROLLBACK_LIMITS } from './limits.js';

export type BandReason =
  /** Both panels are on screen. */
  | 'visible'
  /** No active plan: no rail. Same name and meaning as `TodoRailLayout`'s `'empty'`. */
  | 'empty'
  /** `cfg.todo.panel === false`. */
  | 'disabled'
  /** An overlay is open: the band yields to it. */
  | 'overlay'
  /** `todoRailWidth(contentCols) === 0` (terminal narrower than 76 columns). */
  | 'narrow'
  /** The remaining rows cannot hold `panelMinRows` for the rail. */
  | 'short';

export interface LiveBandInput {
  /**
   * `buildFrameBudget().viewportRows`: every row the band may use (the pool). Computed
   * once by `buildScrollbackBudget`; callers must not re-derive it.
   */
  remaining: number;
  /** `cols - 1`: width of the whole band. `previewCols` is derived from it. */
  contentCols: number;
  /** `todoRailWidth(contentCols)`; `layout/rail.ts` stays the width authority. */
  railCols: number;
  /** `state.todos.items.length` (0 = no active plan). */
  itemCount: number;
  /** `cfg.todo.panel`. */
  panelEnabled: boolean;
  overlayOpen: boolean;
  /** `buildTeamPanelLayout().rowCount`; 0 when there is nothing to show. */
  teamRowsNatural: number;
  /** Hysteresis: the rail rows the previous frame already used. */
  heldRailRows: number;
  /** Hysteresis: the roster rows the previous frame already used. */
  heldTeamRows: number;
  /**
   * The band takes the whole pool (native mode: always true, set by the budget).
   *
   * A plain boolean rather than "absence of a cap" because the difference is semantic:
   * with `fill` the allocation is INDEPENDENT of the content (which is what makes the
   * region the screen), while without it the band is sized to what it has to show.
   */
  fill: boolean;
}

export interface LiveBand {
  reason: BandReason;
  /** Band height: `remaining` in `fill` mode, `teamRows + previewRows` otherwise. */
  bandRows: number;
  teamRows: number;
  previewRows: number;
  /** Row budget of the rail: the whole band (the rail spans it). 0 when hidden. */
  railRows: number;
  /** The input `railCols` when visible, 0 when hidden (`/perf` reads `rail=0x0`). */
  railCols: number;
  /** `max(0, contentCols - railCols)`; always sums with `railCols` to `contentCols`. */
  previewCols: number;
  /** Hysteresis output, fed back on the next frame. */
  heldRailRows: number;
  heldTeamRows: number;
}

/** Invalid geometry becomes zero, exactly like `layout/team-panel.ts::nonNegativeInt`. */
function nonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Allocate the band. THE ORDER OF THE STEPS IS THE SPECIFICATION - reordering them
 * changes the priority between "what this run is doing" (rail + roster) and "the
 * words arriving right now" (tail), which is a product decision, not a detail.
 *
 * 0. Normalise every numeric input (`NaN` / `Infinity` / negatives become 0).
 * 1. An open overlay takes the whole pool (the band would otherwise double-count it).
 * 2. Seat the roster first, but never at the cost of the rail plus one tail row:
 *    a dispatch is transient, the plan is the shape of the turn, both must fit.
 * 3. Decide the rail's visibility, in the same reason order as `buildTodoRailLayout`.
 * 4. RESERVE the rail's rows - only when the band is NOT filling. `fill` derives
 *    `railRows` from `bandRows` in step 7, so the reservation has no consumer there.
 * 5. The tail takes what is left: the whole column in `fill` mode, `previewWanted`
 *    clamped by the pool otherwise.
 * 6. `bandRows`: the pool in `fill` mode, `max(railReserved, teamRows + previewRows)`
 *    otherwise (where a rail must still be there with no tail rows).
 * 7. Columns: the input `contentCols` is the only width authority.
 * 8. Hand the late-arriving values (the hysteresis) back out for the next frame.
 */
export function buildLiveBand(input: LiveBandInput): LiveBand {
  const remaining = nonNegativeInt(input.remaining);
  const contentCols = nonNegativeInt(input.contentCols);
  const railCols = nonNegativeInt(input.railCols);
  const itemCount = nonNegativeInt(input.itemCount);
  const teamRowsNatural = nonNegativeInt(input.teamRowsNatural);
  const heldRailRows = nonNegativeInt(input.heldRailRows);
  const heldTeamRows = nonNegativeInt(input.heldTeamRows);
  const fill = input.fill === true;

  if (input.overlayOpen) {
    return {
      reason: 'overlay', bandRows: remaining, teamRows: 0, previewRows: 0,
      railRows: 0, railCols: 0, previewCols: contentCols, heldRailRows: 0, heldTeamRows: 0,
    };
  }

  const teamCeiling = Math.min(
    teamRowsNatural,
    Math.max(0, remaining - TODO_LIMITS.panelMinRows - 1),
  );
  // THE ROSTER IS SEATED AT ITS NATURAL (CLAMPED) HEIGHT, NOT AT THE REMEMBERED ONE.
  // Seeding from `heldTeamRows` deadlocks the panel: a fresh dispatch starts with no
  // memory, so frame one would seat zero rows, remember zero, and no later frame could
  // ever seat the roster - the panel this feature exists to restore would never appear
  // (found while implementing; recorded as IF-1 in the spec). The memory below only
  // ever ADDS height back after a squeeze; it never withholds it.
  //
  // THE FLOOR SURVIVES `fill` ON PURPOSE (spec §5.3.2; RV-P2-5, recorded as not changed
  // back). It holds 4 rows back from the roster even when the rail is not drawn, which
  // looks like waste in `fill` mode - but it is the vetted `AC-12` behaviour, and
  // `TodoPanel`'s 3-5 row compact form needs those rows to name the running item. The
  // only visible cost is 4 blank rows at the TOP of the left column (the tail still
  // ends against the composer), which is not one of the three reported defects; changing
  // it here would reopen a different feature in the same commit.
  const teamRows = teamCeiling;

  const reason: BandReason = !input.panelEnabled ? 'disabled'
    : itemCount === 0 ? 'empty'
    : railCols === 0 ? 'narrow'
    : remaining - teamRows < SCROLLBACK_LIMITS.railBandMinRows ? 'short'
    : 'visible';
  const railVisible = reason === 'visible';
  // NO CONSUMER IN `fill` MODE (step 7 derives `railRows` from `bandRows`); kept as the
  // documented historical formula so the non-fill allocation stays readable and a future
  // caller that does not fill cannot silently lose the rail's reservation.
  const railReserved = railVisible && !fill
    ? Math.min(
      Math.max(heldRailRows, TODO_LIMITS.panelFullRows),
      Math.max(0, remaining - teamRows - 1),
    )
    : 0;

  const previewRows = fill
    ? Math.max(0, remaining - teamRows)
    // Non-fill: the tail takes what the rail's reservation leaves. The two row caps that
    // used to clamp this line (`previewCap` / `previewWanted`) are RETIRED (D9) - they
    // were the only inputs that made this branch differ from `fill`, so a non-fill caller
    // now gets the pool too. The branch stays as the named expression of the older policy.
    : Math.max(0, remaining - teamRows - railReserved);
  const bandRows = fill ? remaining : Math.max(railReserved, teamRows + previewRows);
  const railRows = railVisible ? bandRows : 0;
  const railColsOut = railVisible ? railCols : 0;

  return {
    reason,
    bandRows,
    teamRows,
    previewRows,
    railRows,
    railCols: railColsOut,
    previewCols: Math.max(0, contentCols - railColsOut),
    // MONOTONE MEMORY, NOT A SHRINKING ONE (I-6). A rail that collapsed to zero rows
    // because the terminal shrank for two frames would otherwise come back four rows
    // shorter and the band would visibly jump on every resize wobble. The RESET points
    // (an emptied plan, a finished dispatch, a resize) live in the one place that owns
    // the lifecycle, `use-scrollback-view.ts`; this function only remembers.
    heldRailRows: Math.max(heldRailRows, railRows),
    heldTeamRows: Math.max(heldTeamRows, teamRows),
  };
}
