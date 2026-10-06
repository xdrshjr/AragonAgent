/**
 * ScrollIndicator (mouse-wheel-region-routing §4.8) — the one-column scroll
 * position rail on the viewport's right edge.
 *
 * NAMING (P2-1): this is NOT `layout/Gutter.tsx`. That one is the two-column
 * left rail every transcript entry sits in, and it carries an invariant of its
 * own. Two components called a gutter, on opposite edges, for unrelated
 * purposes, is how a codebase stops being able to say what it means.
 *
 * THE COLUMN IS RESERVED UNCONDITIONALLY, track glyph and all. Showing it only
 * while scrolled would change the content width, re-wrap every line, change the
 * content height, and feed that back into the measurement that decides whether
 * to show it — a shimmer at the exact moment the user is reading. Constant
 * width, no feedback loop (D-9); `width={1}` and `flexShrink={0}` hold the
 * column even on the first frame, before anything has been measured.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import type { ThumbRange } from './scroll-indicator.js';

/** Smallest supported fullscreen width; every usable chat frame reserves the column. */
export const MIN_INDICATOR_COLS = 40;

export interface ScrollIndicatorProps {
  /** Viewport height in rows, as measured by `ScrollViewport`. */
  rows: number;
  /** `null` when the content fits — the rail is drawn as bare track. */
  thumb: ThumbRange | null;
  dragging?: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

export function ScrollIndicator({
  rows,
  thumb,
  dragging = false,
  theme,
  caps,
}: ScrollIndicatorProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const count = Math.max(0, Math.floor(rows) || 0);

  const cells: React.ReactElement[] = [];
  for (let i = 0; i < count; i += 1) {
    const onThumb = !!thumb && i >= thumb.start && i < thumb.start + thumb.size;
    cells.push(
      <Text key={i} color={onThumb ? theme.primary : theme.muted} bold={onThumb && dragging}>
        {onThumb ? glyphs.scrollThumb : glyphs.scrollTrack}
      </Text>,
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0} width={1}>
      {cells}
    </Box>
  );
}
