/**
 * The selection controller (tui-selection-and-scroll-follow §4.4). NON-REACT: it
 * owns the mouse lifecycle, the 16 ms drag coalescer, the `decorate` hook and the
 * copy-on-release, and it reaches the React tree only through the two callbacks
 * `App` registers on mount.
 *
 * WHY IT IS NOT A COMPONENT (D-6). A React re-render per motion report goes
 * through the render governor and the whole component tree; the frame pipeline
 * repaints one to three rows with no commit at all. A fast drag across 40 columns
 * therefore costs about three repaints of a few rows each, not forty full frames.
 *
 * THREE THINGS IN HERE FAIL SILENTLY AND PERMANENTLY IF DROPPED:
 *
 *  - **I-11 · `hold` must always have a way out.** A press with no matching
 *    release freezes the viewport for the rest of the session: content anchoring
 *    never lets go, the resume timer's third condition never passes, and nothing
 *    is raised anywhere. Three ways to never get a release — the button comes up
 *    while the terminal does not have focus, the emulator swallows it, or the
 *    terminal fell back to X10, whose reports cannot express a release at all.
 *    So `hold` is released by a `release` report, by `clear()`, OR by the
 *    `holdMaxMs` watchdog, and the parser refuses to emit buttons from X10.
 *  - **I-9 · a highlight that survives the rows moving is a lie about what would
 *    be copied.** `App` clears on `shiftUp` change — the DERIVED form, which a
 *    new way to move the viewport cannot forget to join — and additionally on
 *    key, resize, overlay and `differ.invalidate()`.
 *  - **I-4 · the highlight and the copy read the SAME mirror**, written by the
 *    same `decorate` call. What you see is what you get by construction, rather
 *    than by a staleness check that can be wrong.
 */

import type { MouseSource } from '../../input/stdin-filter.js';
import type { MouseEvent } from '../../input/mouse-events.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import type { CopyVia } from '../clipboard.js';
import { createScreenMirror } from './screen-mirror.js';
import { paintRow, selectionOpen } from './highlight.js';
import {
  isEmpty,
  normalize,
  rowSpan,
  selectedText,
  type Cell,
  type Selection,
} from './selection.js';

/**
 * Motion coalescing window. The same 16 ms and the same reasoning as
 * `use-wheel-routing.ts`: this one is in the direct path of a hand gesture, so
 * it is deliberately tighter than the 33 ms streaming coalescer.
 */
const DRAG_COALESCE_MS = 16;

/**
 * How long a nominally-held button may sit MOTIONLESS before the watchdog lets
 * go of it (I-11). Reset by every motion report, so it only fires when the
 * pointer has not moved for the whole window — which is indistinguishable from a
 * lost release, and the failure it prevents is unrecoverable while the one it
 * risks costs a re-drag (R-12).
 */
export const DEFAULT_HOLD_MAX_MS = 30_000;

export interface SelectionControllerOptions {
  source: MouseSource;
  /**
   * Ask the frame writer to re-paint. Returns whether anything reached the
   * screen; `false` means the differ had no cache to diff against, and the
   * caller falls back to `requestRedraw`.
   */
  repaint: () => boolean;
  /** `App`'s `redrawNonce`, for the invalidated case (§4.4.3). */
  requestRedraw: () => void;
  copy: (text: string) => CopyVia;
  /** Toast sink, registered by `App` on mount (§6.3). */
  onCopied: (via: CopyVia, lines: number, chars: number) => void;
  theme: () => Theme;
  caps: TermCapabilities;
  /** Terminal width, for the right edge of a multi-row highlight. */
  cols: () => number;
  /** Static half of the gate: full-screen and `mouseSelect`. */
  isSelectable?: () => boolean;
  /** I-11. Default 30_000; `0` disables the watchdog (tests). */
  holdMaxMs?: number;
}

