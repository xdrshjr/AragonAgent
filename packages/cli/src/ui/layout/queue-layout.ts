import stringWidth from 'string-width';
import type { PendingSteering } from '../../agent/queued-messages.js';
import { queueSummary, truncateSummary } from '../QueueStatusRow.js';

export interface QueueLayoutInput {
  pending: readonly PendingSteering[];
  columns: number;
  terminalRows: number;
  availableRows: number;
  paused: boolean;
}
export interface QueueLayout {
  rows: number;
  title: string;
  items: readonly { queueId: string; label: string }[];
  hiddenCount: number;
}

/** One allocation drives both footer measurement and rendered rows. */
export function buildQueueLayout(input: QueueLayoutInput): QueueLayout {
  const count = input.pending.length;
  const limit = Math.max(0, Math.min(input.terminalRows >= 20 ? 4 : 2,
    Math.floor(input.availableRows)));
  if (!count || !limit) return { rows: 0, title: '', items: [], hiddenCount: count };
  const shown = Math.min(count, Math.max(1, limit - 1));
  const items = input.pending.slice(0, shown).map((item, index) => {
    const prefix = `${index + 1}. `;
    const lines = item.text.split(/\r\n|[\r\n]/).length;
    const suffix = lines > 1 ? ` (+${lines - 1}\u884c)` : '';
    return { queueId: item.queueId, label: prefix + truncateSummary(queueSummary(item.text),
      Math.max(0, input.columns - stringWidth(prefix + suffix)), '...') + suffix };
  });
  const hiddenCount = count - items.length;
  const paused = input.paused ? ' \u5df2\u6682\u505c' : '';
  const hidden = hiddenCount ? ` \u53e6${hiddenCount}\u6761` : '';
  const title = `Queue: \u5f85\u5904\u7406 ${count}${paused}${hidden} /queue`;
  if (limit === 1) return { rows: 1,
    title: truncateSummary(`Queue ${count} /queue ${items[0]!.label}`, input.columns, '...'),
    items, hiddenCount: count - items.length };
  return { rows: 1 + items.length, title: stringWidth(title) <= input.columns
    ? title : `Queue ${count} /queue`, items, hiddenCount };
}
