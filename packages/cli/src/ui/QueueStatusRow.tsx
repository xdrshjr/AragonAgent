import React from 'react';
import { Text } from 'ink';
import stringWidth from 'string-width';
import stripAnsi from 'strip-ansi';
import type { PendingSteering } from '../agent/queued-messages.js';
import type { TermCapabilities } from './capabilities.js';
import type { Theme } from './theme.js';
import { pickGlyphs } from './glyphs.js';

export interface QueueStatusRowProps {
  pending: readonly PendingSteering[];
  paused: boolean;
  columns: number;
  compact: boolean;
  theme: Theme;
  caps: TermCapabilities;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Return the first nonempty logical line without terminal control characters. */
export function queueSummary(text: string): string {
  return stripAnsi(text).split(/\r\n|[\r\n]/)
    .map((line) => line.replace(/\t/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim())
    .find(Boolean) ?? '(empty)';
}

/** Truncate at a whole grapheme, reserving the ellipsis in the same cell budget. */
export function truncateSummary(text: string, columns: number, ellipsis: string): string {
  if (stringWidth(text) <= columns) return text;
  if (columns < stringWidth(ellipsis)) return '';
  let out = '';
  let used = stringWidth(ellipsis);
  for (const { segment } of segmenter.segment(text)) {
    const width = stringWidth(segment);
    if (used + width > columns) break;
    used += width;
    out += segment;
  }
  return out + ellipsis;
}

/** Format a queue using only the columns assigned by the status bar. */
export function formatQueueStatus(props: Omit<QueueStatusRowProps, 'theme'>): {
  prefix: string; body: string; suffix: string;
} {
  if (!props.pending.length) return { prefix: '', body: '', suffix: '' };
  const prefix = props.paused
    ? (props.compact ? 'Queue(p): ' : 'Queue (paused): ') : 'Queue: ';
  const remaining = props.pending.length - 1;
  const suffix = remaining === 0 ? '' : props.compact
    ? `(+${remaining > 99 ? '99+' : remaining})` : `(+${remaining} more)`;
  const tail = suffix ? ` ${suffix}` : '';
  const budget = Math.max(0, props.columns - stringWidth(prefix + tail));
  return {
    prefix,
    body: truncateSummary(queueSummary(props.pending[0]!.text), budget, pickGlyphs(props.caps).ellipsis),
    suffix: tail,
  };
}

/** Fixed single-line pending receipt feedback; no timeout or spinner. */
export function QueueStatusRow(props: QueueStatusRowProps): React.ReactElement {
  const parts = formatQueueStatus(props);
  return <Text><Text color={props.theme.accent}>{parts.prefix}</Text>
    <Text color={props.theme.muted}>{parts.body}{parts.suffix}</Text></Text>;
}
