/** Fixed one-row toast strip; only the newest toast is shown. */
import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { Toast, ToastLevel } from '../agent/reducer.js';

function toastColor(level: ToastLevel, theme: Theme): string | undefined {
  switch (level) {
    case 'success':
      return theme.toast.success;
    case 'warn':
      return theme.toast.warn;
    case 'error':
      return theme.toast.error;
    default:
      return theme.toast.info;
  }
}

function toastGlyph(level: ToastLevel, theme: Theme): string {
  switch (level) {
    case 'success':
      return theme.symbols.toolDone;
    case 'warn':
      return theme.symbols.warn;
    case 'error':
      return theme.symbols.error;
    default:
      return theme.symbols.info;
  }
}

export function ToastStack({
  toasts,
  theme,
}: {
  toasts: Toast[];
  theme: Theme;
}): React.ReactElement | null {
  const latest = toasts[toasts.length - 1];
  const extra = Math.max(0, toasts.length - 1);
  return (
    <Box flexShrink={0}>
      {latest ? (
        <Text wrap="truncate" color={toastColor(latest.level, theme)}>
          {' '}
          {toastGlyph(latest.level, theme)} {latest.text}
          {extra > 0 ? `  +${extra}` : ''}
        </Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
