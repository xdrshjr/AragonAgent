/**
 * ScrollbackShell — the LIVE REGION of native-scroll mode
 * (tui-native-terminal-scroll §4.6, tui-full-height-live-region D3/D4).
 *
 * THE REGION IS THE SCREEN. The root box is `budget.liveRows` tall, and that number is
 * `rows - 1` - the whole area above the writer's parked row. It used to be only as tall
 * as the panel band asked for, and every row it did not ask for became the canvas
 * `gap`: blank rows ABOVE the content, which is what a user reports as "the app starts
 * halfway down the terminal" and as "a big blank between the result and the running
 * card". `H = rows - 1` is also the ONLY height that both fills the screen and keeps Ink
 * off its `clearTerminal` branch (that branch fires at `outputHeight >= rows` and
 * contains `ESC[3J`, which erases the user's scrollback).
 *
 * Top to bottom: [overlay | panel band][composer][identity][status][details].
 *
 * THE PANEL BAND IS THE PART NATIVE MODE WAS MISSING
 * (release-gate-and-native-panels §6.1). A fixed frame can put a rail beside the
 * transcript; without one the rail and the roster simply had nowhere to go, so the
 * default mode showed neither. The band is a row pool inside the live region:
 *
 *   +----------------------------------------------+----------------+
 *   | tail window       (height = band.previewRows) | TODO rail      |
 *   +----------------------------------------------+ (height =      |
 *   | team roster (width = contentCols, height = band.teamRows)       |
 *   +----------------------------------------------------------------+
 *
 * THE ROSTER IS A FULL-WIDTH SLOT BELOW THE ROW REGION
 * (tui-subagent-panel §4.1.2 / D-2). It used to be the band's LEFT COLUMN bottom
 * slot, which capped its width at `previewCols`: with the TODO rail visible that is
 * 84 columns on a 100-column terminal, so the row's right-aligned clock could never
 * reach the screen's edge however carefully the row itself was laid out. It is now a
 * SIBLING of the row region and spans `contentCols`, so the clock lands on the last
 * column the terminal can draw. The READING is unchanged, and it is what
 * `tui-subagent-double-roster` A-3 established: the roster is transient status about
 * the run in progress, so it belongs against the composer, where the user's eyes
 * already are and where full-screen mode's viewport `footer` puts it.
 *
 * Every box in it has an explicit `height` and `width` plus `overflow="hidden"`, and
 * that is a correctness requirement rather than tidiness: a box that grows with its
 * content would make the region taller than `budget.liveRows`, and a frame as tall as
 * the terminal makes Ink erase the user's scrollback.
 *
 * THE IDENTITY ROW IS A BOTTOM SLOT, NOT THE FIRST ONE
 * (tui-header-leaks-into-scrollback, plan A-prime). It is still `budget.headerRows` tall
 * and still spent out of the region's pool - only its ORDER changed:
 *  - position is not cosmetic here, it is the whole defect. The writer lays the canvas out
 *    as `[gap][content][region]` and only CONTENT rows ever scroll out (`canvas.ts`), so
 *    region row 0 is by construction the successor of the newest row in the terminal's
 *    scrollback. A tall reply gives way at the top (`overflow-print.ts`: head printed,
 *    tail on screen), so chrome parked on row 0 is read BETWEEN two rows of the SAME
 *    answer: the user's report is the word mark, `provider:model`, `cwd`, the key and
 *    `^G more` appearing in the middle of a finished reply.
 *  - the bottom slots have no such property: nothing below the band is ever printed or
 *    scrolled, so `[composer][identity][status][details]` stays outside the conversation
 *    for a reply of any length. That band is also the one the writer protects on purpose
 *    (I-B17: give way at the TOP, because the composer and the status line are the two
 *    rows the human is interacting with).
 *  - the two surrounding slots are NOT interchangeable. Above the composer would also
 *    dodge the seam, but it would break the promise that the newest line hugs the input
 *    box (`canvas.ts`, `tail-anchor.ts`); below the status group would split the
 *    `[status][details]` pair, and "the status is the screen's last row" is its own
 *    invariant (`tui-duplicate-status-row`); inside the band's row pool would change
 *    `previewRows`, and no budget number may move for this fix.
 *  - `app` mode (`layout/AppShell.tsx`) deliberately keeps its header on TOP, so the two
 *    modes do NOT agree and must not be "unified": there the header sits above a viewport
 *    that scrolls itself, so there is no print channel and no seam to leak into.
 *  - `headerRows` is still produced by `buildScrollbackBudget` alone (still 1, still
 *    subtracted from `remaining`), so `liveRows`, `bandRows`, `previewRows` and `railCols`
 *    are unchanged: a row ORDER change, not a row BUDGET change.
 *  - the row is still NOT printed into the scrollback: at `H = rows - 1` any printed row
 *    is pushed off the screen by the next frame, so "print the header" would mean "the
 *    header is never visible".
 *
 * THE BAND'S PREVIEW BOX IS TOP-ALIGNED; THE OTHER SLOTS ARE FIXED
 * (D3 / D4 / I-F7; tui-first-reply-bottom-aligned, plan A-prime):
 *  - the band's preview box is TOP-aligned unconditionally, which is why the alignment is
 *    no longer a function of `opener`. `opener` is a 12-row card in a 24-row column, so
 *    bottom-aligning it left 12 blank rows in the upper half of the screen - the original
 *    defect, still inside the region, where the `gap` assertion could not see it
 *    (RV-P0-1). `tail` had the same shape for a short conversation: four rows pressed
 *    against the composer with every unused row ABOVE them, which is the defect plan
 *    A-prime fixes. `tail` therefore decides its own alignment one level down
 *    (`scrollback/tail-anchor.ts`): top while its content fits, and the old `flex-end`
 *    only on the frames where the content overflows and the newest row must stay visible.
 *    `opener` and `tail` share this box because two boxes would be one more height to
 *    get wrong, and they are mutually exclusive by construction (`App` keys them off
 *    `entries.length === 0`).
 *
 * `liveTailLines` STAYS. It is the plain-text fallback for the frames where the real
 * tail is not mounted (and the floor of the measurement path); `tail` wins when both
 * are given, so the two can never be drawn on top of each other. It is sliced to
 * `budget.liveTailRows` below, which is the same number as `band.previewRows`: that slice
 * is what makes the unconditional `flex-start` safe here, because a fallback taller than
 * the box would clip its NEWEST line - the one direction this box must never clip.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { ScrollbackBudget } from './scrollback/budget.js';

export interface ScrollbackShellProps {
  budget: ScrollbackBudget;
  /**
   * REQUIRED: the identity row, `budget.headerRows` tall, drawn BETWEEN the composer and
   * the status group. Required rather than optional for the reason `budget` and `band` are
   * - a frame that forgot it would render a header-less screen with nothing to catch it.
   */
  header: React.ReactNode;
  /** Shown instead of the band when an overlay is open. */
  overlay: React.ReactNode | null;
  /** Plain preview rows: the fallback when `tail` is absent (and what `/perf` counts). */
  liveTailLines: readonly string[];
  /**
   * The empty-session card. Mutually exclusive with `tail`, TOP-aligned like the rest of
   * the band's preview box (RV-P0-1).
   */
  opener?: React.ReactNode;
  /** Real components for the tail window (`LiveTail`). */
  tail?: React.ReactNode;
  /**
   * The subagent roster: the band's FULL-WIDTH bottom slot, i.e. the rows closest to
   * the composer. It is the only live subagent surface during a dispatch - the
   * transcript's `team` card is suppressed while it is active.
   */
  team?: React.ReactNode;
  /** The TODO rail, drawn as the row region's right-hand column. */
  rail?: React.ReactNode;
  composer: React.ReactNode;
  status: React.ReactNode;
  details?: React.ReactNode;
  placeholder: React.ReactNode;
  theme: Theme;
}

