/**
 * Render a user message entry.
 *
 * The role glyph, the gutter rail and the inter-entry spacing all belong to
 * `EntryFrame` now (§4.3), so this component renders content and nothing else.
 * That is also why it takes no `caps`: it has no glyph of its own left to
 * degrade.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';

export function UserEntry({ text, theme }: { text: string; theme: Theme }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {text.split('\n').map((line, i) => (
        <Text key={i} color={theme.user} bold={i === 0}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
