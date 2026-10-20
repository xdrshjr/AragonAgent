/**
 * `useScrollbackView` — the promotion pipeline of native-scroll mode
 * (tui-native-terminal-scroll §4.4 / §6.2, tui-full-height-live-region D3/D4/D7/D8,
 * tui-final-reply-truncated-unscrollable A-prime).
 *
 * `App` calls it ALWAYS (hooks cannot be conditional); `enabled: false` makes every
 * effect a no-op and keeps `scrollMode: 'app'` byte-identical to the pre-feature
 * build (I-S9 / I-F10).
 *
 * What it does when enabled:
 *  1. On every entries change, promotes each entry that has LEFT THE TAIL WINDOW:
 *     renders it once through the offscreen renderer and enqueues the rows for the
 *     writer. Entries still on screen are never printed - at `H = rows - 1` a printed
 *     row is pushed back off the top by the next frame, and a second copy in the
 *     scrollback would be a duplicate the user meets by scrolling up (I-F8).
 *  2. Gives way at the TOP (tui-final-reply-truncated-unscrollable). The window is still
 *     counted in ENTRIES, so a settled answer taller than the box used to sit inside the
 *     window forever, clipped by `justifyContent="flex-end"`, in a mode whose wheel only
 *     scrolls the terminal's scrollback: the clipped rows existed nowhere the user could
 *     reach. The rows the box hides are now measured (`overflow-print.ts`) and printed, so
 *     `scrollback + screen` covers every row exactly once. Screen unchanged, reachability
 *     fixed.
 *  3. Computes the live-region budget, the window and the tail rows for the shell.
 *  4. Flushes the window before either reset path (`/clear`, `--resume`) and on exit,
 *     so "on screen but not printed yet" can never become "lost" (D8 / I-F12).
 *
 * THE HEADER AND THE OPENER ARE NOT PRINTED HERE ANY MORE (D3/D4). They are slots of
 * `ScrollbackShell` now, rendered inside the region: `H = rows - 1` means any printed
 * row is immediately scrolled off the screen, so printing the banner would be the same
 * as not drawing it. Their `renderNode` path, the `startedRef` latch that kept their
 * element identities stable, and the `printBanner()` call in `settleAll()` are gone.
 *
 * THE PROMOTION RUNS IN A MICROTASK, NOT IN THE EFFECT. The offscreen renderer is a
 * second Ink instance, and both instances share one React reconciler. A `rerender`
 * issued from inside the main tree's commit (a layout effect) is deferred until that
 * commit finishes, so its frame would not exist when the effect reads it. A microtask
 * runs after the commit has unwound, where the offscreen render is synchronous again.
 *
 * THE PASS READS THE COMMITTED FRAME, NOT THE LATEST RENDER. `latest` is refreshed during
 * render, so it can be a frame ahead of the screen; `committed` is written by a layout
 * effect and therefore describes exactly the frame the user is looking at. With
 * entry-granular bookkeeping the difference was harmless (printing was idempotent per
 * entry); with ROW-granular bookkeeping it would slice this frame's picture with another
 * frame's row numbers, and the result is a duplicate or a hole.
 *
 * `printed` is the ONLY authority on "already printed" (RV-7): a `Map` from entry id to
 * the leading rows already handed to the writer, and the width they were measured at. The
 * cursor is just a hint for where to resume scanning: entries leave the list by retain-ring
 * trimming AND by reducer deletion (empty settled assistants, abandoned tool cards), so an
 * id-keyed cursor can dangle, and then the only correct answer is to rescan and let
 * `printed` skip.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import type { Entry } from '../../agent/reducer.js';
import type { TermCapabilities } from '../capabilities.js';
import type { DensityMode } from '../density.js';
import { estimateEntryRows } from '../layout/virtual-window.js';
import { isLiveTeamCard } from '../team-status.js';
import type { Theme } from '../theme.js';
import { buildScrollbackBudget, type ScrollbackBudget } from './budget.js';
import type { ScrollbackDrain } from './drain.js';
import { buildLivePreview } from './live-preview.js';
import { SCROLLBACK_LIMITS } from './limits.js';
import {
  capPrintedRows,
  planOverflowPrint,
  reflowSeamRow,
  type OverflowWindowEntry,
} from './overflow-print.js';
import { createEntryRenderer, type EntryRenderer, type EntryRenderOptions } from './renderer.js';
import { isEntryStable, isExcluded, settleAllEntries } from './settled-boundary.js';
import { resolveTailAnchor, type TailAnchor } from './tail-anchor.js';
import { printBoundary, selectTailWindow } from './tail-window.js';
import type { ScrollbackWriter } from './scrollback-writer.js';

/** The channel between `cli.tsx` (which owns the stream) and the React tree. */
export interface ScrollbackBridge {
  writer: ScrollbackWriter;
  drain: ScrollbackDrain;
  /** Installed by `cli.tsx`: schedule `writer.repaint()` soon. */
  requestFlush: () => void;
  /**
   * Installed by the hook on mount (reads the latest entries through a ref).
   * `restore()` calls it on every exit path; it is idempotent through `printed`
   * and it releases the offscreen renderer when done.
   */
  settleAllNow: () => void;
  /** Installed by `App`; at most `exitSummaryMaxRows` rows. Wrapped in try/catch by the caller. */
  getSummaryRows: () => readonly string[];
  /** Installed by `App`: the writer swallowed repeated tall frames (degrade to the placeholder). */
  onGuardTrip: (() => void) | null;
}

