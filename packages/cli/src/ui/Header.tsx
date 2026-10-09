/** One-row brand bar with a fixed-width history and detail affordance. */
import React from 'react';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { Logo, type HeaderVariant } from './Logo.js';

interface HeaderProps {
  cwd: string; provider: string; model: string; hasKey: boolean;
  variant: HeaderVariant; theme: Theme; caps: TermCapabilities;
  columns?: number; statusExpanded?: boolean; scrolledLines?: number; overlayOpen?: boolean;
}
export function Header({ cwd, provider, model, hasKey, variant, theme, caps,
  columns = 80, statusExpanded = false, scrolledLines = 0, overlayOpen = false }: HeaderProps): React.ReactElement {
  const scroll = Number.isFinite(scrolledLines) && scrolledLines > 0
    ? (scrolledLines > 9999 ? '^9999+' : '^' + Math.floor(scrolledLines)) + (overlayOpen ? ' ' : '  ') : '';
  const detail = overlayOpen ? (statusExpanded ? 'Details on' : 'Details off')
    : '^G ' + (statusExpanded ? 'less' : 'more');
  return <Box flexDirection="row" height={1} width={columns} flexShrink={0} overflow="hidden">
    <Box width={Math.max(0, columns - 18)} flexShrink={0} overflow="hidden">
      <Text wrap="truncate">
        <Logo variant={variant === 'mini' ? 'mini' : 'bar'} theme={theme} caps={caps} />
        {variant !== 'mini' && <>
          <Text color={theme.accent}>{'  '}{provider}:{model}</Text>
          <Text color={theme.muted}>{'  '}{basename(cwd) || cwd}</Text>
          <Text color={hasKey ? theme.toolDone : theme.toolRunning}>{'  '}{hasKey ? theme.symbols.keyOn : theme.symbols.keyOff}</Text>
        </>}
      </Text>
    </Box>
    <Box width={18} flexShrink={0} justifyContent="flex-end">
      <Text color={theme.muted} wrap="truncate">{scroll + detail}</Text>
    </Box>
  </Box>;
}
