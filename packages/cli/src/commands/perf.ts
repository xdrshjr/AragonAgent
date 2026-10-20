/**
 * `/perf` — what the renderer is actually doing (tui-render-performance §5.4).
 *
 * SILENT DEGRADATION IS THE ONE THING A "robust" CLAIM CANNOT AFFORD. The
 * governor makes the stream chunkier under load, the retain ring drops old
 * entries, and virtualisation mounts a fraction of the transcript. Every one of
 * those is invisible by design, so there has to be one place that names them.
 *
 * The snapshot crosses the React boundary through a module-level single slot,
 * the shape `ui/exit-snapshot.ts` already uses and for the same reason: a
 * command runs outside the render pass and has no other way to reach `App`'s
 * refs.
 *
 * READ-ONLY AND ALLOCATION-LIGHT. It renders as a NOTICE ENTRY rather than a
 * live panel, because a performance readout that costs a repaint per second to
 * display would be self-defeating.
 */

import type { FrameWriterStats } from '../ui/frame-differ.js';
import type { ScrollbarBridge } from '../ui/scrollbar-controller.js';
import type { AnchorSource } from '../ui/scrollback/canvas.js';
import { clearRenderCaches, renderCacheStats } from '../ui/render-cache.js';
import type { SlashCommand } from './registry.js';

export interface PerfSnapshot {
  /** Governor rung, its resolved interval, and the last measured commit cost. */
  rung: number;
  intervalMs: number;
  lastCommitMs: number;
  governorEnabled: boolean;
  /** Transcript accounting. */
  totalEntries: number;
  retain: number;
  droppedEntries: number;
  mountedEntries: number;
  /** Height cache. */
  heightsMeasured: number;
  heightsEstimated: number;
  cols: number;
  /** Geometry. */
  mode: 'fullscreen' | 'native';
  /** Full-screen: the transcript viewport. Native: the live region height. */
  viewportRows: number;
  offset: number;
  /** Right-edge scrollbar diagnostics; read lazily so it reflects the live bridge. */
  scrollbar?: ScrollbarPerf;
  /**
   * The native panel band, or `null` outside native mode
   * (release-gate-and-native-panels §6.10).
   *
   * REQUIRED, WITH AN EXPLICIT `null`. This feature has six ways to show nothing and
   * four of them are invisible, so "the rail is gone" has to be answerable from one
   * line. An optional field would let a future caller forget it and leave `/perf`
   * silently unable to explain the case the user is reporting.
   */
  band: BandPerf | null;
}

/**
 * The band's projection, as `/perf` reads it. Counts only - the allocation itself lives
 * in `ui/scrollback/band.ts` (`LiveBand`), and this type exists so the command layer
 * does not have to import a UI module to describe it.
 */
export interface BandPerf {
  reason: 'visible' | 'empty' | 'disabled' | 'overlay' | 'narrow' | 'short';
  /**
   * The band's height. In the full-height region this IS the pool
   * (`tui-full-height-live-region` D5), which is why `/perf` prints one `pool=` number
   * rather than two fields that can only ever be equal.
   */
  bandRows: number;
  railRows: number;
  railCols: number;
  teamRows: number;
  /** The tail column: the rows between the roster and the composer. */
  previewRows: number;
  contentCols: number;
  previewCols: number;
  heldRailRows: number;
  heldTeamRows: number;
  /**
   * The tail window: first visible entry index and how many entries are in it.
   *
   * The ONLY number that makes "what is on screen" and "what has been printed"
   * comparable. A long answer can push earlier entries out of sight while they are
   * still inside the window, so they are neither visible nor printed yet; the readout
   * turns that disclosed gap (known limitation 5) into a number instead of a guess.
   */
  windowStart: number;
  windowEntries: number;
  /**
   * Rows the TOP GIVE-WAY has printed for entries that are still inside the window.
   *
   * `window=` says what the region holds; `head=` says how much of it the region could
   * not show and therefore gave back to the terminal scrollback
   * (tui-final-reply-truncated-unscrollable). Zero is the healthy answer for a
   * conversation that always fits; a growing number means the box is smaller than the
   * reply, which is exactly the state that used to be unrecoverable.
   */
  headRows: number;
}

