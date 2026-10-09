/**
 * Confirm dialog — Yes/No gate for `confirmTools` mode. Resolves the pending
 * tool-execution promise (spec §3.6). `y` = approve; `n`/Enter/Esc = reject
 * (Enter follows the safe default shown by the capital N in the "(y/N)" prompt,
 * since this gates mutating tools like write_file/edit_file/bash).
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { wrapToRows } from '../layout/wrap-rows.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';

export interface ConfirmState {
  summary: string;
  resolve: (approved: boolean) => void;
}

interface ConfirmDialogProps {
  isActive?: boolean;
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
  state, isActive = true,
  maxRows,
  cols,
  theme,
  caps,
  onClose,
}: ConfirmDialogProps): React.ReactElement {
  const glyphs = pickGlyphs(caps);
  const [offset, setOffset] = useState(0);
  useInput((input, key) => {
    if (!isActive) return;
    if (key.pageUp || key.upArrow) { setOffset(n => Math.max(0, n - 1)); return; }
    if (key.pageDown || key.downArrow) { setOffset(n => n + 1); return; }
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
      hint="y approve | n/Enter/Esc reject | PgDn"
      maxRows={maxRows}
      cols={cols}
      theme={theme}
      caps={caps}
      scrollOffset={offset} onScrollClamp={setOffset}
      rows={wrapToRows(state.summary, Math.max(1, cols - 4)).map((line, index) =>
        <Text key={index} wrap="truncate" color={theme.assistant}>{line || ' '}</Text>)}
    />
  );
}
