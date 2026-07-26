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
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Text, measureElement, useStdout, type DOMElement } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import {
  applyScroll,
  clampScroll,
  type ScrollIntent,
  type ScrollState,
  type ViewportMetrics,
} from './scroll.js';

export interface ScrollViewportProps {
  /** Scroll intent. `nonce` is monotonic so pressing the same key twice re-fires. */
  intent?: { kind: ScrollIntent; nonce: number };
  /** Bumped by the parent to force a pin to the newest output (e.g. on submit). */
  pinToBottomNonce?: number;
  /** Derived display value for the status bar's `↑N`. Must be referentially stable. */
  onScrolledLinesChange?: (lines: number) => void;
  theme: Theme;
  caps: TermCapabilities;
  children: React.ReactNode;
}

/** Below this the full hint sentence wraps and eats a second viewport row. */
const TERSE_HINT_COLS = 42;

export function ScrollViewport({
  intent,
  pinToBottomNonce = 0,
  onScrolledLinesChange,
  theme,
  caps,
  children,
}: ScrollViewportProps): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const glyphs = pickGlyphs(caps);
  const clipRef = useRef<DOMElement>(null);
  const innerRef = useRef<DOMElement>(null);

  const [metrics, setMetrics] = useState<ViewportMetrics>({ viewport: 0, content: 0 });
  const [scroll, setScroll] = useState<ScrollState>({ offset: 0 });

  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const intentRef = useRef(intent);
  intentRef.current = intent;

  // Ink calculates yoga layout in `onRender`, which React runs BEFORE layout
  // effects, so the measurement below reflects the commit that just happened.
  useLayoutEffect(() => {
    const viewport = clipRef.current ? measureElement(clipRef.current).height : 0;
    const content = innerRef.current ? measureElement(innerRef.current).height : 0;
    setMetrics((prev) => (prev.viewport === viewport && prev.content === content ? prev : { viewport, content }));
  });

  const intentNonce = intent?.nonce ?? 0;
  useEffect(() => {
    const current = intentRef.current;
    if (!current) return;
    setScroll((prev) => applyScroll(prev, current.kind, metricsRef.current));
    // Keyed on the nonce alone: `intent` is a fresh object on every parent
    // render, so depending on it directly would re-scroll on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intentNonce]);

  useEffect(() => {
    setScroll({ offset: 0 });
  }, [pinToBottomNonce]);

  const overflowLines = Math.max(0, metrics.content - metrics.viewport);
  const offset = clampScroll(scroll.offset, overflowLines);
  const shiftUp = overflowLines - offset;

  useEffect(() => {
    onScrolledLinesChange?.(offset);
  }, [offset, onScrolledLinesChange]);

  // `offset` is exactly the count of rows hidden below the viewport — that is
  // what "N new lines you have not scrolled down to" means.
  const hiddenBelow = offset;
  const showHint = hiddenBelow > 0;

  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
      <Box ref={clipRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {/*
          `flexShrink={0}` is invariant I-2. Without it yoga squeezes the content
          down to the viewport height, `measureElement` reports content ===
          viewport, `overflowLines` is permanently 0 — and scrolling silently
          stops working without raising anything.
        */}
        <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-shiftUp}>
          {children}
        </Box>
      </Box>
      {showHint && (
        // Not an overlay — Ink has no absolute positioning or z-index. This takes
        // the viewport's last row, trading one line of content for a hint that
        // cannot drift. Cheaper than stacking with negative margins.
        <Box flexShrink={0} justifyContent="flex-end">
          {/*
            `wrap="truncate"` is not cosmetic: the full sentence is ~42
            characters, so on a narrower terminal it wrapped to two rows and ate
            the very content row it exists to advertise (P2-8).
          */}
          <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
            {cols < TERSE_HINT_COLS
              ? `${glyphs.arrowDown}${hiddenBelow}`
              : `${glyphs.arrowDown} ${hiddenBelow} new ${
                  hiddenBelow === 1 ? 'line' : 'lines'
                } ${glyphs.midDot} PgDn for the latest`}
          </Text>
        </Box>
      )}
    </Box>
  );
}
