/**
 * ScrollViewport (spec §4.5) — a self-drawn scrolling window built from Ink's
 * negative `marginTop` + `overflow: hidden` + `measureElement`.
 *
 * Once the frame occupies the whole screen, `<Static>` history is pushed above
 * the frame where only one line is visible, so native scrollback stops being a
 * usable mechanism and the app has to own scrolling. That is why this exists.
 *
 * SINGLE SOURCE OF TRUTH (review P1-7): both the metrics and the scroll offset
 * live here. The parent only pushes an *intent* down and receives one derived
 * *display* number back. Holding the offset in the parent as well would create a
 * measure → setState → re-render → measure loop whose convergence is provable
 * but whose frame count is not — expensive inside a 33 ms streaming window.
 *
 * AS OF tui-selection-and-scroll-follow THIS IS AN ADAPTER, NOT A POLICY OWNER.
 * The two follow rules are pure and live in `follow-state.ts`; what stays here is
 * measure → compute a tail delta → apply → arm a timer. `scroll.ts` is
 * unchanged, so every existing scroll test keeps passing (R-10).
 *
 * The "N new lines · PgDn" hint used to take this viewport's LAST ROW. It now
 * renders as a chip inside the composer's bordered input row (§4.2), which costs
 * zero rows and removes the feedback loop where the hint's own presence shrank
 * the viewport, which changed `overflowLines`, which was the number the hint
 * displayed. The data still leaves through `onScrolledLinesChange`.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, measureElement, useStdout, type DOMElement } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { ViewportGeometryContext, type ViewportGeometry } from './viewport-geometry.js';
import {
  applyScrollTimes,
  clampScroll,
  type ScrollIntent,
  type ScrollState,
  type ViewportMetrics,
} from './scroll.js';
import { reduceFollow, shouldArmResume, type TailSink } from './follow-state.js';
import { thumbRange } from './scroll-indicator.js';
import { MIN_INDICATOR_COLS, ScrollIndicator } from './ScrollIndicator.js';

export interface ScrollViewportProps {
  /**
   * Scroll intent. `nonce` is monotonic so pressing the same key twice re-fires.
   * `repeat` folds a coalesced wheel burst into one state update (defaults 1).
   */
  intent?: { kind: ScrollIntent; nonce: number; repeat?: number };
  /** Bumped by the parent to force a pin to the newest output (e.g. on submit). */
  pinToBottomNonce?: number;
  /** Derived display value for the status bar's `↑N`. Must be referentially stable. */
  onScrolledLinesChange?: (lines: number) => void;
  /**
   * Rows hidden ABOVE the window, published on every change (§4.3.3).
   *
   * PUBLISHED, NOT LIFTED — the same shape as `onScrolledLinesChange`, so there
   * is still exactly one owner of the offset. `shiftUp` changes exactly when the
   * rows on screen move, which is the property the selection's clear-list was
   * approximating by enumeration (I-9 / P1-4). Must be referentially stable.
   */
  onViewportShiftChange?: (shiftUp: number) => void;
  /**
   * The transcript's tail row counter (§4.3.1a), written during ITS render and
   * therefore already current when this component's layout effect runs.
   *
   * ABSENT ⇒ NO ANCHORING AT ALL, deliberately: every existing caller and every
   * existing test that does not supply it behaves exactly as it did before this
   * feature, because `tailDelta` is then permanently 0.
   */
  tailRowsRef?: TailSink;
  /**
   * True while a selection drag is in progress (§4.4). It anchors the content
   * even from a pinned viewport, and it suspends the resume timer.
   */
  hold?: boolean;
  /** Idle delay before returning to the newest line, in ms; `0` disables (AC-9). */
  resumeMs?: number;
  /** Reserve the right-edge scroll-position rail (mouse-wheel §4.8). */
  showScrollIndicator?: boolean;
  /**
   * The viewport's own width, when it is narrower than the terminal
   * (todo-plan-execution §3.9 / C-7).
   *
   * This component is the ONLY one inside the viewport subtree that reads
   * `stdout.columns` directly, and the place it uses the number — the
   * `MIN_INDICATOR_COLS` gate — is about how much room THIS BOX has, not how
   * wide the terminal is. Once the todo rail takes a fifth of the frame those two
   * stop being the same number. Optional so every existing caller (and every
   * test) is unchanged.
   */
  cols?: number;
  theme: Theme;
  caps: TermCapabilities;
  children: React.ReactNode;
}

