import React, { useEffect, useMemo, useRef } from 'react';
import { Text } from 'ink';
import stringWidth from 'string-width';
import type { PendingSteering } from '../../agent/queued-messages.js';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { OverlayFrame } from '../layout/OverlayFrame.js';
import { graphemes } from '../editor-navigation.js';

export interface QueueTextRow { queueId: string; offset: number; text: string }

/** Preserve visible whitespace and display terminal controls as harmless escapes. */
export function projectQueueRows(pending: readonly PendingSteering[], columns: number): QueueTextRow[] {
  const width = Math.max(1, columns);
  const rows: QueueTextRow[] = [];
  for (const [index, item] of pending.entries()) {
    rows.push({ queueId: item.queueId, offset: -1, text: `Queue ${index + 1}` });
    let text = ''; let cells = 0; let offset = 0;
    const flush = (): void => { rows.push({ queueId: item.queueId, offset, text });
      text = ''; cells = 0; };
    for (const part of graphemes(item.text)) {
      if (part.text === '\n' || part.text === '\r\n') {
        flush(); offset = part.end; continue;
      }
      const safe = part.text === '\t' ? ' '.repeat(4 - cells % 4)
        : part.text.replace(/[\x00-\x1f\x7f-\x9f]/g,
          (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
      const units = safe === part.text ? [safe] : Array.from(safe);
      for (const unit of units) {
        const size = stringWidth(unit);
        if (cells + size > width && text) { flush(); offset = part.index; }
        text += unit; cells += size;
      }
    }
    flush();
  }
  return rows;
}

/** Anchor by stable message ID and source offset, including long soft-wrapped lines. */
export function restoreQueueAnchor(before: readonly QueueTextRow[], after: readonly QueueTextRow[],
  scroll: number): number {
  const anchor = before[Math.min(scroll, before.length - 1)];
  if (!anchor || !after.length) return 0;
  let target = -1;
  for (let i = 0; i < after.length; i++) {
    if (after[i]!.queueId === anchor.queueId && after[i]!.offset <= anchor.offset) target = i;
  }
  if (target >= 0) return target;
  const next = before.slice(scroll).find((row) => after.some((item) => item.queueId === row.queueId));
  if (next) return after.findIndex((row) => row.queueId === next.queueId);
  const previous = [...before.slice(0, scroll)].reverse()
    .find((row) => after.some((item) => item.queueId === row.queueId));
  return previous ? after.findIndex((row) => row.queueId === previous.queueId) : 0;
}

export function QueueOverlay(props: {
  pending: readonly PendingSteering[]; cols: number; maxRows: number; scrollOffset: number;
  onScrollClamp: (offset: number) => void; theme: Theme; caps: TermCapabilities;
}): React.ReactElement {
  const { pending, cols, scrollOffset, onScrollClamp, theme } = props;
  const projected = useMemo(() => projectQueueRows(pending, cols - (cols >= 48 ? 4 : 2)),
    [pending, cols]);
  const previous = useRef({ rows: projected, scroll: scrollOffset });
  const anchored = previous.current.rows === projected ? scrollOffset
    : restoreQueueAnchor(previous.current.rows, projected, previous.current.scroll);
  const bodyRows = Math.max(1, Math.floor(props.maxRows) - (cols >= 48 ? 5 : 3));
  const offset = Math.max(0, Math.min(anchored, projected.length - bodyRows));
  useEffect(() => {
    previous.current = { rows: projected, scroll: offset };
    if (offset !== scrollOffset) onScrollClamp(offset);
  }, [projected, offset, scrollOffset, onScrollClamp]);
  const rows = useMemo(() => projected.length ? projected.map((row, index) =>
    <Text key={`${row.queueId}:${index}`} wrap="truncate" color={theme.primary}>{row.text || ' '}</Text>)
    : [<Text key="empty">{'\u961f\u5217\u5df2\u5904\u7406\u5b8c\u6bd5'}</Text>], [projected, theme]);
  return <OverlayFrame {...props} title={`Queue: \u5f85\u5904\u7406 ${pending.length}`}
    hint="PgUp/PgDn | Up/Down | Esc" rows={rows} scrollOffset={offset} />;
}
