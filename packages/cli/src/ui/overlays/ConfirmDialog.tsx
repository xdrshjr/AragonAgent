/**
 * Confirm dialog — Yes/No gate for `confirmTools` mode. Resolves the pending
 * tool-execution promise (spec §3.6). `y` = approve; `n`/Enter/Esc = reject
 * (Enter follows the safe default shown by the capital N in the "(y/N)" prompt,
 * since this gates mutating tools like write_file/edit_file/bash).
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import type { Theme } from '../theme.js';

export interface ConfirmState {
  summary: string;
  resolve: (approved: boolean) => void;
}

interface ConfirmDialogProps {
  state: ConfirmState;
  theme: Theme;
  onClose: () => void;
}

export function ConfirmDialog({ state, theme, onClose }: ConfirmDialogProps): React.ReactElement {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      state.resolve(true);
      onClose();
    } else if (input === 'n' || input === 'N' || key.return || key.escape) {
      state.resolve(false);
      onClose();
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.noticeWarn}
      paddingX={1}
      marginTop={1}
    >
      <Text color={theme.noticeWarn} bold>
        Confirm action
      </Text>
      <Text color={theme.assistant}>{state.summary}</Text>
      <Text color={theme.muted}>Proceed? (y/N)</Text>
    </Box>
  );
}
