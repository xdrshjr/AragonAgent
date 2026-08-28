/**
 * Wheel routing (wheel-scrolls-transcript-only §4.1).
 *
 * Subscribes to the mouse source and dispatches every notch to THE ONE
 * SCROLLABLE REGION ON SCREEN — the transcript, or the controlled overlay
 * covering it. Lives outside `App.tsx` because the routing table is the most
 * testable part of this feature and a table wants to be readable on its own,
 * away from a large component (D-13).
 *
 * THE POINTER ROW IS NOT CONSULTED, and that is the requirement rather than a
 * simplification (§1). A wheel notch is a VIEWPORT gesture: the pointer in a
 * TUI rests wherever the user last left it — in a chat-shaped app, next to the
 * thing they type into — so routing by row meant the ordinary "scroll back to
 * see what the agent just did" gesture landed on the composer and replaced the
 * draft with an old prompt. Prompt history belongs to `↑` / `↓` alone (G1 / G3),
 * which is the contract Claude Code, Codex and every full-screen terminal app
 * the user brings muscle memory from already follow.
 *
 * Every notch is coalesced into one intent carrying `repeat`, no matter how fast
 * the wheel spins: one gesture, one `setState`, one render.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Overlay } from '../agent/reducer.js';
import type { MouseSource } from '../input/stdin-filter.js';
import type { MouseEvent } from '../input/mouse-events.js';
import type { ScrollIntent } from './layout/scroll.js';

/**
 * Rows a PgUp/PgDn — and a Shift+wheel notch — moves inside a controlled
 * overlay. Declared here rather than in `App.tsx` because both the keyboard
 * branch and the wheel branch need it and `App` imports this module; the other
 * direction would be a cycle.
 */
export const OVERLAY_PAGE = 8;

/** Transcript rows per notch. The terminal's own convention. */
const CONTENT_LINES_PER_NOTCH = 3;
/** Overlay rows per notch. Overlay content is short; a page needs Shift. */
const OVERLAY_LINES_PER_NOTCH = 3;
/**
 * Coalescing window for transcript scrolling — one `setState`, one render, no
 * matter how fast the wheel spins (R-10). Deliberately tighter than the 33 ms
 * streaming coalescer: this one is in the direct path of a hand gesture.
 */
const WHEEL_COALESCE_MS = 16;

export interface WheelRoutingOptions {
  /** Absent when mouse support is off, in inline mode, or on a non-TTY. */
  mouseSource?: MouseSource;
  /** Read at EVENT time for the routing branch, and again at FLUSH time (P1-3). */
  getOverlay: () => Overlay | null;
  onScroll: (kind: ScrollIntent, repeat: number) => void;
  /** Signed row delta; the caller clamps at 0 the way the keyboard branch does. */
  onOverlayScroll: (delta: number) => void;
}

export interface WheelRouting {
  /**
   * Drop any accumulated-but-unflushed transcript scroll.
   *
   * Called by `App` from its existing `state.overlay` effect rather than from a
   * second subscriber to the same transition. This is guard #2 of the pair that
   * has to ship together (§14 condition 3); guard #1 is the overlay re-check
   * inside the flush, and guard #3 is `ScrollViewport`'s I-9 mount-skip.
   */
  clearCoalescer: () => void;
}

export function useWheelRouting(options: WheelRoutingOptions): WheelRouting {
  // Every mutable input reaches the subscription through this ref, so the
  // effect below subscribes exactly once per `mouseSource` instead of tearing
  // the listener down and rebuilding it on every parent render.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const accumulator = useRef<{ kind: ScrollIntent; repeat: number } | null>(null);
  const timer = useRef<NodeJS.Timeout | null>(null);

  const clearCoalescer = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    accumulator.current = null;
  }, []);

  const flush = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = accumulator.current;
    accumulator.current = null;
    if (!pending) return;
    // P1-3: THE DECISION BELONGS AT FLUSH TIME, not at event time, because the
    // event-time decision is the one that goes stale. `App` swaps
    // `ScrollViewport` out for an overlay, and 16 ms is more than wide enough
    // for an agent-raised `confirm` or an `ask_user` to land inside the window
    // — the intent would then be applied on a component that is not there, and
    // the transcript would jump by itself when the overlay closed.
    if (optionsRef.current.getOverlay()) return;
    optionsRef.current.onScroll(pending.kind, pending.repeat);
  }, []);

  const accumulate = useCallback(
    (kind: ScrollIntent, repeat: number): void => {
      // A fast up-then-down must never cancel itself into a no-op, so a change
      // of direction (or of granularity) flushes what is already held.
      if (accumulator.current && accumulator.current.kind !== kind) flush();
      const held = accumulator.current;
      accumulator.current = { kind, repeat: (held?.repeat ?? 0) + repeat };
      if (!timer.current) {
        timer.current = setTimeout(flush, WHEEL_COALESCE_MS);
        timer.current.unref?.();
      }
    },
    [flush],
  );

  const route = useCallback(
    (event: MouseEvent): void => {
      // The channel now carries press / drag / release as well
      // (tui-selection-and-scroll-follow §4.4.2). ONE LINE, AT THE TOP, and the
      // rest of this module is untouched: widening the single channel rather
      // than adding a second is what keeps arrival order intact between a wheel
      // notch and a button, and each subscriber ignoring what it does not own is
      // the price of that.
      if (event.kind !== 'wheel') return;
      const current = optionsRef.current;
      const overlay = current.getOverlay();

      // THE OVERLAY BRANCH IS EVALUATED FIRST AND RETURNS FOR EVERY OVERLAY IT
      // RECOGNIZES — the same two ordering rules the keyboard handler follows,
      // and for the same reason (R-P1-7).
      if (overlay) {
        // Modes A only. `model` / `confirm` / `question` own their own keys and
        // scrolling them would leave an inconsistent cursor (R-11).
        const controlled = overlay === 'help' || overlay === 'settings' || overlay === 'plan';
        if (!controlled) return;
        // D-3: the row is not consulted here either. Behind an overlay the
        // composer is inactive and the overlay is the only scrollable thing on
        // screen, so a notch anywhere scrolls it.
        const step = event.shift ? OVERLAY_PAGE : OVERLAY_LINES_PER_NOTCH;
        current.onOverlayScroll(event.dir === 'up' ? -step : step);
        return;
      }

      if (event.shift) {
        accumulate(event.dir === 'up' ? 'pageUp' : 'pageDown', 1);
        return;
      }
      accumulate(
        event.dir === 'up' ? 'lineUp' : 'lineDown',
        CONTENT_LINES_PER_NOTCH,
      );
    },
    [accumulate],
  );

  const { mouseSource } = options;
  useEffect(() => {
    if (!mouseSource) return undefined;
    const unsubscribe = mouseSource.subscribe(route);
    return () => {
      unsubscribe();
      clearCoalescer();
    };
  }, [mouseSource, route, clearCoalescer]);

  return { clearCoalescer };
}
