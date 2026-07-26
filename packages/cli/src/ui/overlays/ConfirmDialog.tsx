/**
 * Confirm dialog — Yes/No gate for `confirmTools` mode. Resolves the pending
 * tool-execution promise (spec §3.6). `y` = approve; `n`/Enter/Esc = reject
 * (Enter follows the safe default shown by the capital N in the "(y/N)" prompt,
 * since this gates mutating tools like write_file/edit_file/bash).
 */

import React from 'react';
import { Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';

export interface ConfirmState {
  summary: string;
  resolve: (approved: boolean) => void;
}

interface ConfirmDialogProps {
  state: ConfirmState;
  maxRows: number;
  cols: number;
  theme: Theme;
  caps: TermCapabilities;
  onClose: () => void;
}

/**
 * Self-managed (mode B) and deliberately without a position indicator: five
 * rows do not need scrolling, and `state.summary` may itself be multi-line, so
 * element slicing would be meaningless here. The frame is used purely so the
 * title and border match the other three overlays; the existing `useInput` is
 * untouched.
 */
export function ConfirmDialog({
  state,
  maxRows,
  cols,
  theme,
  caps,
  onClose,
}: ConfirmDialogProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
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
    <OverlayFrame
      title="Confirm action"
      hint={`y approve ${glyphs.midDot} n / Enter / Esc reject`}
      maxRows={maxRows}
      cols={cols}
      theme={theme}
      caps={caps}
    >
      <Text color={theme.assistant}>{state.summary}</Text>
      <Text color={theme.muted}>Proceed? (y/N)</Text>
    </OverlayFrame>
  );
}
