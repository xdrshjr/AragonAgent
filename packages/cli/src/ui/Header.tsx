/** One-row brand bar, with a compact variant for narrow terminals. */
import React from 'react';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { Logo, type HeaderVariant } from './Logo.js';

interface HeaderProps {
  cwd: string;
  provider: string;
  model: string;
  hasKey: boolean;
  variant: HeaderVariant;
  theme: Theme;
  caps: TermCapabilities;
}

export function Header({
  cwd,
  provider,
  model,
  hasKey,
  variant,
  theme,
  caps,
}: HeaderProps): React.ReactElement {
  if (variant === 'mini') {
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text wrap="truncate">
          <Logo variant="mini" theme={theme} caps={caps} />
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <Text wrap="truncate">
        <Logo variant="bar" theme={theme} caps={caps} />
        <Text color={theme.accent}>
          {'  '}
          {provider}:{model}
        </Text>
        <Text color={theme.muted}>{'  '}{basename(cwd) || cwd}</Text>
        <Text color={hasKey ? theme.toolDone : theme.toolRunning}>
          {'  '}
          {hasKey ? theme.symbols.keyOn : theme.symbols.keyOff}
        </Text>
      </Text>
    </Box>
  );
}