export function ScrollViewport({
  intent,
  pinToBottomNonce = 0,
  onScrolledLinesChange,
  onViewportShiftChange,
  tailRowsRef,
  hold = false,
  resumeMs = 0,
  showScrollIndicator = false,
  cols: colsProp,
  theme,
  caps,
  children,
}: ScrollViewportProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = colsProp ?? stdout?.columns ?? 80;
  const clipRef = useRef<DOMElement>(null);
  const innerRef = useRef<DOMElement>(null);

  const [metrics, setMetrics] = useState<ViewportMetrics>({ viewport: 0, content: 0 });
  const [scroll, setScroll] = useState<ScrollState>({ offset: 0 });

  const overflowLines = Math.max(0, metrics.content - metrics.viewport);
  const offset = clampScroll(scroll.offset, overflowLines);
  const shiftUp = overflowLines - offset;

  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const intentRef = useRef(intent);
  intentRef.current = intent;
  /**
   * The RENDERED (clamped) offset, assigned during render (P1-9).
   *
   * `scroll.offset` is raw state while everything on screen derives from
   * `clampScroll(...)`; the two diverge after any content shrink (`/clear`, the
   * retain ring, a re-wrap), and an accumulation against the raw value then yanks
   * a viewport the user believes is pinned and shows a phantom chip.
   */
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  /** Read at timer FIRE time, not only at ARM time (I-6). */
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const resumeMsRef = useRef(resumeMs);
  resumeMsRef.current = resumeMs;
  /** Rows that arrived while paused; resets to 0 whenever the offset reaches 0. */
  const newLinesRef = useRef(0);
  const prevTail = useRef(0);
  const resumeTimer = useRef<NodeJS.Timeout | null>(null);

  const clearResumeTimer = useCallback((): void => {
    if (!resumeTimer.current) return;
    clearTimeout(resumeTimer.current);
    resumeTimer.current = null;
  }, []);

  /**
   * Rule B. Called from exactly three places and no others: the intent effect
   * (after applying a scroll), the anchoring effect (after a non-zero
   * `tailDelta`), and every `hold` transition.
   *
   * The re-check inside the callback is the same class of bug the wheel router's
   * flush already guards: the decision that goes stale is the one taken when the
   * timer was ARMED, and 5 seconds is an eternity next to a 16 ms coalescing
   * window.
   */
  const armResume = useCallback((): void => {
    clearResumeTimer();
    if (
      !shouldArmResume({
        resumeMs: resumeMsRef.current,
        offset: offsetRef.current,
        newLinesWhilePaused: newLinesRef.current,
        hold: holdRef.current,
      })
    ) {
      return;
    }
    const timer = setTimeout(() => {
      resumeTimer.current = null;
      if (holdRef.current) return; // I-6 — re-read at FIRE time.
      setScroll({ offset: 0 });
    }, resumeMsRef.current);
    timer.unref?.();
    resumeTimer.current = timer;
  }, [clearResumeTimer]);

  // A timer that outlives the component would fire `setScroll` on an unmounted
  // tree; an overlay unmounts this component on every open.
  useEffect(() => clearResumeTimer, [clearResumeTimer]);

  // Ink calculates yoga layout in `onRender`, which React runs BEFORE layout
  // effects, so the measurement below reflects the commit that just happened.
  // The children have already rendered, so `tailRowsRef` is current too.
  useLayoutEffect(() => {
    const viewport = clipRef.current ? measureElement(clipRef.current).height : 0;
    const content = innerRef.current ? measureElement(innerRef.current).height : 0;
    setMetrics((prev) => (prev.viewport === viewport && prev.content === content ? prev : { viewport, content }));

    // RULE A. The input is the transcript's TAIL counter and never `content`
    // (P0-1 / I-7) — see the header of `follow-state.ts` for the four things
    // that move a measured height and the one that must move the offset.
    const tail = tailRowsRef?.current.rows ?? 0;
    const tailDelta = tail - prevTail.current;
    prevTail.current = tail;
    if (tailDelta === 0) return; // the steady state, and R-8's loop guard

    const overflow = Math.max(0, content - viewport);
    // THE DECISION IS TAKEN OUTSIDE THE UPDATER (P1-9). React is free to invoke
    // an updater more than once, and a `newLinesWhilePaused += delta` inside one
    // double-counts when it does.
    const out = reduceFollow({
      offset: clampScroll(offsetRef.current, overflow),
      overflowLines: overflow,
      tailDelta,
      hold: holdRef.current,
      newLinesWhilePaused: newLinesRef.current,
    });
    newLinesRef.current = out.newLinesWhilePaused;
    if (out.offset !== offsetRef.current) {
      // Assigned eagerly so the `armResume()` below decides against the offset
      // this frame is about to render, not the one it replaced. `out.offset` is
      // already clamped against the freshly measured overflow, which is exactly
      // what the next render will clamp against.
      offsetRef.current = out.offset;
      setScroll({ offset: out.offset });
    }
    armResume();
  });

  // I-9: seeded from the INCOMING nonce during the first render, so the effect
  // below cannot apply an intent on the mount that first observes it. A
  // `useEffect([nonce])` fires on mount as well as on change, and this
  // component is unmounted whenever an overlay opens (`App.tsx` swaps it out) —
  // without the guard, closing an overlay replays whatever wheel gesture was in
  // flight when it opened, and the transcript jumps a page on its own. That is
  // R-P1-7, which this codebase has already paid for once through the keyboard
  // path; the overlay-swallowing rule in `App`'s key handler becomes a SECOND
  // line of defence rather than the only one.
  const lastAppliedNonce = useRef<number | undefined>(intent?.nonce);
  const intentNonce = intent?.nonce ?? 0;
  useEffect(() => {
    const current = intentRef.current;
    if (!current) return;
    if (current.nonce === lastAppliedNonce.current) return;
    lastAppliedNonce.current = current.nonce;
    const repeat = current.repeat ?? 1;
    setScroll((prev) => applyScrollTimes(prev, current.kind, metricsRef.current, repeat));
    // T-21 — "用户没动" is measured from the last GESTURE, so every applied
    // intent restarts the countdown.
    armResume();
    // Keyed on the nonce alone: `intent` is a fresh object on every parent
    // render, so depending on it directly would re-scroll on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentNonce]);

  useEffect(() => {
    setScroll({ offset: 0 });
  }, [pinToBottomNonce]);

  useEffect(() => {
    onScrolledLinesChange?.(offset);
  }, [offset, onScrolledLinesChange]);

  useEffect(() => {
    onViewportShiftChange?.(shiftUp);
  }, [shiftUp, onViewportShiftChange]);

  // Reaching the bottom BY ANY ROUTE — the timer, `pinToBottomNonce`, PgDn, or
  // `applyScroll`'s bottom snap — resets the paused counter and disarms. The
  // anchoring route expresses the same reset inside `reduceFollow`, so the rule
  // is stated once per route rather than once per gesture.
  useEffect(() => {
    if (offset !== 0) return;
    newLinesRef.current = 0;
    armResume(); // clears; re-arming is refused at offset 0 by condition 1.
  }, [offset, armResume]);

  // Both `hold` edges. Rising suspends the countdown (condition 3); falling
  // restarts it, which is what makes a released drag behave like any other
  // finished gesture.
  useEffect(() => {
    armResume();
  }, [hold, armResume]);

  // Suppressed below `MIN_INDICATOR_COLS`, where a column of content is worth
  // more than the affordance. The routing never reads this flag, which is what
  // keeps the indicator independently revertible (§13-Q3).
  const indicatorVisible = showScrollIndicator && cols >= MIN_INDICATOR_COLS;

  // PUBLISHED, NOT LIFTED (tui-render-performance L3 / §3.3.2). The three
  // numbers virtualisation needs are already owned here; a `useMemo`d context
  // value hands them down without adding a second owner or a second measure
  // pass, which is exactly what this component's header (P1-7) forbids.
  const geometry = useMemo<ViewportGeometry>(
    () => ({ viewportRows: metrics.viewport, offset, contentRows: metrics.content }),
    [metrics.viewport, metrics.content, offset],
  );

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box ref={clipRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
          {/*
            `flexShrink={0}` is invariant I-2. Without it yoga squeezes the content
            down to the viewport height, `measureElement` reports content ===
            viewport, `overflowLines` is permanently 0 — and scrolling silently
            stops working without raising anything.
          */}
          <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-shiftUp}>
            <ViewportGeometryContext.Provider value={geometry}>
              {children}
            </ViewportGeometryContext.Provider>
          </Box>
        </Box>
        {indicatorVisible && (
          <ScrollIndicator
            rows={metrics.viewport}
            thumb={thumbRange(metrics.viewport, metrics.content, offset)}
            theme={theme}
            caps={caps}
          />
        )}
      </Box>
    </Box>
  );
}
