/**
 * LiveTail - the band's TAIL WINDOW, rendered with the real entry components
 * (release-gate-and-native-panels §6.5, tui-full-height-live-region D6).
 *
 * WHY THIS FILE EXISTS. Native scroll mode cannot print an entry until it settles, so
 * the live region used to show `buildLivePreview`'s plain-text projection - and for a
 * running dispatch that projection was four grey rows saying `Team: 2/4 running`. It
 * was the "simple look" the feature was opened for. A text-only region can never fix
 * it, which is why the region's content type changed from `readonly string[]` to a
 * fixed-height box that can hold components.
 *
 * IT SHOWS THE CONVERSATION, NOT JUST THE UNFINISHED PART (D6/D7). The input used to be
 * `entries.slice(settledCount)` - the entries the reducer had not finished writing -
 * because everything settled was printed into the scrollback immediately. Now the region
 * is the whole screen, `H = rows - 1`, so a printed row is pushed off the top by the next
 * frame; the region therefore holds the last `SCROLLBACK_LIMITS.liveTailMaxEntries`
 * PRINTABLE entries, settled or not, and an entry is printed when it LEAVES that window.
 * The window is `tail-window.ts`'s definition; this component only slides it over the
 * list and lets the fixed-height box clip from the top when it overflows.
 *
 * IT RENDERS `EntryView` AND NOTHING ELSE. The mapping from an entry to its component
 * (`assistant` / `tool` / `team` / `todo` / service cards, notice frames, the `null`
 * cases) lives in `Transcript.tsx` exactly once, together with `EntryFrame`'s gutter,
 * the separation rows, the per-entry `nowSecFor` clock and the memo comparator. A
 * second enumeration here would be a copy that drifts: the band's cards would lose the
 * left rail glyph and the transcript's would keep it, and the two halves of one screen
 * would disagree about the same entry.
 *
 * TOP-ANCHORED WHILE THE CONTENT FITS, BOTTOM-ANCHORED WHEN IT DOES NOT
 * (tui-first-reply-bottom-aligned, plan A-prime). A constant `flex-end` is what a user
 * reports as "the first reply shows up at the bottom": the box is always the whole pool,
 * so a four-row first turn was pushed against the composer and every unused row sat ABOVE
 * the conversation. `tailAnchor` therefore sums the estimated height of exactly the
 * entries this frame renders and asks for `flex-start` while they fit - the conversation
 * is then written downwards from the region's top row, the way a terminal writes. (That row
 * belongs to the band: `tui-header-leaks-into-scrollback` moved the identity row below the
 * composer, so nothing sits between the newest printed row and the first row of the tail.)
 *
 * THE OVERFLOW FRAME STAYS `flex-end`, AND THAT IS THE OTHER HALF OF THE FIX.
 * `flex-start` PLUS `overflow="hidden"` clips the NEWEST rows (Ink's clip rectangle is
 * the box's own `[top, top + height]`), and a streaming entry can never be printed into
 * the scrollback to make up for it (`settled-boundary.ts` holds it unstable, and printed
 * rows are permanent). `flex-end` clips the OLDEST rows instead, which is the promise
 * `scrollback/canvas.ts` makes about the live tail: the newest line always sits against
 * the composer. Those clipped rows are what `overflow-print.ts` prints, which is why the
 * branch has to be `bottom` before anything is printed - and why `measuredRows` exists.
 *
 * THE SWITCH COSTS ONE DOWNWARD MOVE ON A STREAMING FRAME, AND IT IS NOT FREE. The two
 * branches are only pixel-identical where the content EXACTLY fills the box, and the
 * estimate cannot know that: `estimateEntryRows` charges every entry a separation row while
 * `density.ts::separationRows` only draws one above a `user` entry, so the frame that
 * flips is still a few rows short of the box and the block drops by those rows once -
 * three on a 30-row terminal (the margin plus that over-count) - before it starts
 * scrolling up a row per line. Accepted and pinned by
 * `scrollback-first-reply-anchor.test.tsx`: anchoring to the top until the content
 * really fills the box is exactly the frame that clips the newest row, and measuring the
 * box every frame is the cost plan A-prime exists to avoid.
 *
 * A SETTLED WINDOW IS MEASURED ANYWAY, so the move is exact there (`measuredRows`).
 * `use-scrollback-view.ts` has to measure the window to decide what the box hides, and
 * `resolveTailAnchor` lets that measurement decide the anchor: `flex-end` exactly when the
 * content is taller than the box. So the glitch above survives only on frames where no
 * measurement exists yet - every streaming frame, i.e. exactly the case the pin covers.
 *
 * BOUNDED: at most `SCROLLBACK_LIMITS.liveTailMaxEntries` component instances per frame
 * (I-10). That is what keeps the per-frame cost the same order as the full-screen live
 * tail; growing it makes the cost grow linearly because this box has no windowing.
 */

