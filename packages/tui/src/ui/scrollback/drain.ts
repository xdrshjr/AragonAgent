/**
 * Static-row feed — the queue between the promotion pipeline (which decides an
 * entry is final) and the scrollback writer (which prints it)
 * (tui-native-terminal-scroll §4.3 "feed").
 *
 * FIFO, bounded. When the writer falls behind and the queue overflows, the OLDEST
 * pending entries are folded into one ASCII marker and counted: a visible, counted
 * omission, never a silent one (I-S2). Entries are taken as whole blocks and never
 * split, so a batch boundary can never land inside one entry's rows.
 */

import { SCROLLBACK_LIMITS } from './limits.js';

export interface EntryRef {
  id: string;
  kind: string;
}

export interface ScrollbackDrain {
  enqueue(rows: readonly string[], meta: EntryRef): void;
  takeAll(): readonly string[];
  /** Whole entries only; always takes at least one when anything is pending. */
  takeUpTo(maxRows: number): readonly string[];
  /** Rows waiting, including a pending overflow marker. */
  pending(): number;
  /** Whole entries waiting (the overflow marker is not an entry). */
  pendingEntries(): number;
  /** Entries folded away by overflow, cumulative. */
  elided(): number;
  onEnqueue: (() => void) | null;
  onDrained: (() => void) | null;
}

interface PendingStaticEntry {
  id: string;
  kind: string;
  rows: readonly string[];
}

export function overflowMarker(count: number): string {
  return `[${count} earlier ${count === 1 ? 'entry' : 'entries'} not printed - scrollback feed overflow]`;
}

export function createScrollbackDrain(
  options: { capacity?: number } = {},
): ScrollbackDrain {
  const capacity = Math.max(1, options.capacity ?? SCROLLBACK_LIMITS.feedCapacity);
  const queue: PendingStaticEntry[] = [];
  /** Entries folded since the marker was last printed. */
  let foldedPending = 0;
  let foldedTotal = 0;

  const markerRows = (): number => (foldedPending > 0 ? 1 : 0);

  const takeWhile = (fits: (taken: number, next: number) => boolean): readonly string[] => {
    const out: string[] = [];
    if (foldedPending > 0) {
      out.push(overflowMarker(foldedPending));
      foldedPending = 0;
    }
    while (queue.length > 0) {
      const next = queue[0]!;
      // Always take the first entry, however tall: a block taller than the cap
      // still has to print, and the writer splits at ENTRY boundaries only.
      if (out.length > 0 && !fits(out.length, next.rows.length)) break;
      queue.shift();
      for (const row of next.rows) out.push(row);
    }
    return out;
  };

  const drained = (taken: readonly string[]): readonly string[] => {
    if (taken.length > 0) drain.onDrained?.();
    return taken;
  };

  const drain: ScrollbackDrain = {
    onEnqueue: null,
    onDrained: null,
    enqueue(rows, meta) {
      queue.push({ id: meta.id, kind: meta.kind, rows });
      while (queue.length > capacity) {
        queue.shift();
        foldedPending += 1;
        foldedTotal += 1;
      }
      drain.onEnqueue?.();
    },
    takeAll: () => drained(takeWhile(() => true)),
    takeUpTo: (maxRows) => drained(takeWhile((taken, next) => taken + next <= maxRows)),
    pending: () => queue.reduce((sum, entry) => sum + entry.rows.length, markerRows()),
    pendingEntries: () => queue.length,
    elided: () => foldedTotal,
  };
  return drain;
}
