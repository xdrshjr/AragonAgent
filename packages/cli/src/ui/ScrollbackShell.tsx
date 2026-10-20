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
 * Top to bottom: [header][overlay | panel band][composer][status][details].
 *
 * THE PANEL BAND IS THE PART NATIVE MODE WAS MISSING
 * (release-gate-and-native-panels §6.1). A fixed frame can put a rail beside the
 * transcript; without one the rail and the roster simply had nowhere to go, so the
 * default mode showed neither. The band is a row pool inside the live region:
 *
 *   +---------------------------------------------+-----------------+
 *   | tail window      (height = band.previewRows) | TODO rail       |
 *   +---------------------------------------------+ (height =       |
 *   | team roster      (height = band.teamRows)    |  band.railRows) |
 *   +---------------------------------------------+-----------------+
 *
 * THE ROSTER IS THE LEFT COLUMN'S BOTTOM SLOT, not its top one
 * (tui-subagent-double-roster A-3). `band.ts` allocates the same two heights either
 * way - only the drawing order changed - so every row number, and every test that
 * asserts one, is untouched. What moves is the reading: the roster is transient
 * status about the run in progress, so it belongs against the composer (where the
 * user's eyes already are, and where full-screen mode's viewport `footer` puts it),
 * and the conversation's own tail stays above it. As a bonus the rows a short tail
 * does not use now fall between the tail and the roster instead of between the tail
 * and the input box, which is the "blank space above the composer" shape the
 * plan-A-prime work removed one level up.
 *
 * Every box in it has an explicit `height` and `width` plus `overflow="hidden"`, and
 * that is a correctness requirement rather than tidiness: a box that grows with its
 * content would make the region taller than `budget.liveRows`, and a frame as tall as
 * the terminal makes Ink erase the user's scrollback.
 *
 * THE BAND'S PREVIEW BOX IS TOP-ALIGNED; THE OTHER SLOTS ARE FIXED
 * (D3 / D4 / I-F7; tui-first-reply-bottom-aligned, plan A-prime):
 *  - `header` is the fixed 1-row slot at the very top. It is NOT printed into the
 *    scrollback any more: at `H = rows - 1` any printed row is pushed off the screen by
 *    the next frame, so "print the header" would mean "the header is never visible".
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
   * REQUIRED: the one-row slot at the top of the region, `budget.headerRows` tall.
   * Required rather than optional for the reason `budget` and `band` are - a frame
   * that forgot it would render a header-less screen with nothing to catch it.
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
   * The subagent roster: the BOTTOM slot of the band's left column, i.e. the row
   * closest to the composer. It is the only live subagent surface during a
   * dispatch - the transcript's `team` card is suppressed while it is active.
   */
  team?: React.ReactNode;
  /** The TODO rail, drawn as the band's right-hand column. */
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
  // The overlay and the band are alternatives, not siblings: the band reports
  // `bandRows = remaining` for an overlay frame, so drawing both would double the
  // region's height and take the frame to the terminal height (the `ESC[3J` case).
  const top = band.reason === 'overlay' ? (
    <Box flexDirection="column" height={budget.overlayRows} flexShrink={0} overflow="hidden">
      {overlay}
    </Box>
  ) : band.bandRows > 0 ? (
    <Box flexDirection="row" height={band.bandRows} flexShrink={0} overflow="hidden">
      <Box flexDirection="column" width={budget.previewCols} flexShrink={0} overflow="hidden">
        {band.previewRows > 0 && (
          <Box flexDirection="column" height={band.previewRows} flexShrink={0}
            justifyContent="flex-start" overflow="hidden">
            {leftColumn ?? tailLines.map((line, index) => (
              <Text key={index} wrap="truncate" color={theme.muted}>{line}</Text>
            ))}
          </Box>
        )}
        {/* BOTTOM SLOT, DELIBERATELY (A-3): the roster sits directly above the
            composer, so a dispatch reads as "conversation above, live status against
            the input box". The two heights are `band.ts`'s and are unchanged - only
            this drawing order moved. */}
        {band.teamRows > 0 && (
          <Box height={band.teamRows} flexShrink={0} overflow="hidden">{team}</Box>
        )}
      </Box>
      {band.railRows > 0 && (
        <Box height={band.railRows} width={band.railCols} flexShrink={0} overflow="hidden">
          {rail}
        </Box>
      )}
    </Box>
  ) : null;
  return (
    <Box flexDirection="column" height={budget.liveRows} width={width} overflow="hidden"
      flexShrink={0}>
      {budget.headerRows > 0 && (
        <Box height={budget.headerRows} flexShrink={0} overflow="hidden">{header}</Box>
      )}
      {top}
      <Box flexDirection="column" height={budget.composerSlotRows} justifyContent="flex-end"
        flexShrink={0} overflow="hidden">{composer}</Box>
      <Box height={budget.statusRows > 0 ? 1 : 0} flexShrink={0} overflow="hidden">{status}</Box>
      {budget.statusRows === 2 && (
        <Box height={1} flexShrink={0} overflow="hidden">{details}</Box>
      )}
    </Box>
  );
}
