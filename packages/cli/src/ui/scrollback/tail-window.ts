/**
 * The TAIL WINDOW of the native-scroll live region
 * (tui-full-height-live-region D6 / D7, I-F8 / I-F9).
 *
 * WHAT CHANGED AND WHY. The region used to show only the entries the reducer had not
 * finished writing (`entries.slice(settledCount)`), and everything settled was printed
 * into the terminal's scrollback the moment it settled. Once the region is the WHOLE
 * screen (`liveRows = rows - 1`), a printed row is pushed off the top by the very next
 * frame, so "print on settle" would leave the user staring at a screen of blanks with
 * only the unfinished cards on it. So the region now shows the last `K` PRINTABLE
 * entries - settled or not - and an entry is printed when it LEAVES that window.
 *
 * The window is defined by ENTRY COUNT, never by measured height; what a single entry
 * taller than the region used to do is the whole subject of
 * `overflow-print.ts` (tui-final-reply-truncated-unscrollable). The box still clips it
 * from the top with `justifyContent="flex-end"`, but the rows it hides are now PRINTED
 * into the terminal's scrollback, where the wheel already reaches, instead of waiting for
 * `K` further entries (README, known limitation 2 - rewritten by that fix).
 *
 * PURE: no Ink, no I/O, no clock. `promote()` (the writer's only feeder) takes
 * `printBoundary`'s result and keeps its own `printed` authority, so "printed is
 * forward-only" (RV-7) is unchanged.
 *
 * PRINTABILITY != VISIBILITY. `isExcluded` entries (a non-terminal `service` card) never
 * print and never take a slot in the window; an entry that is in the window may still be
 * scrolled out of sight by a taller neighbour. That second gap is what the row-level plan
 * closes, and `/perf`'s `window=<start>/<n> head=<rows>` is how it stays observable.
 */

import type { Entry } from '../../agent/reducer.js';
import { isExcluded, settledCount } from './settled-boundary.js';
import { isLiveTeamCard } from '../team-status.js';

/**
 * Entries that take NO slot in the window: they neither print nor take a row.
 *
 * A LIVE DISPATCH CARD JOINS THE NON-TERMINAL SERVICE CARD HERE
 * (tui-subagent-double-roster A-2'): the roster draws the live dispatch and the
 * transcript draws nothing, so the window must not spend one of its slots on an
 * entry that is not on screen. THE PRINT PUMP AND THE BOX MUST AGREE ABOUT SLOTS:
 * so both window functions below skip it, and `LiveTail.selectTailEntries` - the
 * window function the box renders - imports this one instead of spelling the
 * composition out a second time.
 */
export function isSlotless(entry: Entry): boolean {
  return isExcluded(entry) || isLiveTeamCard(entry);
}

export interface TailWindow {
  /** First index of the window inside the full entry list. */
  start: number;
  /** Entries inside the window, oldest first (excluded entries already dropped). */
  entries: readonly Entry[];
}

/**
 * The index of the first entry that is still on screen: count backwards up to
 * `maxEntries` PRINTABLE entries. Everything before it has left the region and is the
 * writer's business.
 *
 * `maxEntries <= 0` returns `entries.length` - an empty window, which is the old
 * behaviour ("everything printable may print") and the reason the guard is written as
 * an early return rather than as a loop bound.
 */
export function tailWindowStart(entries: readonly Entry[], maxEntries: number): number {
  const limit = Number.isFinite(maxEntries) ? Math.floor(maxEntries) : 0;
  if (limit <= 0) return entries.length;
  let seen = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isSlotless(entries[i]!)) continue;
    seen += 1;
    if (seen === limit) return i;
  }
  // Fewer printable entries than the window holds: the whole conversation is on screen.
  return 0;
}

/** `entries.slice(start)` with the entries that never print dropped. */
export function selectTailWindow(
  entries: readonly Entry[],
  maxEntries: number,
): TailWindow {
  const start = tailWindowStart(entries, maxEntries);
  return { start, entries: entries.slice(start).filter((entry) => !isSlotless(entry)) };
}

/**
 * The print boundary: never print what the region is still showing.
 *
 * THIS IS THE ONLY PLACE THAT COMBINES "settled" WITH "in the window" (RV-P2-13), which
 * is why the composition lives here instead of at the pump: `promote()` must keep
 * receiving one number, and the two authorities it is derived from - `settledCount`
 * (what may print at all) and `tailWindowStart` (what is still visible) - then cannot
 * drift apart in a future edit.
 *
 * `settleAllEntries` is the OTHER authority, not a duplicate: it answers "what must be
 * printed when the conversation is being torn down", while this answers "how far may
 * this frame print".
 */
export function printBoundary(
  entries: readonly Entry[],
  runActive: boolean,
  maxEntries: number,
): number {
  return Math.min(settledCount(entries, runActive), tailWindowStart(entries, maxEntries));
}
