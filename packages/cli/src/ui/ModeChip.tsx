/**
 * ModeChip — the `PLAN` badge on the composer's hint row (plan-mode §6.1).
 *
 * `theme.chip = { fg, bg }` exists in every palette and was, until now, unused.
 * A mode badge is what it was for.
 *
 * SHOWN ONLY IN PLAN MODE. `BUILD` is the default, and a badge that is always on
 * is furniture rather than signal; it also means the Build-mode composer renders
 * exactly as it did before this feature existed.
 *
 * THE CHIP IS AN ENHANCEMENT, NOT THE GUARANTEE (P1-6). It rides the hint row,
 * which disappears on a short terminal (`showHint`), under `hints: false`, and
 * in inline render mode (which mounts a bare `PromptInput` and never mounts
 * `Composer` at all). The GUARANTEED carrier is the status-bar word, which
 * renders in both `AppShell` branches and has no opt-out. If you ever move the
 * mode indicator, that is the constraint to preserve: the status bar must always
 * name a non-default mode; the chip may.
 */

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
