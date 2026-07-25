/** Render a user message entry. */

import React from 'react';
import { Box, Text } from 'ink';
import { SYMBOLS, type Theme } from '../theme.js';

export function UserEntry({ text, theme }: { text: string; theme: Theme }): React.ReactElement {
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text color={theme.user} bold>
        {SYMBOLS.user}{' '}
      </Text>
      <Box flexDirection="column">
        {text.split('\n').map((line, i) => (
          <Text key={i} color={theme.user}>
            {line}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