export function createScrollbackBridge(
  parts: Pick<ScrollbackBridge, 'writer' | 'drain'> & { requestFlush?: () => void },
): ScrollbackBridge {
  return {
    writer: parts.writer,
    drain: parts.drain,
    requestFlush: parts.requestFlush ?? (() => undefined),
    settleAllNow: () => undefined,
    getSummaryRows: () => [],
    onGuardTrip: null,
  };
}

export type ScrollbackResetKind = 'clear' | 'restore';

export interface UseScrollbackViewArgs {
  /** `scrollMode === 'native'`. */
  enabled: boolean;
  bridge: ScrollbackBridge | undefined;
  entries: readonly Entry[];
  runActive: boolean;
  theme: Theme;
  caps: TermCapabilities;
  density: DensityMode;
  thinkingVisible: boolean;
  reducedMotion: boolean;
  /** Terminal size. */
  rows: number;
  cols: number;
  overlayOpen: boolean;
  draftRows: number;
  popupRows: number;
  statusExpanded: boolean;
  /** Degrade the region to the placeholder (the writer's tall-frame guard tripped). */
  forceInactive?: boolean;
  /** `state.todos.items.length` - 0 means there is no plan, so the rail has no work to show. */
  itemCount: number;
  /** `cfg.todo.panel`: the user can switch the rail off entirely. */
  panelEnabled: boolean;
  /** `buildTeamPanelLayout().rowCount`; 0 when nothing is dispatched. */
  teamRowsNatural: number;
  /**
   * `state.expandedToolIds` - REQUIRED, because the height of a window entry depends on it
   * and a forgotten value would measure an expansion the region is not drawing.
   */
  expandedToolIds: Record<string, true>;
}

export interface ScrollbackView {
  budget: ScrollbackBudget | null;
  liveTailLines: string[];
  /**
   * The entries the region is showing, in order (excluded kinds already dropped).
   * `windowStart` is their index in the full list - together they are what `/perf`
   * reports as `window=<start>/<n>`, the number that makes the "visible vs printable"
   * gap observable instead of a guess (known limitation 5).
   */
  tailEntries: readonly Entry[];
  windowStart: number;
  /**
   * Measured height of `tailEntries`, once every one of them is stable AND measured at the
   * current geometry; `undefined` otherwise. `LiveTail` prefers it over the estimate - see
   * `tail-anchor.ts::resolveTailAnchor` for why the measured answer has to win.
   */
  measuredTailRows: number | undefined;
  /** Rows the top give-way has printed this session; `/perf`'s `head=`. */
  headRows: number;
  /** Print a fresh EXPANDED copy of an entry; false when it cannot be found / rendered. */
  reprintExpanded(entryId: string): boolean;
  /** Promote everything still unprinted (shutdown) - `flushUnprinted(latest entries)`. */
  settleAll(): void;
  /** Called by `App`'s dispatch wrapper BEFORE a reset action reaches the reducer. */
  notifyReset(kind: ScrollbackResetKind): void;
}

const CLEARED_ROW = '---- conversation cleared ----';
const RESTORED_ROW = '---- session restored ----';

/** What one entry has already put into the scrollback. */
interface PrintedRows {
  /** Leading rows printed so far, in the entry's own row space at `cols`. */
  rows: number;
  /** The width those rows were measured and printed at. Row numbers are width-relative. */
  cols: number;
  /** Nothing more may print for this entry (fully printed, capped, or rendered to nothing). */
  done: boolean;
}

