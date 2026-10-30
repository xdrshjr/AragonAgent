/**
 * Windowing arithmetic for the transcript's virtual list (pure; the DOM glue is in
 * `chat/Transcript.tsx`). Rows have dynamic heights: an unmeasured row uses an estimate by
 * entry kind, a measured one uses what the ResizeObserver reported.
 */

import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { TranscriptRow } from './chat-tool-groups.js';

/** Estimated heights (px) before a row is measured; close enough that the scrollbar is steady. */
const ESTIMATES: Record<Entry['kind'], number> = {
  user: 64, queued: 64, assistant: 120, tool: 40, notice: 36, governance: 60, team: 120,
  todo: 140, retry: 28, fast: 48, compaction: 36, service: 40,
};

/** Height of the fixed attachment strip (96 px thumbnails plus its gap) under a user bubble. */
export const ATTACHMENT_STRIP_ESTIMATE = 104;

/** A folded group is one header line. Opened, it is that line plus each member's own row. */
export const GROUP_ROW_PX = 40;

export function estimateHeight(row: TranscriptRow): number {
  if (row.kind === 'toolGroup') {
    return GROUP_ROW_PX + (row.expanded ? row.members.reduce((sum, member) => sum + estimateHeight(member), 0) : 0);
  }
  const entry: Entry = row;
  const base = ESTIMATES[entry.kind] ?? 60;
  if ((entry.kind === 'user' || entry.kind === 'queued') && entry.attachments?.length) {
    return base + ATTACHMENT_STRIP_ESTIMATE;
  }
  return base;
}

export interface VirtualRange {
  start: number;
  /** Exclusive. */
  end: number;
}

/** `offsets[i]` is the top of row `i`; `offsets[n]` is the total height. */
export function buildOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  let sum = 0;
  offsets[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    sum += heights[index] ?? 0;
    offsets[index + 1] = sum;
  }
  return offsets;
}

/** Index of the row containing `y` (binary search). */
export function rowAt(offsets: readonly number[], y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscanPx: number,
): VirtualRange {
  const count = offsets.length - 1;
  if (count <= 0) return { start: 0, end: 0 };
  const start = rowAt(offsets, Math.max(0, scrollTop - overscanPx));
  const end = Math.min(count, rowAt(offsets, scrollTop + viewport + overscanPx) + 1);
  return { start, end };
}
