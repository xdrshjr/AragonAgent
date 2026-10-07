import type { Entry } from './reducer.js';

/** Full user text retained until Core acknowledges its opaque ID. */
export interface PendingSteering {
  readonly queueId: string;
  readonly text: string;
}

/** Hide only active pending entries, using the same projection for measurement and paint. */
export function selectTranscriptEntries(entries: Entry[], pending: readonly PendingSteering[]): Entry[] {
  if (pending.length === 0) return entries;
  const ids = new Set(pending.map((item) => item.queueId));
  return entries.filter((entry) => entry.kind !== 'queued' || !ids.has(entry.queueId ?? ''));
}

/** Restore trimmed messages in FIFO order before atomically accepting known receipts. */
export function reconcileSteeringReceipt(options: {
  entries: Entry[]; pending: readonly PendingSteering[]; ids: readonly string[];
}): { entries: Entry[]; pending: PendingSteering[]; changed: boolean } {
  const receipts = new Set(options.ids);
  const ids = new Set(options.pending.filter((item) => receipts.has(item.queueId))
    .map((item) => item.queueId));
  if (!ids.size) return { entries: options.entries, pending: [...options.pending], changed: false };
  const entries = mergePendingEntries(options.entries, options.pending).map((entry): Entry =>
    entry.kind === 'queued' && ids.has(entry.queueId ?? '')
      ? { id: entry.id, kind: 'user', text: entry.text } : entry);
  return { entries, pending: options.pending.filter((item) => !ids.has(item.queueId)), changed: true };
}

/** Supplement trimmed/cleared history for save and exit without deduplicating text. */
export function mergePendingEntries(entries: Entry[], pending: readonly PendingSteering[]): Entry[] {
  if (pending.length === 0) return entries;
  const positions = new Map(pending.map((item, index) => [item.queueId, index]));
  const visible = new Map(entries.flatMap((entry) =>
    entry.kind === 'queued' && entry.queueId !== undefined
      ? [[entry.queueId, entry] as const] : []));
  const merged: Entry[] = [];
  let cursor = 0;
  const appendThrough = (last: number): void => {
    while (cursor <= last) {
      const item = pending[cursor++]!;
      const existing = visible.get(item.queueId);
      merged.push(existing ? { ...existing, text: item.text } :
        { id: `pending:${item.queueId}`, kind: 'queued', ...item });
    }
  };
  for (const entry of entries) {
    const position = entry.kind === 'queued' && entry.queueId !== undefined
      ? positions.get(entry.queueId) : undefined;
    if (position === undefined) merged.push(entry);
    else appendThrough(position);
  }
  appendThrough(pending.length - 1);
  return merged;
}