/** The frame the SCREEN is showing: written by a layout effect, read by the pump. */
interface CommittedFrame {
  entries: readonly Entry[];
  runActive: boolean;
  contentCols: number;
  previewCols: number;
  /** Height of the box that shows the window (`band.previewRows`); 0 disables the give-way. */
  tailRows: number;
  /** The anchor that frame actually used (`tail-anchor.ts`). */
  anchor: TailAnchor;
  /** The measurement the anchor was resolved from, `undefined` while unknown. */
  measuredRows: number | undefined;
  expandedToolIds: Record<string, true>;
}

interface LatestInputs {
  entries: readonly Entry[];
  runActive: boolean;
  contentCols: number;
  previewCols: number;
  expandedToolIds: Record<string, true>;
  options: EntryRenderOptions;
}

/** A window entry located in the FULL list (the window itself is a filtered slice). */
interface WindowItem {
  index: number;
  entry: Entry;
}

function printableBefore(entries: readonly Entry[], index: number): Entry | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!isExcluded(entries[i]!)) return entries[i];
  }
  return undefined;
}

/**
 * Ids leave `entries` by retain-ring trimming and never come back (ids are unique
 * per session), so both row maps are trimmed to the live list once they grow well past
 * it. Only ids still present can be re-evaluated, so dropping the rest is lossless.
 */
function pruneEntryIds(
  entries: readonly Entry[],
  printed: Map<string, PrintedRows>,
  heights: Map<string, number>,
): void {
  const bound = Math.max(2000, entries.length * 3);
  if (printed.size <= bound && heights.size <= bound) return;
  const live = new Set(entries.map((entry) => entry.id));
  for (const id of [...printed.keys()]) if (!live.has(id)) printed.delete(id);
  // Height keys are `id|cols|expanded|thinking`; only the id part decides liveness.
  for (const key of [...heights.keys()]) {
    if (!live.has(key.slice(0, key.indexOf('|')))) heights.delete(key);
  }
}

/** The word the expanded-copy header uses for one entry kind. */
function expandedLabel(entry: Entry): string {
  if (entry.kind === 'tool') return entry.name;
  // The escape hatch exists for the Agent's ANSWER (known limitation 2 promised it), so the
  // header says what the user pressed Ctrl+O for instead of the internal kind name.
  if (entry.kind === 'assistant') return 'answer';
  return entry.kind;
}

