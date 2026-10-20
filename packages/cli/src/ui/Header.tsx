/** One-row brand bar with a fixed-width history and detail affordance. */
import React from 'react';
import { basename } from 'node:path';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { Logo, type HeaderVariant } from './Logo.js';
import { planHeaderHints, HEADER_HINT_LIMITS } from './layout/header-hints.js';

interface HeaderProps {
  cwd: string; provider: string; model: string; hasKey: boolean;
  variant: HeaderVariant; theme: Theme; caps: TermCapabilities;
  columns?: number; statusExpanded?: boolean; scrolledLines?: number; overlayOpen?: boolean;
  /**
   * Whether the expanded status row teaches `ctrl+K` (agent-model-kits §4.7).
   *
   * DEFAULTS TO TRUE because that is the requirement - `ctrl+G` must reveal the
   * kit key - and because a default of `false` would leave the one caller that
   * forgets the prop silently teaching nothing.
   */
  kitHint?: boolean;
}
export function Header({ cwd, provider, model, hasKey, variant, theme, caps,
  columns = 80, statusExpanded = false, scrolledLines = 0, overlayOpen = false,
  kitHint = true }: HeaderProps): React.ReactElement {
  // The right-hand hints are planned, not assembled (tui-branch-terminal-shortcut
  // 3.9 / D-11). `plan.text` is exactly `plan.cells` wide and already carries the
  // scroll chip's own trailing spacing, so this component can no longer clip a
  // hint by guessing one cell short - and the ladder that decides which hints
  // survive a narrow terminal lives in a pure function with its own tests.
  //
  // `kitHint` is the `^K switch kit` clause (agent-model-kits §4.7): `App`
  // passes `true` always, because the requirement is that `ctrl+G` reveals the
  // key - and the user with no kits needs that hint most.
  const plan = planHeaderHints({
    columns, statusExpanded, overlayOpen, scrolledLines, kitHint,
  });
  // THE TWO HALVES ARE SEPARATED BY CELLS, NOT BY LUCK (defect 12). The left half
  // is `wrap="truncate"`, which draws its ellipsis in the LAST cell it owns; with
  // the right half starting in the very next cell a narrow terminal read
  // `aragon...Details off` as one string. The blank column comes out of the left
  // half's width, so the row still spans exactly `columns`.
  return <Box flexDirection="row" height={1} width={columns} flexShrink={0} overflow="hidden">
    <Box width={Math.max(0, columns - plan.cells - HEADER_HINT_LIMITS.separatorCells)}
      flexShrink={0} overflow="hidden">
      <Text wrap="truncate">
        <Logo variant={variant === 'mini' ? 'mini' : 'bar'} theme={theme} caps={caps} />
        {variant !== 'mini' && <>
          <Text color={theme.accent}>{'  '}{provider}:{model}</Text>
          <Text color={theme.muted}>{'  '}{basename(cwd) || cwd}</Text>
          <Text color={hasKey ? theme.toolDone : theme.toolRunning}>{'  '}{hasKey ? theme.symbols.keyOn : theme.symbols.keyOff}</Text>
        </>}
      </Text>
    </Box>
    <Box width={HEADER_HINT_LIMITS.separatorCells} flexShrink={0} />
    <Box width={plan.cells} flexShrink={0} justifyContent="flex-end">
      <Text color={theme.muted} wrap="truncate">{plan.text}</Text>
    </Box>
  </Box>;
}
