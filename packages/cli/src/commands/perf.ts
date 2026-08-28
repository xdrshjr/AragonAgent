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
  mode: 'fullscreen' | 'inline';
  viewportRows: number;
  offset: number;
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
 * `null` means the writer was never built — `--no-diff-render`, inline mode, or
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

/** Format a snapshot as the six-line block documented in §5.4. */
export function formatPerfReport(snap: PerfSnapshot): string {
  const caches = renderCacheStats();
  const eco = snap.rung > 0 ? '  -  eco' : '';
  const governor = snap.governorEnabled ? '' : '  -  governor off';
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
    `mode       ${snap.mode}  -  viewport ${snap.viewportRows} rows  -  offset ${snap.offset}`,
    formatWriterLine(),
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