/**
 * Why the right-edge scrollbar is or is not usable, in one record
 * (tui-scrollbar-edge-and-run-row section 3.2). "Cannot see it" and "cannot drag
 * it" had no self-check before; each field below separates one cause.
 */
export interface ScrollbarPerf {
  /** 1-based terminal column of the track, or `null` before the first layout. */
  trackCol: number | null;
  trackRows: number | null;
  /** Mouse capture is on. Off keeps the track visible but not draggable. */
  mouseOn: boolean;
  /** A full frame matching the geometry was observed, so pointer hits are trusted. */
  frameReady: boolean;
  thumb: { start: number; size: number } | null;
  unicode: boolean;
  /** `skipped`: the differ omits CSI K on full-width rows; `n/a`: diff render is off. */
  edgeEl: 'skipped' | 'always' | 'n/a';
}

/** Build the diagnostics record from the live bridge (called at `/perf` time). */
export function readScrollbarPerf(opts: {
  bridge: ScrollbarBridge | undefined;
  diffRender: boolean;
  unicode: boolean;
}): ScrollbarPerf | undefined {
  const { bridge, diffRender, unicode } = opts;
  if (!bridge) return undefined;
  const geometry = bridge.geometry;
  return {
    trackCol: geometry?.trackCol ?? null,
    trackRows: geometry?.trackRows ?? null,
    mouseOn: bridge.isEnabled(),
    frameReady: bridge.frameReady,
    thumb: geometry?.thumb ? { start: geometry.thumb.start, size: geometry.thumb.size } : null,
    unicode,
    // `cli.tsx` always wires `cols` when it builds the differ.
    edgeEl: diffRender ? 'skipped' : 'n/a',
  };
}

/** Cleared on unmount, so `/perf` in a torn-down tree says so instead of lying. */
let provider: (() => PerfSnapshot | null) | null = null;

/** Called by `App`. Passing `null` detaches. */
export function setPerfSnapshotProvider(fn: (() => PerfSnapshot | null) | null): void {
  provider = fn;
}

export function readPerfSnapshot(): PerfSnapshot | null {
  return provider ? provider() : null;
}

/** Reset hooks the App registers alongside the snapshot provider. */
let resetGovernor: (() => void) | null = null;

export function setPerfResetHook(fn: (() => void) | null): void {
  resetGovernor = fn;
}

/**
 * Frame-writer counters (tui-input-flicker-fix §5.4).
 *
 * A SECOND MODULE-LEVEL SLOT rather than a prop on `App`, and that is this
 * file's own documented convention rather than a shortcut: the writer is built
 * in `runInteractive`, lives entirely outside React, and its counters never
 * render — so routing them through a 1900-line component's props would buy
 * nothing and cost `App.tsx` plus `app.test.tsx` churn (P1-2).
 *
 * `null` means the writer was never built — `--no-diff-render` or
 * a non-interactive path. `/perf` says so in words, so "the flag is off" and
 * "the writer crashed" never look alike.
 */
let frameStats: (() => FrameWriterStats) | null = null;

/** Called by `cli.tsx` after building the writer. Passing `null` detaches. */
export function setFrameStatsProvider(fn: (() => FrameWriterStats) | null): void {
  frameStats = fn;
}

export function readFrameStats(): FrameWriterStats | null {
  return frameStats ? frameStats() : null;
}

/**
 * Native-scroll writer counters (tui-native-terminal-scroll §5.1). A third
 * module-level slot for the reason the one above records: the writer lives outside
 * React. `guardHitsOutsideResize > 0` on a session with no resize is the defect
 * signal (a live region reached the terminal height); `clippedRows > 0` means Ink
 * and the terminal disagreed about a character's width (I-S13).
 */
