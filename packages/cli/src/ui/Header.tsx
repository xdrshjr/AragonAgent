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
  // The Ctrl+I project-index affordance sits LEFT of the ^G detail toggle:
  // collapsed it names the key and the noun ('^I Index'); expanded - the
  // same Ctrl+G state that adds the status detail row - it spells the action
  // ('^I build index'). Hidden while an overlay owns the header and below the
  // 72-column cutoff the composer hints also use: on a narrow terminal the
  // scroll chip and the ^G toggle are the two affordances that must survive.
  const indexHint = overlayOpen || columns < 72
    ? ''
    : (statusExpanded ? '^I build index  ' : '^I Index  ');
  const detail = overlayOpen ? (statusExpanded ? 'Details on' : 'Details off')
    : indexHint + '^G ' + (statusExpanded ? 'less' : 'more');
  // Widest content: '^9999+  ' (8) + '^I build index  ^G less' (23) = 31.
  const detailCells = indexHint ? 32 : 18;
  return <Box flexDirection="row" height={1} width={columns} flexShrink={0} overflow="hidden">
    <Box width={Math.max(0, columns - detailCells)} flexShrink={0} overflow="hidden">
      <Text wrap="truncate">
        <Logo variant={variant === 'mini' ? 'mini' : 'bar'} theme={theme} caps={caps} />
        {variant !== 'mini' && <>
          <Text color={theme.accent}>{'  '}{provider}:{model}</Text>
          <Text color={theme.muted}>{'  '}{basename(cwd) || cwd}</Text>
          <Text color={hasKey ? theme.toolDone : theme.toolRunning}>{'  '}{hasKey ? theme.symbols.keyOn : theme.symbols.keyOff}</Text>
        </>}
      </Text>
    </Box>
    <Box width={detailCells} flexShrink={0} justifyContent="flex-end">
      <Text color={theme.muted} wrap="truncate">{scroll + detail}</Text>
    </Box>
  </Box>;
}
