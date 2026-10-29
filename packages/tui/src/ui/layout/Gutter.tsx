/**
 * Gutter (spec §4.3) — the two-column left rail every transcript entry sits in.
 *
 * Replaces the previous "blank line + round box per entry" idiom, which cost
 * 3-4 fixed rows for every entry and made one ordinary tool call fill the entire
 * viewport on a 24-row terminal. The rail carries the role glyph on the first
 * row and the status colour along the whole entry, so the grouping that the
 * border used to provide survives at a fraction of the vertical cost.
 *
 * INVARIANT I-2 — the content column MUST keep `flexShrink={0}`.
 * `ScrollViewport` measures content height with `measureElement`; if yoga is
 * allowed to squeeze this column down to the viewport height, the measurement
 * reports `content === viewport`, `overflowLines` is permanently 0, and
 * scrolling stops working with no error anywhere. Read the comment at
 * `ScrollViewport.tsx:94-99` before touching this. Guarded by A-6.
 */

import React from 'react';
import { Box, Text, type BoxProps } from 'ink';

/** Columns reserved for the rail, glyph included. */
export const GUTTER_WIDTH = 2;

export interface GutterProps {
  /**
   * Role marker on the first row (user / assistant / tool status / notice).
   *
   * A node rather than a string because while an answer streams the marker IS
   * the spinner — that used to live inside `AssistantEntry`, and moving the
   * glyph out here without moving the spinner would have silently dropped the
   * "something is happening" affordance.
   */
  glyph: React.ReactNode;
  color?: string;
  children: React.ReactNode;
}

export function Gutter({ glyph, color, children }: GutterProps): React.ReactElement {
  return (
    <Box flexDirection="row">
      <Box flexShrink={0} width={GUTTER_WIDTH}>
        <Text color={color}>{glyph}</Text>
      </Box>
      {/*
        `flexBasis={0} flexGrow={1}` AND NOT AN EXPLICIT WIDTH (defect 1, RC-1).
        `virtual-window.ts:264` already estimates every entry against
        `cols - GUTTER_WIDTH`; that estimator and this layout are two authorities on
        one number, so the available width has to be computed once — by yoga, from
        the parent — rather than spelled a second time here. `flexShrink={0}` stays:
        see INVARIANT I-2 above.
      */}
      <Box flexDirection="column" flexBasis={0} flexGrow={1} flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * The one-row gap between turns: a dim rail stub rather than a blank line, so
 * the eye still follows a continuous left edge across the turn boundary.
 */
export function RailSpacer({
  continuation,
  color,
}: {
  continuation: string;
  color?: string;
}): React.ReactElement {
  return (
    <Text color={color}>{continuation}</Text>
  );
}

/** The object form of Ink's `borderStyle` (the other form is a `cli-boxes` name). */
type RailBoxStyle = Exclude<NonNullable<BoxProps['borderStyle']>, string>;

/**
 * One frozen border-style object per rail glyph.
 *
 * It has to be the SAME object on every render: Ink updates a node by applying only the
 * style keys that changed, and when `borderStyle` changes `applyBorderStyles` re-opens
 * every edge whose `borderTop/Bottom/Right` is not in that diff (`undefined !== false`).
 * A fresh object per call therefore turned the disabled top, bottom and right edges back
 * into one cell on every in-place update: a rail box gained two blank rows and lost a
 * column while the offscreen renderer, which always mounts fresh, measured it without
 * them. The scrollback print arithmetic then came up short and rows vanished. Same trap
 * as the `useMemo` in `OverlayFrame.tsx` and `TodoPanel.tsx`, fixed here for every caller.
 */
const RAIL_BORDER_STYLES = new Map<string, RailBoxStyle>();

function railBorderStyle(rail: string): RailBoxStyle {
  let style = RAIL_BORDER_STYLES.get(rail);
  if (!style) {
    style = Object.freeze({
      topLeft: rail,
      top: '',
      topRight: '',
      right: '',
      bottomRight: '',
      bottom: '',
      bottomLeft: rail,
      left: rail,
    });
    RAIL_BORDER_STYLES.set(rail, style);
  }
  return style;
}

/**
 * A left-only border whose vertical character is the rail glyph.
 *
 * Used where a block owns its own lines (tool preview, fenced code) and used to
 * be wrapped in a round box: the border cost 2 rows plus 2 columns of padding
 * and nested visibly inside other round boxes. Ink repeats `box.left` for the
 * measured height of the child, so this is a continuous rail that costs 1 column
 * and 0 rows.
 */
export function railBorderProps(rail: string, color?: string) {
  return {
    borderStyle: railBorderStyle(rail),
    borderTop: false,
    borderBottom: false,
    borderRight: false,
    borderLeft: true,
    borderColor: color,
  } as const;
}
