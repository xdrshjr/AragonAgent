import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { MODE_LABEL, type AgentMode } from '../agent/agent-mode.js';

interface ModeChipProps {
  mode: AgentMode;
  theme: Theme;
  caps: TermCapabilities;
}

/**
 * Columns `ModeChip` occupies, including its trailing gap (plan => label + 3, any
 * other mode 0). Both render branches (padded background chip, bracketed text)
 * come to the same width, which is what lets the run status row budget for it
 * without measuring a rendered element.
 */
export function modeChipCols(mode: AgentMode): number {
  return mode === 'plan' ? MODE_LABEL[mode].length + 3 : 0;
}

export function ModeChip({ mode, theme, caps }: ModeChipProps): React.ReactElement | null {
  if (mode !== 'plan') return null;
  const label = MODE_LABEL[mode];

  // `Box backgroundColor` degrades to plain text at colorLevel 0, where the chip
  // would become invisible against the hint row. Brackets carry the same
  // "this is a badge" reading with no color at all.
  if (caps.colorLevel === 0) {
    return (
      <Text wrap="truncate" bold>
        [{label}]{' '}
      </Text>
    );
  }

  return (
    <Box flexShrink={0} marginRight={1}>
      <Text backgroundColor={theme.chip.bg} color={theme.chip.fg} bold>
        {' '}
        {label}{' '}
      </Text>
    </Box>
  );
}
