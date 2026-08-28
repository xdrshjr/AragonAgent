/**
 * Render a user message entry.
 *
 * The role glyph, the gutter rail and the inter-entry spacing all belong to
 * `EntryFrame` now (§4.3), so this component renders content and nothing else.
 *
 * IT DOES TAKE `caps` AS OF tui-paste-handling (G7): the row cap below needs one
 * glyph, and a hardcoded ellipsis is the exact failure `glyphs.ts` exists to
 * prevent. That is the only reason the earlier "it has no glyph of its own left
 * to degrade" note no longer holds.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { USER_ENTRY_MAX_ROWS } from '../composer-limits.js';

function UserEntryImpl({
  text,
  theme,
  caps,
}: {
  text: string;
  theme: Theme;
  caps: TermCapabilities;
}): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const all = text.split('\n');
  // A submitted 5 000-line paste otherwise asks Yoga to lay out 5 000 nodes
  // inside a measured entry -- the hazard `render-cache.ts:37` already records
  // in the same words ("a multi-megabyte 'code block' is almost always a pasted
  // log"). The full text stays in `ViewState` and in the exit transcript, which
  // is deliberately NOT capped: a replay a user pipes into an issue must be
  // complete.
  const hidden = Math.max(0, all.length - USER_ENTRY_MAX_ROWS);
  const shown = hidden > 0 ? all.slice(0, USER_ENTRY_MAX_ROWS) : all;
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => (
        <Text key={i} color={theme.user} bold={i === 0}>
          {line}
        </Text>
      ))}
      {hidden > 0 && (
        // The tail NAMES the number of hidden rows rather than hiding them
        // silently, which is what makes the cap honest (D-9 / R-10).
        <Text color={theme.muted}>{`${glyphs.ellipsis} +${hidden} more lines`}</Text>
      )}
    </Box>
  );
}

/**
 * Rows this component renders for a given text.
 *
 * EXPORTED SO `virtual-window.ts` AND THIS FILE CANNOT DISAGREE (I-13). The
 * render cap and the height estimate are ONE number; an over-estimated entry is
 * never mounted, so it is never measured, so the estimate never self-corrects --
 * which makes that particular disagreement permanent and silent.
 */
export function userEntryRenderedRows(lineCount: number): number {
  return lineCount > USER_ENTRY_MAX_ROWS ? USER_ENTRY_MAX_ROWS + 1 : lineCount;
}

/**
 * `React.memo` with the DEFAULT comparator (tui-render-performance L2 / R3).
 * `mapEntry` already preserves object identity for untouched entries, so the
 * array props below are stable references on a settled card, and `theme` /
 * `caps` are `useMemo`d in `App.tsx` (I-L2-1).
 */
export const UserEntry = React.memo(UserEntryImpl);
