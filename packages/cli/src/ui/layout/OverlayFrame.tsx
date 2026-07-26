/**
 * OverlayFrame (spec §4.4) — the shared shell for all four overlays.
 *
 * TWO CONTENT MODES, and the distinction is load-bearing:
 *
 *  - mode A (`rows`): the caller hands over an array of elements that are each
 *    exactly one row and `wrap="truncate"`. The frame slices them and OWNS the
 *    scroll keys. Used by Help and Settings.
 *
 *  - mode B (`children`): the content manages itself. The frame draws the title,
 *    the border and the footer, and touches NOTHING else — no slicing, no
 *    arrow-key handling, no position indicator.
 *
 * Mode B exists because of `ink-select-input`: it already windows itself via
 * `limit` and registers its own `useInput` with `isFocused` defaulting to true.
 * Ink dispatches a key to EVERY mounted input handler, so a frame that also
 * claimed the arrow keys would move the model picker's selection twice per press
 * — breaking a feature that already works. Slicing it by element would be worse
 * still, since it is a single component rather than a list of rows.
 *
 * `maxRows` may be `Infinity` (the inline render path, which has no fixed frame
 * and therefore no height to fit): the frame then renders everything and shows
 * no position indicator.
 */

import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { sliceWindow } from './overlay-window.js';

/** Below this width the round border costs more than it conveys (§5.2). */
const BORDERLESS_COLS = 48;

interface OverlayFrameBase {
  title: string;
  /** Footer text. Written by the CALLER so each overlay names its own keys. */
  hint: string;
  /** Viewport rows the overlay may occupy; `Infinity` in inline mode. */
  maxRows: number;
  cols?: number;
  theme: Theme;
  caps: TermCapabilities;
}

interface OverlayFrameControlled extends OverlayFrameBase {
  /** One element per row, each already `wrap="truncate"`. */
  rows: readonly React.ReactElement[];
  scrollOffset: number;
  /**
   * Report the offset back after clamping.
   *
   * `sliceWindow` clamps for DISPLAY, but the owner of the state does not learn
   * about it. A caller that just keeps adding a page per `PgDn` therefore ends
   * up parked far past the end, and the first several `PgUp` presses then move a
   * counter nobody can see while the screen sits still — the overlay reads as
   * frozen. Feeding the clamped value back keeps the two in step.
   */
  onScrollClamp?: (offset: number) => void;
  children?: undefined;
}

interface OverlayFrameSelfManaged extends OverlayFrameBase {
  rows?: undefined;
  scrollOffset?: undefined;
  onScrollClamp?: undefined;
  children: React.ReactNode;
}

export type OverlayFrameProps = OverlayFrameControlled | OverlayFrameSelfManaged;

/** Title + footer + top and bottom border. */
const CHROME_ROWS = 4;
/**
 * The frame's own `marginTop`, which is spent out of the SAME `maxRows` budget.
 *
 * Leaving it out makes the box render one row taller than the viewport it sits
 * in, and the viewport's `overflow: hidden` then eats the bottom border — an
 * overlay silently clipped by exactly the mechanism this round exists to remove.
 * Verified by `overlay-frame-height.test.tsx`.
 */
const MARGIN_ROWS = 1;

export function OverlayFrame(props: OverlayFrameProps): React.ReactElement {
  const { title, hint, maxRows, cols = 80, theme, caps } = props;
  const glyphs = pickGlyphs(caps);
  const bordered = cols >= BORDERLESS_COLS;
  const unbounded = !Number.isFinite(maxRows);

  let body: React.ReactNode;
  let position = '';
  /** Set only in controlled mode; `null` means "nothing to report back". */
  let overflowOffset: number | null = null;

  if (props.rows) {
    const chrome = MARGIN_ROWS + (bordered ? CHROME_ROWS : CHROME_ROWS - 2);
    const height = unbounded ? props.rows.length : Math.max(1, Math.floor(maxRows) - chrome);
    const win = sliceWindow(props.rows.length, props.scrollOffset, height);
    body = props.rows.slice(win.start, win.start + win.visible);
    if (win.clamped !== props.scrollOffset) overflowOffset = win.clamped;
    if (!unbounded && win.visible < win.total) {
      const up = win.start > 0 ? glyphs.arrowUp : ' ';
      const down = win.start + win.visible < win.total ? glyphs.arrowDown : ' ';
      position = `  ${up}${down} ${win.start + 1}-${win.start + win.visible}/${win.total}`;
    }
  } else {
    body = props.children;
  }

  // In an effect, not in the branch above: calling the owner's setter mid-render
  // updates another component while this one renders. Clamping is idempotent, so
  // this settles after one extra pass.
  const onScrollClamp = props.onScrollClamp;
  useEffect(() => {
    if (overflowOffset !== null) onScrollClamp?.(overflowOffset);
  }, [overflowOffset, onScrollClamp]);

  const inner = (
    <>
      <Text wrap="truncate" color={theme.primary} bold>
        {title}
      </Text>
      {body}
      <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
        {hint}
        {position}
      </Text>
    </>
  );

  if (!bordered) {
    // Narrow terminals trade the box for a rail: same grouping, 2 fewer rows
    // and 4 fewer columns (§5.2).
    return (
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <Box
          flexDirection="column"
          flexShrink={0}
          borderStyle={{
            topLeft: glyphs.railVertical,
            top: '',
            topRight: '',
            right: '',
            bottomRight: '',
            bottom: '',
            bottomLeft: glyphs.railVertical,
            left: glyphs.railVertical,
          }}
          borderTop={false}
          borderBottom={false}
          borderRight={false}
          borderColor={theme.primary}
          paddingLeft={1}
        >
          {inner}
        </Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle={glyphs.boxStyle}
      borderColor={theme.primary}
      paddingX={1}
      marginTop={1}
    >
      {inner}
    </Box>
  );
}
