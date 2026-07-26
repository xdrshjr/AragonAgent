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
import { Box, Text } from 'ink';

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
      <Box flexDirection="column" flexShrink={0}>
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
    borderStyle: {
      topLeft: rail,
      top: '',
      topRight: '',
      right: '',
      bottomRight: '',
      bottom: '',
      bottomLeft: rail,
      left: rail,
    },
    borderTop: false,
    borderBottom: false,
    borderRight: false,
    borderLeft: true,
    borderColor: color,
  } as const;
}
