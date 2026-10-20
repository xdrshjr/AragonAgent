/**
 * ScrollbackWriter — the byte contract of native-scroll mode
 * (tui-native-terminal-scroll §4.3, extended by tui-bottom-anchored-live-region
 * and re-based on a CANVAS by tui-canvas-bottom-anchor).
 *
 * It implements `FrameDiffer`, so `stdout-frame-writer.ts::wrapStdoutForFrames`
 * binds it to a real stream exactly as it binds the full-screen differ. What it
 * does differently: the screen is NOT the app's. Settled conversation rows are
 * printed into the host terminal's own scrollback, and Ink's frame is only a small
 * LIVE REGION parked under the last printed row.
 *
 * GEOMETRY IS RELATIVE (D2/D4). A batch is `CUU(canvasRows)` to the top of the
 * previous CANVAS, erase down, skip the gap, print the content rows, print the
 * region, park on the last row. Nothing needs the terminal's absolute row count, so
 * a terminal that scrolls underneath cannot misplace anything.
 *
 * THE CANVAS (tui-canvas-bottom-anchor D1/D3). The `rows - 1` rows above the parked
 * row belong to the writer and are always laid out top-down as
 * `[gap][content][region]`. The previous feature put its blank rows between the
 * content and the region (`[content][pad][region]`), which is why a short
 * conversation left a reply floating far above the composer. The blank space now
 * lives above every visible content row, so the newest printed row always touches
 * the top row of the live region, while the composer stays on the last two rows.
 * The gap is SKIPPED with CUD and never written, so a blank row can never be pushed
 * into the scrollback (I-B3).
 *
 * THE PRICE, and it is the only one: the content rows still on the canvas can be
 * re-drawn when the layout changes (a region collapse, a longer draft), because the
 * rows that the region gives back have to move onto the canvas top. That is why the
 * writer keeps a bounded cache of them (`held`, at most `capacity - H` rows). A row
 * that leaves the canvas — pushed into the scrollback or erased at exit — is never
 * written again, so the history the user scrolls through is exactly what was
 * printed, once (I-B5). `anchor: unknown` (nothing measured: no TTY, no filter, no
 * CPR answer) keeps the pre-feature bytes exactly, which is what keeps the old byte
 * tests meaningful (I-B7).
 *
 * THE INVARIANTS THAT FAIL SILENTLY IF DROPPED:
 *  - I-S4 · every batch parks the cursor one row below the region, column 0, the
 *    same place Ink's `previousLineCount = H + 1` expects.
 *  - I-S8 · geometry in doubt (foreign write, unparseable chunk) => `prev = null`
 *    => next batch is a SEED. Never keep erasing on a stale height.
 *  - I-S14 · after `finalize` EVERY Ink write is swallowed.
 *  - I-S13 · no emitted row is wider than `cols - 1` (clipped, counted).
 *  - I-B1 · a batch ends parked on `rows - 1`, which is what the next `CUU` assumes.
 *  - I-B3 · blank rows only ever exist as SKIPPED rows, and a batch that scrolls has
 *    `gap = 0`, so the scrollback never receives an empty row from this file.
 *  - I-B5 · `held` is a contiguous suffix of the printed content, and `dropped` is
 *    exactly the number of rows this batch pushed off the top. The BYTES carry the
 *    untrimmed content: the terminal can only scroll away rows it was given.
 *  - I-B14 · a re-measurement re-derives `capacity` from `spaceBelow + canvasRows`,
 *    never from `spaceBelow` alone: the canvas itself still owns the rows above the
 *    cursor, and forgetting them makes the next batch read its own screen as an
 *    overflow and print every visible row a second time.
 *  - I-B15 · every batch starts by reconciling `top + capacity` with the live
 *    `rows - 1` (a resize event can arrive one frame late), and a column change
 *    resets before it writes.
 *  - I-A9 · the writer never writes a probe byte; it only asks the host, which owns
 *    deferral, coalescing and the death switch.
 */

import type { FrameDiffer, FrameWriterStats } from '../frame-differ.js';
import { parseInkFrame } from '../frame-parser.js';
import {
  clampSpaceBelow,
  resolveCanvasLayout,
  screenCapacity,
  UNKNOWN_CANVAS,
  applyResizeGrowth,
  type AnchorSource,
  type CanvasAnchor,
  type CanvasLayout,
} from './canvas.js';
import type { ScrollbackDrain } from './drain.js';
import { SCROLLBACK_LIMITS } from './limits.js';
import {
  canvasBytes,
  canvasSeedBytes,
  clipLine,
  diffBytes,
  finalizeBytes,
  fullBytes,
  seedBytes,
} from './writer-shapes.js';

