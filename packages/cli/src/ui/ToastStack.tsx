/**
 * Toast stack (spec §3.9). Renders up to the 3 most-recent ephemeral toasts
 * just above the status bar. Toasts are created by App/commands for transient
 * acks and auto-dismissed by App's TTL effect; the reducer stays timer-free.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { Toast, ToastLevel } from '../agent/reducer.js';

const MAX_VISIBLE = 3;

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
  const shown = toasts.slice(-MAX_VISIBLE);
  if (shown.length === 0) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      {shown.map((t) => (
        <Text key={t.id} color={toastColor(t.level, theme)}>
          {toastGlyph(t.level, theme)} {t.text}
        </Text>
      ))}
    </Box>
  );
}
