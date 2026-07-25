/**
 * Autocomplete popup (spec §3.6). A shared bordered suggestion menu used by both
 * the slash-command palette and `@file` completion. Presentational only — the
 * suggestion list, selection index, and key handling live in `PromptInput`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';

export interface Suggestion {
  label: string;
  hint?: string;
}

interface AutocompletePopupProps {
  items: Suggestion[];
  selected: number;
  theme: Theme;
  maxRows?: number;
}

const DEFAULT_MAX_ROWS = 6;

export function AutocompletePopup({
  items,
  selected,
  theme,
  maxRows = DEFAULT_MAX_ROWS,
}: AutocompletePopupProps): React.ReactElement | null {
  if (items.length === 0) return null;

  // Keep the highlighted row within a window of `maxRows`.
  const start = Math.max(0, Math.min(selected - maxRows + 1, items.length - maxRows));
  const windowStart = Math.max(0, start);
  const visible = items.slice(windowStart, windowStart + maxRows);
  const moreBelow = items.length - (windowStart + visible.length);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
    >
      {visible.map((item, i) => {
        const idx = windowStart + i;
        const active = idx === selected;
        return (
          <Text key={item.label} inverse={active}>
            <Text color={active ? undefined : theme.primary}>{item.label}</Text>
            {item.hint ? <Text color={theme.muted}>  {item.hint}</Text> : null}
          </Text>
        );
      })}
      {moreBelow > 0 && <Text color={theme.muted}>  +{moreBelow} more</Text>}
    </Box>
  );
}