export interface ScrollbackPerf {
  /** LIVE REGION height (the Ink frame), NOT the canvas — see `anchorCanvasRows`. */
  regionRows: number;
  framesSeed: number;
  framesDiff: number;
  framesFull: number;
  staticRowsWritten: number;
  elidedEntries: number;
  guardHits: number;
  guardHitsOutsideResize: number;
  clippedRows: number;
  fallbacks: number;
  resizes: number;
  repaints: number;
  /** `probe` = measured by CPR; `fill` = the one-off screen fill; `none` = unmeasured. */
  anchorSource: AnchorSource;
  /**
   * Canvas height of the most recent batch, which is also the next erase distance.
   *
   * A SEPARATE FIELD RATHER THAN A RENAMED `regionRows` (P1-4): `/perf`'s
   * "scrollback region N rows" is the first number anyone reads when the frame
   * looks wrong, and quietly turning it into the canvas height would make a 6-row
   * region report 24 during a short conversation.
   */
  anchorCanvasRows: number;
  /** Content rows inside that canvas — how much of the conversation is on screen. */
  anchorHeldRows: number;
  /** Blank rows above the content. Zero by construction in the full-height region. */
  anchorGapRows: number;
  /**
   * Canvas top row (0-based). 0 means the canvas starts on the terminal's first row and
   * is the direct answer to "why does the app start halfway down the screen" - the one
   * number that used to be missing from this block.
   */
  anchorTop: number;
  /** Rows this session pushed into the terminal's own scrollback. */
  anchorScrollRows: number;
  /** Times the geometry was dropped on purpose (column change, shrink, geometry lost). */
  anchorResets: number;
  /** Measurements accepted after the first: the re-probe count, not the resize count. */
  anchorReprobes: number;
}

let scrollbackStats: (() => ScrollbackPerf) | null = null;

/** Called by `cli.tsx` in native mode. Passing `null` detaches. */
export function setScrollbackStatsProvider(fn: (() => ScrollbackPerf) | null): void {
  scrollbackStats = fn;
}

