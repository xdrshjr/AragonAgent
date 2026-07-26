/**
 * EntryFrame (spec §4.3) — the single shell every transcript entry renders
 * inside, and the ONLY place entry spacing is applied.
 *
 * Keeping both the rail and the spacing here is what makes `density.ts` a real
 * policy rather than a suggestion: an entry component that also set its own
 * `marginTop` would silently double the gap at turn boundaries.
 */

import React from 'react';
import { Box } from 'ink';
import { Gutter, RailSpacer } from '../layout/Gutter.js';

export interface EntryFrameProps {
  /** Role marker shown on the entry's first row (may be a live spinner). */
  glyph: React.ReactNode;
  /** Rail / glyph colour — for tool cards this is the status colour (§5.3). */
  color?: string;
  /** Rail character drawn on the turn-boundary spacer row (`separation === 1`). */
  continuation: string;
  /** From `separationRows()`. Rendered as a rail stub, never a bare margin. */
  separation: 0 | 1;
  /** Muted colour for the spacer row so it recedes behind real content. */
  spacerColor?: string;
  children: React.ReactNode;
}

export function EntryFrame({
  glyph,
  color,
  continuation,
  separation,
  spacerColor,
  children,
}: EntryFrameProps): React.ReactElement {
  return (
    <Box flexDirection="column" flexShrink={0}>
      {separation === 1 && <RailSpacer continuation={continuation} color={spacerColor} />}
      <Gutter glyph={glyph} color={color}>
        {children}
      </Gutter>
    </Box>
  );
}
