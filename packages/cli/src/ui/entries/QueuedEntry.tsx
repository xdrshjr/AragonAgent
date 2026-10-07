/**
 * Render a queued steering message (tui-shift-enter-copy-queue 5.4).
 *
 * ONE ROW, ALWAYS. `wrap="truncate"` -- the run-status-row width policy, for
 * the height-estimate reason DiffView learned the hard way: a queued message
 * can be arbitrarily long, and an entry whose wrapped height disagrees with its
 * estimate is exactly the one the virtual window never re-measures.
 *
 * The glyph and the rail belong to `EntryFrame`, exactly as for every other
 * entry; this component renders content only.
 */

import React from 'react';
import { Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';

function QueuedEntryImpl({
  text,
  theme,
  caps,
}: {
  text: string;
  theme: Theme;
  caps: TermCapabilities;
}): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const lines = text.split('\n');
  const first = lines[0] ?? '';
  const extra = lines.length - 1;
  const suffix = extra > 0 ? ` ${glyphs.ellipsis}+${extra} line${extra === 1 ? '' : 's'}` : '';
  return (
    <Text wrap="truncate" color={theme.muted}>{`Queue: ${first}${suffix}`}</Text>
  );
}

/**
 * `React.memo` with the DEFAULT comparator, like every sibling entry card: the
 * reducer rebuilds the entry object only when it changes, and a `queued` entry
 * changes exactly twice -- once when appended, once when it is rewritten into a
 * `user` entry and stops being this component's problem.
 */
export const QueuedEntry = React.memo(QueuedEntryImpl);