function formatScrollbackLine(): string[] {
  const stats = scrollbackStats?.();
  if (!stats) return [];
  return [
    `scrollback region ${stats.regionRows} rows  -  canvas ${stats.anchorCanvasRows} rows  -  ` +
      `content ${stats.anchorHeldRows} rows  -  gap ${stats.anchorGapRows} rows  -  ` +
      `anchor bottom via ${stats.anchorSource}  -  scrolled ${stats.anchorScrollRows} rows  -  ` +
      `anchor resets ${stats.anchorResets}  -  reprobes ${stats.anchorReprobes}`,
    `           batches seed ${stats.framesSeed}, ` +
      `diff ${stats.framesDiff}, full ${stats.framesFull}, repaint ${stats.repaints}  -  ` +
      `static rows ${stats.staticRowsWritten}  -  elided ${stats.elidedEntries}  -  ` +
      `guardHits ${stats.guardHits} (outside resize ${stats.guardHitsOutsideResize})  -  ` +
      `clippedRows ${stats.clippedRows}  -  fallbacks ${stats.fallbacks}  -  ` +
      `resizes ${stats.resizes}`,
  ];
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function ratio(total: number, frames: number): string {
  return frames > 0 ? (total / frames).toFixed(1) : '0.0';
}

/**
 * The writer line (§5.4), in this function's existing ASCII separator shape.
 *
 * `fallbacks > 0` on a healthy session is the single most useful diagnostic this
 * feature can emit: it means something wrote to stdout behind Ink's back and
 * absolute addressing lost its origin.
 */
function formatWriterLine(): string {
  const stats = readFrameStats();
  if (!stats) return 'writer     full  -  diff render off';
  const bytesPerFrame =
    stats.framesTotal > 0 ? Math.round(stats.bytesWritten / stats.framesTotal) : 0;
  return (
    `writer     diff  -  frames ${stats.framesTotal} ` +
    `(diffed ${stats.framesDiffed}, full ${stats.framesFull})  -  ` +
    `lines/frame ${ratio(stats.linesWritten, stats.framesTotal)}  -  ` +
    `bytes/frame ${bytesPerFrame}  -  fallbacks ${stats.fallbacks}`
  );
}

function formatScrollbarLine(bar: ScrollbarPerf): string {
  const thumb = bar.thumb ? `${bar.thumb.start}+${bar.thumb.size}` : 'none';
  const line =
    `scrollbar  col=${bar.trackCol ?? '-'} rows=${bar.trackRows ?? '-'} ` +
    `mouse=${bar.mouseOn ? 'on' : 'off'} frameReady=${bar.frameReady ? 'yes' : 'no'} ` +
    `thumb=${thumb} glyphs=${bar.unicode ? 'unicode' : 'ascii'} edge-el=${bar.edgeEl}`;
  if (!bar.mouseOn || bar.frameReady) return line;
  const size = bar.trackCol !== null && bar.trackRows !== null
    ? `${bar.trackCol}x${bar.trackRows + 4}` : 'the terminal size';
  return `${line}\n           waiting for a full frame matching ${size}`;
}

/**
 * `band:` - who got which rows, and why a panel is not on screen.
 *
 * `rail=<rows>x<cols>` reads `0x0` when the rail is not drawn, which is the only
 * unambiguous "there is no rail" - a conservative width would look like a rail that
 * merely has no height. One line, because `/perf` is a notice entry and a wrapping
 * readout costs the repaint it exists to explain.
 */
function formatBandLine(band: BandPerf | null): string {
  if (!band) return 'band       n/a (full-screen layout)';
  return `band       rail=${band.railRows}x${band.railCols} team=${band.teamRows} ` +
    `tail=${band.previewRows} pool=${band.bandRows} ` +
    `cols=${band.contentCols}/${band.previewCols} ` +
    `reason=${band.reason} held=${band.heldRailRows}/${band.heldTeamRows} ` +
    `window=${band.windowStart}/${band.windowEntries} head=${band.headRows}`;
}

/**
 * Format a snapshot as the seven-line block documented in §5.4 (plus the scrollbar
 * line). The `band:` line is the newest one and the only place that answers "why is
 * that panel not on screen".
 */
export function formatPerfReport(snap: PerfSnapshot): string {
  const caches = renderCacheStats();
  const eco = snap.rung > 0 ? '  -  eco' : '';
  const governor = snap.governorEnabled ? '' : '  -  governor off';
  const native = snap.mode === 'native';
  // The canvas top lives in the writer's counters, not in the snapshot: it is the direct
  // explanation for "the app starts halfway down", so it belongs on the mode line next
  // to the region height. `n/a` rather than 0 when no writer is attached, because 0 is a
  // real and healthy answer.
  const anchor = native ? scrollbackStats?.() ?? null : null;
  const scrollbar = native
    ? ['scrollbar  n/a (native scroll)']
    : snap.scrollbar ? [formatScrollbarLine(snap.scrollbar)] : [];
  return [
    `render     rung ${snap.rung}  -  interval ${snap.intervalMs}ms  -  last commit ` +
      `${Math.round(snap.lastCommitMs)}ms${eco}${governor}`,
    `transcript ${snap.totalEntries} entries  -  ${snap.retain} retained  -  ` +
      `${snap.droppedEntries} dropped  -  ${snap.mountedEntries} mounted`,
    `heights    ${snap.heightsMeasured} cached  -  ${snap.heightsEstimated} estimated  -  ` +
      `cols ${snap.cols}`,
    `caches     md ${caches.markdownEntries} (${mb(caches.markdownBytes)})  -  ` +
      `hl ${caches.highlightEntries} (${mb(caches.highlightBytes)})  -  ` +
      `lines ${caches.lineEntries}`,
    native
      ? `mode       native  -  live region ${snap.viewportRows} rows  -  ` +
        `top ${anchor ? anchor.anchorTop : 'n/a'}`
      : `mode       ${snap.mode}  -  viewport ${snap.viewportRows} rows  -  offset ${snap.offset}`,
    formatBandLine(snap.band),
    formatWriterLine(),
    ...formatScrollbackLine(),
    ...scrollbar,
  ].join('\n');
}

export const perfCommand: SlashCommand = {
  name: 'perf',
  description: 'Render statistics (/perf reset clears the caches and the governor)',
  run: (ctx) => {
    const arg = ctx.args.trim().toLowerCase();

    if (arg === 'reset') {
      clearRenderCaches();
      resetGovernor?.();
      ctx.toast('success', 'Render caches cleared, governor reset.');
      return;
    }

    if (arg.length > 0) {
      ctx.notify('warn', `Unknown argument "${arg}" - use /perf [reset].`);
      return;
    }

    const snap = readPerfSnapshot();
    if (!snap) {
      // Reachable from a headless / detached tree. Saying so beats printing a
      // block of zeroes that reads like a renderer doing nothing.
      ctx.notify('info', 'No render statistics: the TUI is not mounted.');
      return;
    }
    ctx.notify('info', formatPerfReport(snap));
  },
};