export function ScrollbackShell({
  budget,
  header,
  overlay,
  liveTailLines,
  opener,
  tail,
  team,
  rail,
  composer,
  status,
  details,
  placeholder,
  theme,
}: ScrollbackShellProps): React.ReactElement {
  const width = budget.contentCols;
  if (budget.inactive) {
    return (
      <Box flexDirection="column" height={budget.liveRows} width={width} overflow="hidden"
        flexShrink={0}>
        {budget.liveRows > 0 ? placeholder : null}
      </Box>
    );
  }
  const band = budget.band;
  // `opener ?? tail ?? lines` is ONE slot, not three: they are mutually exclusive, so
  // the two can never both be drawn and fight for the height. This box's alignment is
  // fixed (`flex-start`); `tail` alone may fall back to `flex-end` when it overflows.
  const leftColumn = opener ?? tail;
  const tailLines = liveTailLines.slice(-budget.liveTailRows);
  // I-1 (tui-subagent-panel §4.1.3): `rowRegion + band.teamRows <= band.bandRows`. In
  // `fill` mode `previewRows === railRows === bandRows - teamRows`, so the two heights
  // add back up to the band exactly; `band.ts` owns both numbers and this is their
  // only consumer.
  const rowRegion = Math.max(band.previewRows, band.railRows);
  // The overlay and the band are alternatives, not siblings: the band reports
  // `bandRows = remaining` for an overlay frame, so drawing both would double the
  // region's height and take the frame to the terminal height (the `ESC[3J` case).
  const top = band.reason === 'overlay' ? (
    <Box flexDirection="column" height={budget.overlayRows} flexShrink={0} overflow="hidden">
      {overlay}
    </Box>
  ) : band.bandRows > 0 ? (
    // ROW REGION ABOVE, FULL-WIDTH ROSTER BELOW (tui-subagent-panel §4.1.2 / D-2).
    <Box flexDirection="column" height={band.bandRows} flexShrink={0} overflow="hidden">
      <Box flexDirection="row" height={rowRegion} flexShrink={0} overflow="hidden">
        <Box flexDirection="column" width={budget.previewCols} height={rowRegion}
          flexShrink={0} overflow="hidden">
          {band.previewRows > 0 && (
            <Box flexDirection="column" height={band.previewRows} flexShrink={0}
              justifyContent="flex-start" overflow="hidden">
              {leftColumn ?? tailLines.map((line, index) => (
                <Text key={index} wrap="truncate" color={theme.muted}>{line}</Text>
              ))}
            </Box>
          )}
        </Box>
        {band.railRows > 0 && (
          <Box height={band.railRows} width={band.railCols} flexShrink={0} overflow="hidden">
            {rail}
          </Box>
        )}
      </Box>
      {/* THE FULL-WIDTH ROSTER SLOT (D-2). `width` is explicit for the same reason the
          panel's own root box carries one: a fixed-height box with no width lets its
          column collapse to its widest child, which is precisely the reported defect. */}
      {band.teamRows > 0 && (
        <Box width={width} height={band.teamRows} flexShrink={0} overflow="hidden">
          {team}
        </Box>
      )}
    </Box>
  ) : null;
  return (
    <Box flexDirection="column" height={budget.liveRows} width={width} overflow="hidden"
      flexShrink={0}>
      {top}
      <Box flexDirection="column" height={budget.composerSlotRows} justifyContent="flex-end"
        flexShrink={0} overflow="hidden">{composer}</Box>
      {/*
        THE IDENTITY ROW LIVES HERE AND NOT ON ROW 0. Region row 0 is the successor of the
        newest printed row by construction (`canvas.ts`), so a row there is read as part of
        the conversation whenever a reply is split across the seam. Below the composer there
        is no seam left to fall into, and the `[status][details]` pair stays whole. See the
        file header for the three rejected neighbours.
      */}
      {budget.headerRows > 0 && (
        <Box height={budget.headerRows} flexShrink={0} overflow="hidden">{header}</Box>
      )}
      <Box height={budget.statusRows > 0 ? 1 : 0} flexShrink={0} overflow="hidden">{status}</Box>
      {budget.statusRows === 2 && (
        <Box height={1} flexShrink={0} overflow="hidden">{details}</Box>
      )}
    </Box>
  );
}