import React from 'react';
import { Box } from 'ink';
import type { Entry } from '../../model/agent/reducer.js';
import type { TermCapabilities } from '../capabilities.js';
import type { DensityMode } from '../density.js';
import type { Theme } from '../theme.js';
import { EntryView, nowSecFor } from '../Transcript.js';
import type { VoiceContext } from '../tool-voice.js';
import { estimateEntryRows } from '../layout/virtual-window.js';
import { SCROLLBACK_LIMITS } from './limits.js';
import { isSlotless } from './tail-window.js';
import { resolveTailAnchor } from './tail-anchor.js';

export interface LiveTailProps {
  /**
   * The whole entry list (settled and unfinished alike); the window is taken here.
   * Callers must not pre-slice it: `prev` has to come from the same list the transcript
   * draws, or the top card of the band loses the separator row it has upstairs.
   */
  entries: readonly Entry[];
  /** Render only the last N entries; the box clips the older ones from the top. */
  maxEntries: number;
  /** Fixed height: the root box's `height`. The content never decides it (I-4). */
  rows: number;
  /** `budget.previewCols` - the width left after the rail took its column (I-5). */
  cols: number;
  expandedToolIds: Record<string, true>;
  thinkingVisible: boolean;
  reducedMotion: boolean;
  /** See `EntryViewProps.voice`. */
  voice: VoiceContext;
  density: DensityMode;
  nowSec?: number;
  theme: Theme;
  caps: TermCapabilities;
  /**
   * Measured height of exactly the entries this frame renders, when the owner of the
   * measurement (`use-scrollback-view.ts`) has it. It decides the anchor INSTEAD of the
   * estimate - see `resolveTailAnchor`. `undefined` on every frame without a full
   * measurement, which is every streaming frame: the estimate then decides, as before.
   */
  measuredRows?: number;
}

export interface TailEntry {
  entry: Entry;
  /** The entry before it in the passed list: `EntryView` decides the separator from it. */
  prev: Entry | undefined;
}

/**
 * The last `maxEntries` printable entries, each with its predecessor.
 *
 * `prev` must come from the same COMPLETE list rather than from the truncated slice, or
 * the first rendered entry would look like the head of the conversation and drop the
 * separation row the transcript shows above the same card.
 */
export function selectTailEntries(
  entries: readonly Entry[],
  maxEntries: number,
): readonly TailEntry[] {
  // A LIVE DISPATCH CARD TAKES NO SLOT (tui-subagent-double-roster A-2): the roster
  // draws it and `EntryView` returns null for it, so the window must not spend one of
  // its slots on an entry that is not on screen. `isSlotless` is `tail-window.ts`'s
  // predicate - the one `selectTailWindow` and the print pump apply - so the box and
  // `planOverflowPrint` cannot drift into different windows.
  const printable = entries.filter((entry) => !isSlotless(entry));
  const limit = Number.isFinite(maxEntries) ? Math.max(0, Math.floor(maxEntries)) : 0;
  if (limit === 0) return [];
  const start = Math.max(0, printable.length - limit);
  const selected: TailEntry[] = [];
  for (let index = start; index < printable.length; index += 1) {
    selected.push({
      entry: printable[index]!,
      prev: index > 0 ? printable[index - 1] : undefined,
    });
  }
  return selected;
}

export function LiveTail({
  entries,
  maxEntries,
  rows,
  cols,
  expandedToolIds,
  thinkingVisible,
  reducedMotion,
  voice,
  density,
  nowSec,
  theme,
  caps,
  measuredRows,
}: LiveTailProps): React.ReactElement {
  const limited = Math.min(maxEntries, SCROLLBACK_LIMITS.liveTailMaxEntries);
  const selected = selectTailEntries(entries, limited);
  // `estimateEntryRows` is the estimate the transcript's virtual window already uses, so
  // the anchor can never disagree with the height the rest of the interface plans for.
  const estimateRows = (entry: Entry): number =>
    estimateEntryRows(entry, cols, density, expandedToolIds[entry.id] === true, thinkingVisible);
  const anchor = resolveTailAnchor({
    entries: selected.map((tailEntry) => tailEntry.entry),
    budgetRows: rows,
    rowOf: estimateRows,
    measuredRows,
  });
  return (
    <Box flexDirection="column" height={rows} width={cols}
      justifyContent={anchor === 'top' ? 'flex-start' : 'flex-end'}
      flexShrink={0} overflow="hidden">
      {selected.map(({ entry, prev }) => (
        <EntryView
          key={entry.id}
          entry={entry}
          voice={voice}
          prev={prev}
          expanded={expandedToolIds[entry.id] === true}
          thinkingVisible={thinkingVisible}
          reducedMotion={reducedMotion}
          density={density}
          nowSec={nowSecFor(entry, nowSec)}
          theme={theme}
          caps={caps}
        />
      ))}
    </Box>
  );
}
