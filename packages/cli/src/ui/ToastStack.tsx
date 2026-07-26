/**
 * Toast strip (spec §4.8). Ephemeral acks created by App/commands and
 * auto-dismissed by App's TTL effect; the reducer stays timer-free.
 *
 * In `fullscreen` this ALWAYS occupies exactly one row — an empty row when there
 * is nothing to say. Rendering conditionally would make the viewport height (and
 * therefore the whole transcript) jump every time a toast appears or expires.
 * There is deliberately no `rows` threshold: jitter is a layout property, not a
 * space property, and a short terminal suffers it proportionally MORE, so the
 * tier that most needs the fixed row is exactly the one a threshold would skip.
 * Only the newest toast is shown; older ones collapse into a `+N` counter.
 *
 * `inline` keeps the v0.2.0 conditional 0–3 row stack: without a fixed frame,
 * growing and shrinking is just normal document flow.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from './theme.js';
import type { Toast, ToastLevel } from '../agent/reducer.js';
import type { RenderMode } from './layout/frame.js';

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
  mode = 'inline',
}: {
  toasts: Toast[];
  theme: Theme;
  mode?: RenderMode;
}): React.ReactElement | null {
  if (mode === 'fullscreen') {
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