export interface SelectionController {
  /** Feed to `createFrameDiffer({ decorate })`. Mirrors, then paints. */
  decorate(lines: string[]): string[];
  /** Subscribe to `hold` transitions; `App` mirrors this into React state. */
  onHoldChange(listener: (hold: boolean) => void): () => void;
  /** Called by `App` for key / resize / overlay / clear, and by `onInvalidate`. */
  clear(): void;
  /** The dynamic half of the gate: `App` closes it while an overlay is open. */
  setEnabled(enabled: boolean): void;
  dispose(): void;
}

/**
 * The seam between the non-React controller and the React tree.
 *
 * SAME SHAPE AS `UpdateBridge` (`cli.tsx`), and for the same reason: the
 * controller is constructed before `render()` and must not hold React state,
 * while the toast sink and the redraw nonce only exist once `App` has mounted.
 * `App` assigns both fields in an effect and clears them on unmount.
 */
export interface SelectionBridge {
  controller: SelectionController | null;
  onCopied: ((via: CopyVia, lines: number, chars: number) => void) | null;
  requestRedraw: (() => void) | null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function createSelectionController(
  options: SelectionControllerOptions,
): SelectionController {
  const mirror = createScreenMirror();
  const holdListeners = new Set<(hold: boolean) => void>();
  const holdMaxMs = options.holdMaxMs ?? DEFAULT_HOLD_MAX_MS;
  const isSelectable = options.isSelectable ?? ((): boolean => true);

  let enabled = true;
  let sel: Selection | null = null;
  let dragging = false;
  let pendingFocus: Cell | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  let holdWatchdog: NodeJS.Timeout | null = null;
  let disposed = false;
  /** Guards `decorate` against being re-entered from inside a repaint. */
  let painting = false;

  const emitHold = (hold: boolean): void => {
    for (const listener of [...holdListeners]) listener(hold);
  };

  const clearFlushTimer = (): void => {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  };

  const clearWatchdog = (): void => {
    if (!holdWatchdog) return;
    clearTimeout(holdWatchdog);
    holdWatchdog = null;
  };

  /**
   * `0` disables it, which is what the tests that are not about it use. Every
   * motion report re-arms it, so the window measures STILLNESS rather than the
   * duration of the drag (R-12).
   */
  const armWatchdog = (): void => {
    clearWatchdog();
    if (holdMaxMs <= 0) return;
    holdWatchdog = setTimeout(() => {
      holdWatchdog = null;
      if (!dragging) return;
      // Let go of `hold` and the drag; KEEP whatever was selected. The user may
      // still want to copy it, and throwing it away would turn a terminal quirk
      // into lost work.
      dragging = false;
      pendingFocus = null;
      clearFlushTimer();
      emitHold(false);
    }, holdMaxMs);
    holdWatchdog.unref?.();
  };

  /**
   * Repaint, falling back to a React redraw when the differ has no cache.
   *
   * `wanted` says whether something must APPEAR on screen. Clearing a highlight
   * after an `invalidate()` needs no fallback — the raw frame is already on the
   * screen without it — and asking for one there would turn every resize and
   * every foreign write into a redraw nonce bump.
   */
  const paint = (wanted: boolean): void => {
    if (disposed) return;
    const painted = options.repaint();
    if (!painted && wanted) options.requestRedraw();
  };

  const clear = (): void => {
    // Nothing to undo: no timers, no repaint, no redraw. This is what keeps
    // `onInvalidate` — which fires on every resize and every foreign write —
    // free for a session that has never selected anything.
    if (sel === null && !dragging && pendingFocus === null) return;
    const wasDragging = dragging;
    sel = null;
    dragging = false;
    pendingFocus = null;
    clearFlushTimer();
    clearWatchdog();
    if (wasDragging) emitHold(false);
    paint(false);
  };

  const cellOf = (event: { x: number; y: number }): Cell => {
    // SGR reports are 1-based, frame line `i` is terminal row `i + 1`. A report
    // from a terminal that resized mid-drag must not index past the mirror.
    const rows = Math.max(1, mirror.raw.length);
    const cols = Math.max(1, options.cols());
    return { row: clamp(event.y - 1, 0, rows - 1), col: clamp(event.x - 1, 0, cols - 1) };
  };

  const flushDrag = (): void => {
    clearFlushTimer();
    const focus = pendingFocus;
    pendingFocus = null;
    if (!focus || !sel) return;
    sel = { anchor: sel.anchor, focus };
    paint(true);
  };

  const finishSelection = (): void => {
    if (!sel) return;
    const normal = normalize(sel);
    if (isEmpty(normal)) {
      // A plain click. It must never leave a one-cell highlight behind, and it
      // must never clobber the clipboard.
      sel = null;
      paint(false);
      return;
    }
    const text = selectedText(mirror.plain, normal);
    if (text.length === 0) {
      sel = null;
      paint(false);
      return;
    }
    const via = options.copy(text);
    options.onCopied(via, text.split('\n').length, text.length);
    // The highlight STAYS after a release: it is the receipt for what was taken,
    // and it goes away on the next thing that moves the rows (I-9).
    paint(true);
  };

  const onMouse = (event: MouseEvent): void => {
    if (disposed) return;

    if (event.kind === 'wheel') {
      // A wheel notch during a drag is a user changing their mind, not extending
      // a selection — N1 already declines auto-scroll-while-dragging. The notch
      // then scrolls normally, because the wheel router is a separate subscriber
      // on the same channel.
      if (dragging) clear();
      return;
    }

    if (event.kind === 'press') {
      if (event.button !== 0 || !enabled || !isSelectable()) {
        // Any other button, or a closed gate: drop whatever was selected and do
        // nothing else. A right-click that left a stale highlight behind would be
        // the same false promise I-9 forbids.
        clear();
        return;
      }
      const cell = cellOf(event);
      sel = { anchor: cell, focus: cell };
      pendingFocus = null;
      clearFlushTimer();
      dragging = true;
      emitHold(true); // freezes the transcript for the duration of the drag
      armWatchdog();
      paint(true);
      return;
    }

    if (event.kind === 'drag') {
      if (!dragging || event.button !== 0 || !sel) return;
      pendingFocus = cellOf(event);
      armWatchdog();
      if (!flushTimer) {
        flushTimer = setTimeout(flushDrag, DRAG_COALESCE_MS);
        flushTimer.unref?.();
      }
      return;
    }

    // release
    if (!dragging) return;
    if (pendingFocus && sel) sel = { anchor: sel.anchor, focus: pendingFocus };
    pendingFocus = null;
    clearFlushTimer();
    clearWatchdog();
    dragging = false;
    emitHold(false);
    finishSelection();
  };

  const unsubscribe = options.source.subscribe(onMouse);

  return {
    decorate(lines: string[]): string[] {
      mirror.set(lines);
      if (painting || sel === null) return lines;
      const normal = normalize(sel);
      if (isEmpty(normal)) return lines;
      painting = true;
      try {
        const open = selectionOpen(options.theme(), options.caps);
        const cols = Math.max(1, options.cols());
        const out = lines.slice();
        for (let row = normal.start.row; row <= normal.end.row; row += 1) {
          if (row < 0 || row >= out.length) continue;
          const span = rowSpan(normal, row);
          if (!span) continue;
          const to = Math.min(Number.isFinite(span.to) ? span.to : cols, cols);
          out[row] = paintRow(out[row]!, span.from, to, open);
        }
        return out;
      } finally {
        painting = false;
      }
    },
    onHoldChange(listener) {
      holdListeners.add(listener);
      return () => holdListeners.delete(listener);
    },
    clear,
    setEnabled(next: boolean): void {
      if (enabled === next) return;
      enabled = next;
      if (!next) clear();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      clearFlushTimer();
      clearWatchdog();
      holdListeners.clear();
      sel = null;
      dragging = false;
      pendingFocus = null;
    },
  };
}