/** `ansiEscapes.clearTerminal` — Ink's tall-frame write. It contains `ESC[3J`. */
const CLEAR_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';

/** Which entry point asked for this batch; only counters and shape choice differ. */
type BatchMode = 'frame' | 'repaint';

export interface ScrollbackWriterOptions {
  rows: () => number | undefined;
  cols: () => number | undefined;
  /** DEC 2026 envelope around each batch. */
  sync: boolean;
  /** `diffRender: false` — every batch rewrites the whole region. */
  fullEveryFrame: boolean;
  drain: ScrollbackDrain;
  /** Raised once on the first foreign / unparseable write. */
  onFirstFallback?: () => void;
  /** Raised when out-of-resize tall frames repeat; the App degrades to a placeholder. */
  onGuardTrip?: () => void;
  /**
   * Ask the host to call `repaint()` soon (coalesced here). Used when static rows
   * arrive without a new Ink frame, and to flush the rest of an oversized feed.
   */
  requestRepaint?: () => void;
  /**
   * Ask the host for one more cursor measurement (resize settled, geometry lost).
   *
   * CONTRACT (P0-3), and the writer does NOT implement any of it: the call can
   * arrive from inside Ink's `stdout.write` (`invalidate` is called by
   * `transform`), so the host MUST defer it with `setImmediate`, MUST coalesce
   * everything inside the window into one `ESC[6n`, and MUST drop it after
   * `finalize`/`dispose`/`exit` — a probe written at a terminal already handed
   * back to the shell leaks `^[[12;1R` onto the user's prompt (I-A9).
   */
  requestAnchorProbe?: () => void;
  /** Injected clock for the resize grace window. */
  now?: () => number;
}

export interface ScrollbackWriterStats {
  framesSeed: number;
  framesDiff: number;
  framesFull: number;
  staticRowsWritten: number;
  bytesWritten: number;
  fallbacks: number;
  /** Tall frames swallowed (the scrollback-erasing `ESC[3J` path), resize or not. */
  guardHits: number;
  /** The subset NOT explained by a recent resize: the real defect signal. */
  guardHitsOutsideResize: number;
  clippedRows: number;
  elidedEntries: number;
  resizes: number;
  repaints: number;
  /** Where the anchor came from: `probe`, one-off `fill`, or never measured. */
  anchorSource: AnchorSource;
  /** Canvas height of the most recent batch — the next erase distance (0 = unknown). */
  anchorCanvasRows: number;
  /** Content rows inside that canvas. */
  anchorHeldRows: number;
  /** Blank rows above the content in that canvas. */
  anchorGapRows: number;
  /** Rows this session pushed into the scrollback (the "is it scrolling" signal). */
  anchorScrollRows: number;
  /** Times the geometry was dropped on purpose (column change, shrink, gap lost). */
  anchorResets: number;
  /** Measurements accepted AFTER the first one — the re-probe count (not resize events). */
  anchorReprobes: number;
}

export interface CanvasStats {
  /** `'pinned'` = measured, drawing a canvas; `'unknown'` = legacy append path. */
  state: 'pinned' | 'unknown';
  /** Probe / fill origin; `'none'` = never measured. */
  source: AnchorSource;
  /** Rows of the most recent canvas (0 while unknown). */
  canvasRows: number;
  /** Content rows inside it. */
  heldRows: number;
  /** Blank rows above the content. */
  gapRows: number;
  /** Canvas top row (0 = the canvas starts at the first screen row). */
  top: number;
}

export interface ScrollbackWriter extends FrameDiffer {
  /** Idempotent. Returns the exit bytes; afterwards every Ink write is swallowed. */
  finalize(summary: readonly string[]): string;
  /**
   * Rows of the LIVE REGION as last parked — the frame height `H`, NOT the canvas
   * (P1-4). `/perf` prints this as "scrollback region N rows", and it has to keep
   * meaning the same number; the canvas height is `anchorStats().canvasRows`.
   */
  regionRows(): number;
  scrollbackStats(): ScrollbackWriterStats;
  /**
   * The host measured how many blank rows are left below the parked cursor
   * (`0` = already on the last row). Writes no bytes; the next batch — or the
   * `repaint()` the host schedules right after — consumes it.
   *
   * Idempotent and overwritable: the post-resize re-probe calls it again, and it
   * must then arrive at the SAME capacity the resize delta did (I-B14). Side
   * effect: sets `anchorDirty`, which is what lets `repaint()` redraw while the
   * feed is idle (P0-2).
   */
  setAnchorSpaceBelow(spaceBelow: number, source: AnchorSource): void;
  /** For `/perf` and tests. Produces no bytes. */
  anchorStats(): CanvasStats;
}