export function useScrollbackView(args: UseScrollbackViewArgs): ScrollbackView {
  const {
    enabled, bridge, entries, runActive, theme, caps, density, thinkingVisible, reducedMotion,
    rows, cols, overlayOpen, draftRows, popupRows, statusExpanded,
    forceInactive = false, itemCount, panelEnabled, teamRowsNatural, expandedToolIds,
  } = args;

  const contentCols = Math.max(1, cols - 1);
  // Everything the asynchronous EXIT and RESET paths read travels here, refreshed on every
  // render (see `committed` for why the promotion pass does not read it).
  const latest = useRef<LatestInputs>({
    entries, runActive, contentCols, previewCols: contentCols, expandedToolIds,
    options: { theme, caps, density, thinkingVisible, reducedMotion },
  });
  latest.current = {
    entries, runActive, contentCols, previewCols: latest.current.previewCols, expandedToolIds,
    options: { theme, caps, density, thinkingVisible, reducedMotion },
  };

  const rendererRef = useRef<EntryRenderer | null>(null);
  /** THE authority on "already printed" (RV-7), per entry and per row. */
  const printed = useRef<Map<string, PrintedRows>>(new Map());
  /** Measured heights, `id|cols|expanded|thinking` -> rows. Only STABLE entries are stored. */
  const heights = useRef<Map<string, number>>(new Map());
  /** A resume hint only (RV-7): the id of the last entry the previous pass covered. */
  const cursorRef = useRef<{ id: string; index: number } | null>(null);
  const pendingReset = useRef<{ kind: ScrollbackResetKind; captured: readonly Entry[] } | null>(null);
  const headRowsRef = useRef(0);
  /** Guards the "measure, then re-render so the anchor can use it" nudge against a loop. */
  const nudgedRef = useRef<string | null>(null);
  // Band hysteresis (release-gate-and-native-panels §6.7): the writer re-lays out the
  // canvas on every batch, so a band that shrank for two frames would make everything
  // above the composer jump.
  const heldRailRows = useRef(0);
  const heldTeamRows = useRef(0);
  const heldGeometry = useRef({ rows, cols });
  const pumpQueued = useRef(false);
  const mountedRef = useRef(true);
  const committed = useRef<CommittedFrame | null>(null);
  /** Bumped when a measurement has to reach `LiveTail` before the next pass may print. */
  const [measureEpoch, bumpMeasureEpoch] = useReducer((n: number) => n + 1, 0);

  const ensureRenderer = useCallback((): EntryRenderer => {
    if (!rendererRef.current) rendererRef.current = createEntryRenderer(latest.current.options);
    rendererRef.current.setOptions(latest.current.options);
    return rendererRef.current;
  }, []);

  const enqueue = useCallback((rowsToPrint: readonly string[], id: string, kind: string): void => {
    if (rowsToPrint.length === 0 || !bridge) return;
    bridge.drain.enqueue(rowsToPrint, { id, kind });
  }, [bridge]);

  const heightKey = useCallback((entry: Entry, colsNow: number, expanded: boolean): string =>
    `${entry.id}|${colsNow}|${expanded ? 1 : 0}|${thinkingVisible ? 1 : 0}`, [thinkingVisible]);

  /** Rows of one entry at `colsNow`, measured once per (id, cols, flags) and cached. */
  const measure = useCallback((
    entry: Entry, prev: Entry | undefined, colsNow: number, expanded: boolean,
  ): number => {
    const key = heightKey(entry, colsNow, expanded);
    const cached = heights.current.get(key);
    if (cached !== undefined) return cached;
    const measured = ensureRenderer().renderEntryRows(entry, prev, colsNow, expanded).length;
    heights.current.set(key, measured);
    return measured;
  }, [ensureRenderer, heightKey]);

  /**
   * Which width the REMAINDER of an entry must be printed at.
   *
   * Row numbers are width-relative, so a recorded width that this frame still legitimately
   * renders at is the only width whose row numbers can be trusted (`known`); anything else
   * is a reflow, and the caller starts over behind a seam row.
   */
  const resolvePrintWidth = useCallback((
    state: PrintedRows | undefined, wanted: number, known: readonly number[],
  ): number => {
    if (!state || state.cols === wanted) return wanted;
    return known.includes(state.cols) ? state.cols : wanted;
  }, []);

  /**
   * Print everything of `list[index]` that is not in the scrollback yet, in ONE go.
   *
   * The entry has left the region, so all of it may print; what is left is the remainder
   * behind the rows the top give-way already printed (`printed.rows`). A width change makes
   * those row numbers meaningless, so it prints a seam and starts over - a bounded
   * repetition instead of a hole.
   */
  const printRemainder = useCallback((
    list: readonly Entry[],
    index: number,
    wantedCols: number,
    known: readonly number[],
    expanded: readonly string[],
  ): void => {
    const entry = list[index]!;
    const state = printed.current.get(entry.id);
    if (state?.done) return;
    const width = resolvePrintWidth(state, wantedCols, known);
    const restart = state !== undefined && state.cols !== width;
    const from = restart ? 0 : state?.rows ?? 0;
    const body = ensureRenderer().renderEntryRows(
      entry, printableBefore(list, index), width, expanded.includes(entry.id),
    );
    const seam = restart ? reflowSeamRow(state!.rows, state!.cols, width) : null;
    const tail = body.slice(from);
    const capped = capPrintedRows(tail, from);
    enqueue(seam === null ? capped : [seam, ...capped], entry.id, entry.kind);
    printed.current.set(entry.id, { rows: body.length, cols: width, done: true });
  }, [enqueue, ensureRenderer, resolvePrintWidth]);

  /** Expanded ids of a frame, as a list so a callback does not depend on the object. */
  const expandedIdsOf = useCallback(
    (ids: Record<string, true>): string[] => Object.keys(ids).filter((id) => ids[id] === true),
    [],
  );

  /** The window as full-list indices (excluded entries already dropped), oldest first. */
  const windowItemsOf = useCallback((frame: CommittedFrame, start: number): WindowItem[] => {
    const items: WindowItem[] = [];
    for (let i = start; i < frame.entries.length; i += 1) {
      const entry = frame.entries[i]!;
      if (!isExcluded(entry)) items.push({ index: i, entry });
    }
    return items;
  }, []);

  /**
   * The window's measured rows, or `undefined` when the measurement cannot be trusted.
   *
   * TWO conditions, both structural rather than defensive. Every entry must be STABLE: an
   * entry the reducer may still rewrite has a height that changes, and printing part of it
   * would put a version of the answer into the scrollback that can never be corrected. And
   * the caller has already checked that the wall does not sit before the window: rows
   * behind an unprintable entry would land out of conversation order (I-S3), which is the
   * one mistake an append-only medium cannot take back.
   */
  const measureWindow = useCallback((
    frame: CommittedFrame, items: readonly WindowItem[],
  ): OverflowWindowEntry[] | undefined => {
    const last = frame.entries.length - 1;
    for (const item of items) {
      if (!isEntryStable(item.entry, frame.runActive, item.index === last)) return undefined;
    }
    const expanded = expandedIdsOf(frame.expandedToolIds);
    return items.map((item) => {
      const state = printed.current.get(item.entry.id);
      const comparable = state !== undefined && state.cols === frame.previewCols && !state.done;
      return {
        entry: item.entry,
        rows: measure(
          item.entry, printableBefore(frame.entries, item.index), frame.previewCols,
          expanded.includes(item.entry.id),
        ),
        printed: comparable ? state.rows : 0,
        stable: true,
      };
    });
  }, [expandedIdsOf, measure]);

  /** Promote `list[start..end)`; reports when it stopped early because the feed is full. */
  const promote = useCallback((
    frame: CommittedFrame, end: number, limit: number, known: readonly number[],
  ): { limited: boolean; used: number } => {
    const list = frame.entries;
    const expanded = expandedIdsOf(frame.expandedToolIds);
    let start = 0;
    const cursor = cursorRef.current;
    if (cursor && list[cursor.index]?.id === cursor.id) start = cursor.index + 1;
    let used = 0;
    let lastIndex = start - 1;
    const remember = (): void => {
      cursorRef.current = lastIndex >= 0 ? { id: list[lastIndex]!.id, index: lastIndex } : null;
    };
    for (let i = start; i < end; i += 1) {
      const entry = list[i]!;
      // A partially printed entry is NOT finished: it is processed until `done`, so a row
      // range the give-way left behind is still picked up here (P-5).
      if (isExcluded(entry) || printed.current.get(entry.id)?.done === true) {
        lastIndex = i;
        continue;
      }
      if (used >= limit) {
        remember();
        return { limited: true, used };
      }
      printRemainder(list, i, frame.contentCols, known, expanded);
      used += 1;
      lastIndex = i;
    }
    remember();
    return { limited: false, used };
  }, [expandedIdsOf, printRemainder]);

  /**
   * THE ONE PRINT LOOP (RV-P0-2 / RV-P2-12): every not-yet-printed entry of `list`,
   * oldest first, with no per-pass limit.
   *
   * `list` is a PARAMETER on purpose. `applyPendingReset` must pass `reset.captured` -
   * the snapshot taken BEFORE the reducer reset - because by the time the microtask
   * runs, `latest.current.entries` is already the NEW list and flushing that would
   * print zero rows: the entries that only ever existed on screen would vanish with
   * the reset. That is real data loss, not a cosmetic gap.
   *
   * `settleAllEntries` is the exit path's authority (everything that can ever print,
   * including an entry still streaming at this instant - printed is forever, and the
   * conversation is being destroyed right now, so a snapshot beats a hole). The drain
   * is FIFO, so the ORDER of the calls below is the order on screen.
   */
  const flushUnprinted = useCallback((list: readonly Entry[]): void => {
    if (!bridge) return;
    const known = [latest.current.contentCols, latest.current.previewCols];
    const expanded = expandedIdsOf(latest.current.expandedToolIds);
    for (const entry of settleAllEntries(list)) {
      if (printed.current.get(entry.id)?.done === true) continue;
      printRemainder(list, list.indexOf(entry), latest.current.contentCols, known, expanded);
    }
  }, [bridge, expandedIdsOf, printRemainder]);

  const applyPendingReset = useCallback((): void => {
    const reset = pendingReset.current;
    if (!reset || latest.current.entries === reset.captured) return;
    pendingReset.current = null;
    // ORDER IS THE CONTRACT (AC-F16): flush the OLD list, then the separator, then
    // forget what was printed. Clearing `printed` first would make the flush print
    // the whole conversation a second time.
    flushUnprinted(reset.captured);
    printed.current = new Map();
    cursorRef.current = null;
    enqueue([reset.kind === 'clear' ? CLEARED_ROW : RESTORED_ROW], `reset:${Date.now()}`, 'notice');
  }, [enqueue, flushUnprinted]);

  const pumpRef = useRef<() => void>(() => undefined);
  const schedulePump = useCallback((): void => {
    if (pumpQueued.current) return;
    pumpQueued.current = true;
    queueMicrotask(() => pumpRef.current());
  }, []);

  const continueOnDrain = useCallback((): void => {
    if (!bridge) return;
    bridge.drain.onDrained = () => {
      bridge.drain.onDrained = null;
      schedulePump();
    };
    bridge.requestFlush();
  }, [bridge, schedulePump]);

  /**
   * TOP GIVE-WAY: print the rows the box hides, when it hides them from the TOP.
   *
   * The order of the two decisions is not cosmetic. `frame.anchor` is what the SCREEN is
   * doing; `planOverflowPrint` answers what is off it. Printing while the frame is
   * `top`-anchored would print the rows the user is looking at (Ink clips the BOTTOM in that
   * branch) and leave the ones they cannot see - a duplicate and a hole at once. So a frame
   * whose anchor the measurement contradicts is nudged once and the print waits for the
   * frame that agrees.
   *
   * @returns How many segments were enqueued.
   */
  const printOverflow = useCallback((frame: CommittedFrame, allowance: number): number => {
    if (frame.tailRows <= 0) return 0;
    const maxEntries = SCROLLBACK_LIMITS.liveTailMaxEntries;
    const { start } = selectTailWindow(frame.entries, maxEntries);
    // The wall before the window is still a wall: the give-way would print rows that come
    // after an unprintable entry (I-S3 / A12).
    if (printBoundary(frame.entries, frame.runActive, maxEntries) < start) return 0;
    const items = windowItemsOf(frame, start);
    if (items.length === 0) return 0;
    const measured = measureWindow(frame, items);
    if (!measured) return 0;
    const total = measured.reduce((sum, item) => sum + item.rows, 0);
    if (frame.measuredRows !== total) {
      // `LiveTail` anchored this frame from an estimate (or from an older measurement).
      // Hand it the number, once per distinct picture, and print on the frame that agrees.
      const nudgeKey = `${start}|${items.length}|${total}`;
      if (nudgedRef.current !== nudgeKey) {
        nudgedRef.current = nudgeKey;
        bumpMeasureEpoch();
      }
    }
    if (frame.anchor !== 'bottom') return 0;
    const plan = planOverflowPrint(measured, frame.tailRows);
    const expanded = expandedIdsOf(frame.expandedToolIds);
    let used = 0;
    for (const segment of plan.segments) {
      if (used >= allowance) {
        continueOnDrain();
        return used;
      }
      const item = measured[segment.index]!;
      const state = printed.current.get(item.entry.id);
      // The segment's row numbers live in the box's index space, so the rows must be
      // rendered and printed at that width; a stale recorded width restarts behind a seam.
      const restart = state !== undefined && state.cols !== frame.previewCols;
      const from = restart ? 0 : state?.rows ?? 0;
      const body = ensureRenderer().renderEntryRows(
        item.entry, printableBefore(frame.entries, items[segment.index]!.index),
        frame.previewCols, expanded.includes(item.entry.id),
      );
      const slice = body.slice(from, Math.max(from, segment.toRow));
      const out = capPrintedRows(slice, from);
      const seam = restart ? reflowSeamRow(state!.rows, state!.cols, frame.previewCols) : null;
      enqueue(seam === null ? out : [seam, ...out], item.entry.id, item.entry.kind);
      const capped = out.length !== slice.length;
      const finished = capped || segment.toRow >= item.rows;
      printed.current.set(item.entry.id, {
        rows: finished ? item.rows : segment.toRow,
        cols: frame.previewCols,
        done: finished,
      });
      headRowsRef.current += out.length;
      used += 1;
    }
    return used;
  }, [continueOnDrain, enqueue, ensureRenderer, expandedIdsOf, measureWindow, windowItemsOf]);

  /** The promotion pass. Runs in a microtask (see the file header). */
  pumpRef.current = (): void => {
    pumpQueued.current = false;
    const frame = committed.current;
    if (!mountedRef.current || !bridge || !frame) return;
    applyPendingReset();
    const known = [frame.contentCols, frame.previewCols];
    const limit = Math.max(
      1, SCROLLBACK_LIMITS.feedCapacity - bridge.drain.pendingEntries() - 1,
    );
    // `printBoundary` = min(settled, window start): the region keeps what it shows.
    const end = printBoundary(frame.entries, frame.runActive, SCROLLBACK_LIMITS.liveTailMaxEntries);
    const promoted = promote(frame, end, limit, known);
    pruneEntryIds(frame.entries, printed.current, heights.current);
    if (promoted.limited) {
      // Continue once the writer has consumed what is queued (a restored transcript
      // longer than the feed is promoted in waves rather than folded into a marker).
      continueOnDrain();
      return;
    }
    // ORDER: everything that has left the window is older than everything in it, so the
    // give-way only ever runs in a pass that promoted everything it had to.
    if (printOverflow(frame, Math.max(0, limit - promoted.used)) > 0) bridge.requestFlush();
  };

  // --- Live region budget and the tail window. ------------------------------
  // The window is the last K printable entries, settled or not (D6/D7). `slice` +
  // `tailWindowStart` is `tail-window.ts`'s definition, and `printBoundary` uses the
  // same start - so "what is on screen" and "what is withheld from the writer" cannot
  // disagree about where the boundary is.
  const window = useMemo(
    () => selectTailWindow(entries, SCROLLBACK_LIMITS.liveTailMaxEntries),
    [entries],
  );
  const tailEntries = window.entries;
  const windowStart = window.start;
  // The band's hysteresis has exactly THREE reset points and no others: the plan
  // emptied, the dispatch finished, or the geometry changed (a new size is a new
  // measurement - the same treatment `App` gives `guardTripped`).
  if (heldGeometry.current.rows !== rows || heldGeometry.current.cols !== cols) {
    heldGeometry.current = { rows, cols };
    heldRailRows.current = 0;
    heldTeamRows.current = 0;
  }
  if (itemCount === 0) heldRailRows.current = 0;
  if (teamRowsNatural === 0) heldTeamRows.current = 0;

  const budget = useMemo(
    () =>
      enabled
        ? buildScrollbackBudget({
            rows, cols, draftRows, popupRows, statusExpanded, overlayOpen,
            forceInactive,
            band: {
              itemCount, panelEnabled, teamRowsNatural,
              heldRailRows: heldRailRows.current, heldTeamRows: heldTeamRows.current,
            },
          })
        : null,
    // The two band refs are read at memo time; `itemCount` and `teamRowsNatural` are
    // what move them. The budget no longer depends on CONTENT at all (the band fills the
    // pool, D5), so nothing about the transcript belongs in this dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, rows, cols, draftRows, popupRows, statusExpanded, overlayOpen,
      forceInactive, itemCount, panelEnabled, teamRowsNatural],
  );
  if (budget) {
    // Monotone memory, fed back into the memo above on the next frame.
    heldRailRows.current = budget.band.heldRailRows;
    heldTeamRows.current = budget.band.heldTeamRows;
  }
  // Print keeps `contentCols`; only the live tail gives up the rail's columns (I-5).
  const previewCols = budget ? budget.previewCols : contentCols;
  const tailRows = budget ? budget.liveTailRows : 0;
  // `previewCols` is only known after the budget, so the copy above carries the PREVIOUS
  // frame's value; this line hands the exit and reset paths the current one. The promotion
  // pass does not read it - it reads `committed`, written below.
  latest.current.previewCols = previewCols;

  const lastIndex = entries.length - 1;
  const indexById = useMemo(
    () => new Map(entries.map((entry, index) => [entry.id, index])),
    [entries],
  );

  /**
   * The window's measured height, when every entry in it is stable AND already measured at
   * this geometry. This is the number `LiveTail` anchors with, and the number the pump
   * compares itself against, so both agree about which frame the user is looking at.
   */
  const measuredTailRows = useMemo((): number | undefined => {
    if (!enabled || tailRows <= 0 || tailEntries.length === 0) return undefined;
    let total = 0;
    for (const entry of tailEntries) {
      if (!isEntryStable(entry, runActive, indexById.get(entry.id) === lastIndex)) {
        return undefined;
      }
      const cached = heights.current.get(
        heightKey(entry, previewCols, expandedToolIds[entry.id] === true),
      );
      if (cached === undefined) return undefined;
      total += cached;
    }
    return total;
    // `heights` is a ref and `measureEpoch` is what fills it; every OTHER dependency is an
    // input of the cache key, so a stale answer is impossible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, tailRows, tailEntries, runActive, indexById, lastIndex, previewCols,
    expandedToolIds, thinkingVisible, measureEpoch, heightKey]);

  const anchor = resolveTailAnchor({
    entries: tailEntries,
    budgetRows: tailRows,
    rowOf: (entry: Entry): number =>
      estimateEntryRows(entry, previewCols, density, expandedToolIds[entry.id] === true,
        thinkingVisible),
    measuredRows: measuredTailRows,
  });

  const liveTailLines = useMemo(
    () =>
      enabled && budget && budget.liveTailRows > 0
        ? buildLivePreview({
          unsettled: tailEntries, cols: previewCols, rows: budget.liveTailRows,
          thinkingVisible,
        })
        : [],
    [enabled, budget, tailEntries, previewCols, thinkingVisible],
  );

  // THE COMMIT HOOK. Every commit records the frame the screen is showing, so the microtask
  // pass can never slice this frame's picture with another frame's numbers. It is the last
  // layout effect in this hook on purpose: everything above is render-time state.
  useLayoutEffect(() => {
    committed.current = {
      entries, runActive, contentCols, previewCols, tailRows, anchor, measuredRows: measuredTailRows,
      expandedToolIds,
    };
  });

  // Only a content change (or a measurement that must reach `LiveTail`) needs a pass; a
  // resize is the writer's business, exactly as before.
  useLayoutEffect(() => {
    if (enabled && bridge) schedulePump();
  }, [enabled, bridge, entries, runActive, measureEpoch, schedulePump]);

  const settleAll = useCallback((): void => {
    flushUnprinted(latest.current.entries);
  }, [flushUnprinted]);

  // Shutdown hook for the exit paths. `restore()` runs it AFTER the tree is gone
  // (normal exit) or while it is alive (signal), so it renders synchronously and then
  // releases the offscreen instance. The unmount cleanup deliberately renders nothing:
  // it runs inside the main tree's commit, where an offscreen render is deferred.
  const settleAllRef = useRef(settleAll);
  settleAllRef.current = settleAll;
  useEffect(() => {
    mountedRef.current = true;
    if (!enabled || !bridge) return undefined;
    bridge.settleAllNow = () => {
      try {
        settleAllRef.current();
      } finally {
        rendererRef.current?.dispose();
        rendererRef.current = null;
      }
    };
    return () => { mountedRef.current = false; };
  }, [enabled, bridge]);

  const reprintExpanded = useCallback((entryId: string): boolean => {
    if (!enabled || !bridge) return false;
    const list = latest.current.entries;
    const index = list.findIndex((entry) => entry.id === entryId);
    if (index < 0) return false;
    const entry = list[index]!;
    // A LIVE DISPATCH CARD IS REFUSED, NOT PRINTED (tui-subagent-double-roster A-2').
    // `Ctrl+O` arrives mid-dispatch, `EntryView` suppresses this card, and a copy
    // printed here would be a FROZEN SNAPSHOT of a card the roster is still rewriting -
    // permanently in the scrollback, because printed is forever.
    if (isLiveTeamCard(entry)) return false;
    // THE COPY IS RENDERED IN A MICROTASK, NOT IN THE KEY HANDLER THAT ASKED FOR IT.
    // `Ctrl+O` arrives on the stdin stream, and an offscreen render issued from there is
    // SCHEDULED rather than flushed - the reconciler sees a pending update, the frame the
    // caller reads back is still empty, and the copy degrades to
    // `[aragon] entry ... could not be rendered`. A microtask runs after the input handler
    // has unwound, where the offscreen render is synchronous again: the same rule the
    // promotion pass follows (see the file header). The answer is therefore "this entry
    // exists and a copy is on its way", which is what the caller's toast needs.
    //
    // THE ID IS STABLE ON PURPOSE. `expanded:<entryId>` makes the copy greppable and keeps
    // the key purely user-driven; it is not a dedupe key, because the drain is a FIFO that
    // never coalesces, so a second press prints a second copy - the behaviour the tool cards
    // have always had, and the reason the stable id is safe to use here.
    queueMicrotask(() => {
      if (!mountedRef.current || !bridge) return;
      const body = ensureRenderer().renderEntry(entry, undefined, latest.current.contentCols, true);
      if (body.length === 0) return;
      enqueue(
        [`-- expanded: ${expandedLabel(entry)} --`, ...body],
        `expanded:${entryId}`, entry.kind,
      );
    });
    return true;
  }, [bridge, enabled, enqueue, ensureRenderer]);

  const notifyReset = useCallback((kind: ScrollbackResetKind): void => {
    if (!enabled) return;
    // The PRE-reset snapshot: see `flushUnprinted`'s note on why this cannot be read
    // from `latest` when the microtask finally runs.
    pendingReset.current = { kind, captured: latest.current.entries };
  }, [enabled]);

  return {
    budget, liveTailLines, tailEntries, windowStart, measuredTailRows,
    // A GETTER, like `perfRef`'s `scrollbar`: the counter moves in a microtask, so a value
    // captured at render time would report the frame BEFORE the one `/perf` is asked about.
    get headRows() { return headRowsRef.current; },
    reprintExpanded, settleAll, notifyReset,
  };
}
