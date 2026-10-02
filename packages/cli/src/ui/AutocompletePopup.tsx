/**
 * Autocomplete popup (spec §3.6). A shared bordered suggestion menu used by both
 * the slash-command palette and `@file` completion. Presentational only — the
 * suggestion list, selection index, and key handling live in `PromptInput`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { buildAutocompleteLayout, type AutocompleteLayout } from './layout/autocomplete.js';

export interface Suggestion {
  label: string;
  hint?: string;
}

interface AutocompletePopupProps {
  items: Suggestion[];
  selected: number;
  theme: Theme;
  caps: TermCapabilities;
  maxRows?: number;
  layout?: AutocompleteLayout;
}

export function AutocompletePopup({
  items,
  selected,
  theme,
  caps,
  maxRows,
  layout,
}: AutocompletePopupProps): React.ReactElement | null {
  const projection = layout ?? buildAutocompleteLayout({ itemCount: items.length, selected, maxRows });
  if (projection.rowCount === 0) return null;
  const glyphs = pickGlyphs(caps);
  const { start: windowStart, count, moreBelow, showMore } = projection;
  const visible = items.slice(windowStart, windowStart + count);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle={glyphs.boxStyle}
      borderColor={theme.border}
      paddingX={1}
    >
      {visible.map((item, i) => {
        const idx = windowStart + i;
        const active = idx === selected;
        return (
          <Text key={idx} inverse={active} wrap="truncate">
            <Text color={active ? undefined : theme.primary}>{item.label.replace(/\s+/g, ' ')}</Text>
            {item.hint ? <Text color={theme.muted}>  {item.hint.replace(/\s+/g, ' ')}</Text> : null}
          </Text>
        );
      })}
      {showMore && <Text wrap="truncate" color={theme.muted}>  +{moreBelow} more</Text>}
    </Box>
  );
}
