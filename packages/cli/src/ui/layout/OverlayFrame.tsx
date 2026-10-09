import React, { useEffect, useMemo } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
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
  /** Viewport rows the overlay may occupy. */
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
  // Ink applies changed style keys alone. Recreating this object resets the
  // unchanged borderTop/borderBottom=false edges to one cell on a later render.
  const railBorderStyle = useMemo(() => ({
    topLeft: glyphs.railVertical, top: '', topRight: '', right: '',
    bottomRight: '', bottom: '', bottomLeft: glyphs.railVertical,
    left: glyphs.railVertical,
  }), [glyphs.railVertical]);
  const compact = Number.isFinite(maxRows) && maxRows < (cols >= BORDERLESS_COLS ? 6 : 4);
  const bordered = !compact && cols >= BORDERLESS_COLS;
  const unbounded = !Number.isFinite(maxRows);

  let body: React.ReactNode;
  let position = '';
  /** Set only in controlled mode; `null` means "nothing to report back". */
  let overflowOffset: number | null = null;

  if (props.rows) {
    const chrome = compact ? 2 : MARGIN_ROWS + (bordered ? CHROME_ROWS : CHROME_ROWS - 2);
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
      <Box flexDirection="row" height={1} flexShrink={0}>
        <Box flexGrow={1} flexShrink={1}><Text wrap="truncate" color={theme.primary} bold>
          {title}
        </Text></Box>
        {position && <Box width={stringWidth(position)} flexShrink={0}>
          <Text color={theme.muted}>{position}</Text>
        </Box>}
      </Box>
      <Box flexDirection="column" flexShrink={0}
        height={unbounded ? undefined : Math.max(1, maxRows - (compact ? 2 : bordered ? 5 : 3))}
        overflowY="hidden">{body}</Box>
      <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
        {hint}
      </Text>
    </>
  );

  if (compact) return <Box width={cols} height={Math.max(0, maxRows)}
    flexDirection="column" flexShrink={0} overflowY="hidden">{inner}</Box>;

  if (!bordered) {
    // Narrow terminals trade the box for a rail: same grouping, 2 fewer rows
    // and 4 fewer columns (§5.2).
    return (
      <Box flexDirection="column" flexShrink={0} marginTop={1}>
        <Box
          flexDirection="column"
          flexShrink={0}
          borderStyle={railBorderStyle}
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

/** Body rows shared by controlled overlays and self-managed focused lists. */
export function overlayBodyRows(maxRows: number, cols: number): number {
  if (!Number.isFinite(maxRows)) return 20;
  const compact = maxRows < (cols >= BORDERLESS_COLS ? 6 : 4);
  return Math.max(1, Math.floor(maxRows) - (compact ? 2 : cols >= BORDERLESS_COLS ? 5 : 3));
}