export function createScrollbackWriter(o: ScrollbackWriterOptions): ScrollbackWriter {
  const now = o.now ?? Date.now;
  const maxBatch = SCROLLBACK_LIMITS.maxRowsPerBatch;

  /** Where the bottom of the screen is, as far as anything has measured it. */
  let anchor: CanvasAnchor = UNKNOWN_CANVAS;
  /** Content rows still on the canvas, oldest first, already clipped (I-B9). */
  let held: string[] = [];
  /** Gap rows of the previous batch. */
  let gapRows = 0;
  /** Frame rows of the previous batch (`regionRows()`). */
  let frameRows = 0;
  /** Canvas height of the previous batch = the erase distance. */
  let canvasRows = 0;
  /** The canvas as it stands on screen (`''` = a skipped gap row), or null if lost. */
  let prev: string[] | null = null;
  /** The last frame BEFORE clipping, so unchanged rows are not re-measured. */
  let prevRawFrame: string[] | null = null;
  /** The last frame AFTER clipping, aligned with `prevRawFrame` (P2-3). */
  let prevClippedFrame: string[] | null = null;
  let everWritten = false;
  let seenAnyChunk = false;
  let finalized = false;
  let guardTripped = false;
  let consecutiveGuard = 0;
  let lastResizeAt = Number.NEGATIVE_INFINITY;
  /** Width the previous canvas was written at, for the column-change reset. */
  let lastWriteCols: number | undefined;
  /** Terminal height at the previous batch: the basis of a resize delta. */
  let lastRows: number | undefined;
  let repaintQueued = false;
  let anchorSource: AnchorSource = 'none';
  /** A fresh measurement is waiting to be consumed by the next write. */
  let anchorDirty = false;
  let anchorReprobes = 0;
  let scrolledRows = 0;
  /**
   * Rows between the cursor and the canvas top for the NEXT seed, when the canvas is
   * shorter than the measured space below the cursor (a terminal taller than
   * `maxCanvasRows`). Zero in every other state, because a canvas that exists has its
   * top above the parked cursor by construction.
   */
  let seedDownToTop = 0;

  const stats: ScrollbackWriterStats = {
    framesSeed: 0, framesDiff: 0, framesFull: 0, staticRowsWritten: 0, bytesWritten: 0,
    fallbacks: 0, guardHits: 0, guardHitsOutsideResize: 0, clippedRows: 0, elidedEntries: 0,
    resizes: 0, repaints: 0, anchorSource: 'none', anchorCanvasRows: 0, anchorHeldRows: 0,
    anchorGapRows: 0, anchorScrollRows: 0, anchorResets: 0, anchorReprobes: 0,
  };

  const liveCols = (): number | undefined => {
    const cols = o.cols();
    return cols !== undefined && Number.isFinite(cols) && cols >= 1 ? Math.floor(cols) : undefined;
  };
  const liveRows = (): number | undefined => {
    const rows = o.rows();
    return rows !== undefined && Number.isFinite(rows) ? Math.floor(rows) : undefined;
  };

  const scheduleRepaint = (): void => {
    if (!o.requestRepaint || repaintQueued || finalized) return;
    repaintQueued = true;
    // Deferred by the host (setImmediate): this can fire from inside Ink's write.
    o.requestRepaint();
  };

  /**
   * Ask for a measurement. Never writes anything itself, and never after `finalize`
   * (I-A9): the host owns the deferral, the coalescing and the death switch.
   */
  const requestProbe = (): void => {
    if (finalized || anchorSource === 'none') return;
    o.requestAnchorProbe?.();
  };

  /** Report what the canvas looks like right now. Produces no bytes. */
  const publishAnchorStats = (): void => {
    const pinned = anchor.kind === 'pinned';
    stats.anchorSource = anchorSource;
    stats.anchorCanvasRows = pinned ? canvasRows : 0;
    stats.anchorHeldRows = pinned ? held.length : 0;
    stats.anchorGapRows = pinned ? gapRows : 0;
    stats.anchorScrollRows = scrolledRows;
    stats.anchorReprobes = anchorReprobes;
  };

  /**
   * Drop the canvas and go back to the append path (D5, I-B8, I-A3).
   *
   * Shared by a column change, a shrink, `invalidate()` and a lost geometry: all
   * four have the same safe answer, "re-measure and print nothing until then".
   * The rows already on screen are NOT redrawn — they are not where the cache says
   * they are, and a wrong erase both duplicates and destroys user-visible content.
   */
  const reset = (): void => {
    prev = null;
    prevRawFrame = null;
    prevClippedFrame = null;
    held = [];
    gapRows = 0;
    canvasRows = 0;
    seedDownToTop = 0;
    anchor = UNKNOWN_CANVAS;
    anchorDirty = false;
    stats.anchorResets += 1;
    publishAnchorStats();
    requestProbe();
  };

  /** Clip a frame row to `cols - 1`, reusing the previous result for unchanged rows. */
  const clipFrame = (raw: readonly string[], cols: number | undefined): string[] => {
    if (cols === undefined) return [...raw];
    const limit = cols - 1;
    return raw.map((line, i) => {
      const cached = prevClippedFrame?.[i];
      if (cached !== undefined && prevRawFrame?.[i] === line) return cached;
      const result = clipLine(line, limit);
      if (result.clipped) stats.clippedRows += 1;
      return result.text;
    });
  };

  const clipStatics = (rows: readonly string[], cols: number | undefined): readonly string[] => {
    if (cols === undefined || rows.length === 0) return rows;
    return rows.map((line) => {
      const result = clipLine(line, cols - 1);
      if (result.clipped) stats.clippedRows += 1;
      return result.text;
    });
  };

  const record = (
    bytes: string, shape: 'seed' | 'diff' | 'full' | 'repaint', statics: number,
  ): string => {
    if (shape === 'seed') stats.framesSeed += 1;
    else if (shape === 'diff') stats.framesDiff += 1;
    else if (shape === 'full') stats.framesFull += 1;
    else stats.repaints += 1;
    stats.staticRowsWritten += statics;
    stats.bytesWritten += bytes.length;
    return bytes;
  };

  /**
   * Bring `top + capacity` back in line with the live `rows - 1` BEFORE the batch
   * reads either of them (§6.11, [P0-2]).
   *
   * The `resize` event is dispatched a libuv turn after `stdout.rows` changed, so a
   * frame can arrive on the new grid while the anchor still describes the old one.
   * The pre-canvas writer healed that one batch later, by deriving `gap` from the
   * current height; a canvas cannot, because `top` and `capacity` only ever change
   * where they are measured — and the batch that ran on the stale grid would record
   * the new height, leaving the late `onResize` with a delta of zero. On a terminal
   * that never answers CPR that is a composer stuck mid-screen for the session.
   */
  const reconcile = (rows: number, cols: number | undefined): void => {
    if (anchor.kind !== 'pinned') return;
    if (cols !== undefined && lastWriteCols !== undefined && cols !== lastWriteCols) {
      reset();
      return;
    }
    const capacity = screenCapacity(rows);
    const parked = anchor.top + anchor.capacity;
    if (capacity === parked) return;
    if (capacity > parked) {
      // The terminal grew below the cursor: the cursor did not move, so the canvas
      // owns exactly the extra rows.
      anchor = { kind: 'pinned', top: anchor.top, capacity: anchor.capacity + (capacity - parked) };
      lastRows = rows;
      return;
    }
    reset();
  };

  const afterCanvasBatch = (
    layout: CanvasLayout, heldNext: readonly string[], frame: readonly string[],
    raw: readonly string[], cols: number | undefined, rows: number,
  ): void => {
    prev = [...new Array<string>(layout.gap).fill(''), ...heldNext, ...frame];
    prevRawFrame = [...raw];
    prevClippedFrame = [...frame];
    canvasRows = prev.length;
    held = [...heldNext];
    gapRows = layout.gap;
    frameRows = frame.length;
    anchor = { kind: 'pinned', top: layout.top, capacity: layout.canvasRows };
    everWritten = true;
    lastWriteCols = cols;
    lastRows = rows;
    anchorDirty = false;
    seedDownToTop = 0;
    scrolledRows += layout.scroll;
    publishAnchorStats();
    // A feed larger than one batch continues on the next tick, region still parked.
    if (o.drain.pending() > 0) {
      repaintQueued = false;
      scheduleRepaint();
    }
  };

  const afterLegacyBatch = (
    raw: readonly string[], frame: readonly string[], cols: number | undefined, rows: number,
  ): void => {
    prev = [...frame];
    prevRawFrame = [...raw];
    prevClippedFrame = [...frame];
    // The region IS the erasable block on this path, which is also the number a
    // later measurement needs in order to know how far above the cursor its top is.
    canvasRows = frame.length;
    gapRows = 0;
    frameRows = frame.length;
    held = [];
    everWritten = true;
    lastWriteCols = cols;
    lastRows = rows;
    anchorDirty = false;
    publishAnchorStats();
    if (o.drain.pending() > 0) {
      repaintQueued = false;
      scheduleRepaint();
    }
  };

  /**
   * The pre-canvas append path: static rows above a region that is never redrawn.
   * Byte-identical to the writer before either anchor existed (I-B7): `seedBytes` /
   * `fullBytes` / `diffBytes`, `eraseUp = canvasRows` (= the frame height).
   */
  const assembleLegacy = (
    raw: readonly string[], statics: readonly string[], frame: readonly string[],
    rows: number, cols: number | undefined, mode: BatchMode,
  ): string => {
    let out: string;
    if (prev === null) {
      out = record(
        seedBytes({ lines: frame, statics, sync: o.sync, reseed: everWritten }),
        'seed', statics.length,
      );
    } else if (mode === 'repaint') {
      out = record(
        fullBytes({ lines: frame, statics, eraseUp: canvasRows, sync: o.sync }),
        'repaint', statics.length,
      );
    } else if (statics.length > 0 || frame.length !== canvasRows || o.fullEveryFrame) {
      out = record(
        fullBytes({ lines: frame, statics, eraseUp: canvasRows, sync: o.sync }),
        'full', statics.length,
      );
    } else {
      out = record(diffBytes({ lines: frame, prev, sync: o.sync }), 'diff', 0);
    }
    afterLegacyBatch(raw, frame, cols, rows);
    return out;
  };

  /**
   * A canvas batch repaints EVERYTHING when the layout moved, and only the rows that
   * differ when it did not. `layout.scroll > 0` forces the full shape for a reason
   * the other four conditions do not cover: when the canvas is already the whole
   * screen its height cannot change, so a batch that pushes rows out would otherwise
   * be diffed against rows it has just lost.
   */
  const needsCanvasShape = (
    layout: CanvasLayout, frame: readonly string[], statics: number, mode: BatchMode,
  ): boolean => {
    if (mode === 'repaint') return true;
    return statics > 0 || layout.scroll > 0 || layout.gap !== gapRows ||
      layout.canvasRows !== canvasRows || frame.length !== frameRows || o.fullEveryFrame;
  };

  const emitCanvas = (
    layout: CanvasLayout, content: readonly string[], kept: readonly string[],
    frame: readonly string[], statics: number, mode: BatchMode,
  ): string => {
    if (prev === null) {
      return record(
        canvasSeedBytes({
          downToTop: seedDownToTop,
          gap: layout.gap, held: content, lines: frame, sync: o.sync, reseed: everWritten,
        }),
        'seed', statics,
      );
    }
    if (needsCanvasShape(layout, frame, statics, mode)) {
      return record(
        canvasBytes({
          eraseUp: canvasRows, gap: layout.gap, held: content, lines: frame, sync: o.sync,
        }),
        mode === 'repaint' ? 'repaint' : 'full', statics,
      );
    }
    const shown = [...new Array<string>(layout.gap).fill(''), ...kept, ...frame];
    return record(diffBytes({ lines: shown, prev, sync: o.sync }), 'diff', 0);
  };

  /**
   * THE ONE PLACE THE GEOMETRY IS COMPUTED (§6.2), shared by `transform` and
   * `repaint` so the two can never disagree about where the region goes.
   *
   * Order is load-bearing: reconcile, then static rows, then the layout, then the
   * bytes. `ED0`, the gap, the content, the region — in that order, always.
   */
  const assemble = (
    raw: readonly string[], rows: number, cols: number | undefined, mode: BatchMode,
  ): string => {
    reconcile(rows, cols);
    const statics = clipStatics(o.drain.takeUpTo(maxBatch), cols);
    const frame = clipFrame(raw, cols);
    if (anchor.kind === 'unknown') {
      return assembleLegacy(raw, statics, frame, rows, cols, mode);
    }
    const layout = resolveCanvasLayout({
      capacity: anchor.capacity,
      top: anchor.top,
      heldRows: held.length,
      statRows: statics.length,
      frameRows: frame.length,
      lead: prev === null && everWritten ? 1 : 0,
    });
    // The bytes carry every content row; the ones that do not fit leave through the
    // bottom, and the terminal can only scroll away rows it was given. `held` keeps
    // the suffix that is still on screen (I-B5).
    const content = held.concat(statics);
    const kept = layout.dropped > 0 ? content.slice(layout.dropped) : content;
    const out = emitCanvas(layout, content, kept, frame, statics.length, mode);
    afterCanvasBatch(layout, kept, frame, raw, cols, rows);
    return out;
  };

  const swallowTallFrame = (): string => {
    stats.guardHits += 1;
    if (now() - lastResizeAt >= SCROLLBACK_LIMITS.guardResizeGraceMs) {
      stats.guardHitsOutsideResize += 1;
      consecutiveGuard += 1;
      if (consecutiveGuard >= SCROLLBACK_LIMITS.guardTripCount && !guardTripped) {
        guardTripped = true;
        o.onGuardTrip?.();
      }
    }
    // Swallow the whole chunk: it would clear the visible screen AND scrollback.
    return '';
  };

  const countFallback = (counted: boolean): null => {
    reset();
    if (counted) {
      stats.fallbacks += 1;
      if (stats.fallbacks === 1) o.onFirstFallback?.();
    }
    return null;
  };

  /**
   * Ink wrote a frame we cannot address (a one-row terminal). Record only what the
   * FRAME tells us (P2-6): a frame is not a canvas, so on the append path it is the
   * block (`canvasRows = H`), and on the canvas path nothing survives but the fact
   * that the geometry is lost.
   */
  const passThrough = (lines: string[] | null): void => {
    if (lines === null) return;
    prevRawFrame = lines;
    prevClippedFrame = lines;
    frameRows = lines.length;
    if (anchor.kind === 'pinned') {
      reset();
      return;
    }
    prev = lines;
    canvasRows = lines.length;
    gapRows = 0;
  };

  const transform = (chunk: string): string | null => {
    if (finalized) return '';
    if (chunk.startsWith(CLEAR_TERMINAL)) return swallowTallFrame();
    consecutiveGuard = 0;
    guardTripped = false;

    const firstChunk = !seenAnyChunk;
    seenAnyChunk = true;
    const rows = liveRows();
    const lines = parseInkFrame(chunk);

    if (rows === undefined || rows < 2) {
      passThrough(lines);
      return null;
    }
    if (lines === null) return countFallback(!firstChunk);
    if (lines.length + 1 > rows) {
      // Unreachable by construction (I-S1); never erase on a guess.
      reset();
      return '';
    }
    return assemble(lines, rows, liveCols(), 'frame');
  };

  const repaint = (): string => {
    repaintQueued = false;
    if (finalized || prevClippedFrame === null || prevRawFrame === null) return '';
    // `anchorDirty` is why a probe result arriving while the feed is idle lands at
    // all: without it, "re-pin after a resize" would write zero bytes (P0-2).
    if (o.drain.pending() === 0 && !anchorDirty) return '';
    const rows = liveRows();
    if (rows === undefined || rows < 2) return '';
    return assemble(prevRawFrame, rows, liveCols(), 'repaint');
  };

  const finalize = (summary: readonly string[]): string => {
    if (finalized) return '';
    finalized = true;
    const pending = clipStatics(o.drain.takeAll(), liveCols());
    // Unknown geometry after a foreign write: no safe erase, start on a fresh line.
    // Otherwise erase the whole CANVAS — the gap included, or its blank rows stay
    // behind as a dead band above the summary (I-B11).
    const eraseUp = prev === null && everWritten ? -1 : canvasRows;
    // ... and reprint what the erase removes. The content rows live INSIDE the canvas,
    // so erasing it without them would delete the user's last screenful of conversation
    // at exactly the moment they want to read it (the pre-canvas writer never had to:
    // its static rows were already outside the erasable block).
    const bytes = finalizeBytes({ eraseUp, statics: [...held, ...pending], summary });
    stats.staticRowsWritten += pending.length;
    stats.bytesWritten += bytes.length;
    return bytes;
  };

  o.drain.onEnqueue = scheduleRepaint;

  return {
    transform,
    repaint,
    finalize,
    invalidate: reset,
    onResize(): void {
      stats.resizes += 1;
      lastResizeAt = now();
      consecutiveGuard = 0;
      guardTripped = false;
      const rowsNow = liveRows();
      const colsNow = liveCols();
      // A column change re-flows what is already on screen: the cached rows no longer
      // describe it, and erasing by their height would cut a line in half (D5).
      if (colsNow !== undefined && lastWriteCols !== undefined && colsNow !== lastWriteCols) {
        reset();
        return;
      }
      if (rowsNow !== undefined && lastRows !== undefined) {
        if (rowsNow < lastRows) {
          // The terminal deleted rows; they are gone and must not be redrawn.
          reset();
          return;
        }
        if (anchor.kind === 'pinned') {
          const capacity = screenCapacity(rowsNow);
          const grown = Math.min(
            applyResizeGrowth(anchor.capacity, lastRows, rowsNow), capacity,
          );
          anchor = { kind: 'pinned', top: Math.max(0, capacity - grown), capacity: grown };
        }
        lastRows = rowsNow;
      }
      // Coalesced and deferred by the host (P0-3); `anchorReprobes` is NOT bumped
      // here — a drag fires dozens of resize events for one probe (P1-5).
      requestProbe();
    },
    cursorNeutralWrite(): void {
      // OSC 52 and friends move no cell and no cursor (I-S11).
    },
    regionRows: () => Math.max(0, frameRows),
    scrollbackStats: () => ({ ...stats, elidedEntries: o.drain.elided() }),
    setAnchorSpaceBelow(spaceBelow: number, source: AnchorSource): void {
      if (finalized) return;
      const rows = liveRows();
      const capacity = screenCapacity(rows);
      // I-B14: the report is "rows BELOW the cursor", and the canvas also still owns
      // `canvasRows` rows ABOVE it, so the reachable height is their sum. Keeping only
      // the first term collapses the canvas onto the parked row, and the next batch
      // then reads its own visible content as an overflow and scrolls it away twice.
      const reach = clampSpaceBelow(spaceBelow, rows) + canvasRows;
      // The cap bounds only a STARTING canvas: clipping a live one would make the
      // next erase reach above its own top (see SCROLLBACK_LIMITS.maxCanvasRows).
      const ceiling = canvasRows === 0
        ? Math.min(capacity, SCROLLBACK_LIMITS.maxCanvasRows)
        : capacity;
      const usable = Math.max(0, Math.min(reach, ceiling));
      anchor = { kind: 'pinned', top: Math.max(0, capacity - usable), capacity: usable };
      // A capped starting canvas begins BELOW the cursor row, so the batch that seeds
      // it has to descend first: `spaceBelow - capacity` rows. Zero whenever the cap
      // does not bind, and zero for every canvas that already exists.
      seedDownToTop = Math.max(0, clampSpaceBelow(spaceBelow, rows) - usable);
      // Only measurements AFTER the first are re-probes (P1-5): `/perf` promises a
      // re-probe count, not a measurement count, and the startup measurement is
      // reported through `anchorSource` instead.
      if (anchorSource !== 'none') anchorReprobes += 1;
      anchorSource = source;
      anchorDirty = true;
      publishAnchorStats();
    },
    anchorStats: () => ({
      state: anchor.kind === 'pinned' ? 'pinned' : 'unknown',
      source: anchorSource,
      canvasRows: anchor.kind === 'pinned' ? canvasRows : 0,
      heldRows: anchor.kind === 'pinned' ? held.length : 0,
      gapRows: anchor.kind === 'pinned' ? gapRows : 0,
      top: anchor.kind === 'pinned' ? anchor.top : 0,
    }),
    stats: (): FrameWriterStats => ({
      framesTotal: stats.framesSeed + stats.framesFull + stats.framesDiff,
      framesDiffed: stats.framesDiff,
      framesFull: stats.framesSeed + stats.framesFull,
      linesWritten: stats.staticRowsWritten,
      bytesWritten: stats.bytesWritten,
      fallbacks: stats.fallbacks,
      repaints: stats.repaints,
    }),
  };
}
