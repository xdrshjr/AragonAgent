/**
 * The bounded, sanitised output tail one supervised service keeps
 * (background-service-supervision §4).
 *
 * ASCII ONLY: `src/proc/**` is inside the glyph scanner's scope.
 *
 * DELIBERATELY NOT `tools/tool-output-store.ts` (P2-4), which is the closest
 * existing thing and would be the reflex merge. Three differences, each
 * load-bearing:
 *
 *  - that store keeps 8 rows, this keeps 200 — one is what a card DRAWS, the
 *    other is what `bash_output` can page back through;
 *  - that store is cleared at `tool_execution_end`, and a service outlives by
 *    minutes or hours the tool call that started it;
 *  - that store has no cursor, and paging is the whole point of `since`.
 *
 * It reuses `sanitizeChunk` for the same reason that store does — the contract
 * is "terminal-safe rows", and no consumer can forget — and it follows the same
 * "two bounds are two different literals" rule.
 */

import { sanitizeChunk, toDisplayRow } from '../tools/terminal-output.js';
import { PROC_LIMITS } from './limits.js';

export interface LogRingPage {
  rows: readonly string[];
  /** Pass as the next `since`. */
  cursor: number;
  /** Rows between `since` and the first row returned were evicted. */
  truncated: boolean;
}

/**
 * A per-service ring.
 *
 * `rowsSeen` is the MONOTONIC count of completed rows ever appended, which is
 * both the paging cursor and the transcript's revision term. It is deliberately
 * not `rows.length`: the ring evicts while appending, so the length can be
 * identical across two different tails.
 */
export class LogRing {
  private readonly rows: string[] = [];
  private carry = '';
  private seen = 0;
  private evicted = 0;

  constructor(private readonly capacity: number = PROC_LIMITS.serviceTailRows) {}

  /**
   * Append a raw chunk; returns the rows it completed.
   *
   * The IN-PROGRESS line is NOT a row and is not counted: a command whose output
   * is one continuously-rewritten line (every progress bar there is) would
   * otherwise burn the whole ring on one logical line. It is rendered through
   * `toDisplayRow` by `tail()` instead, so the display still shows it.
   */
  append(chunk: string): readonly string[] {
    const { rows, carry } = sanitizeChunk(this.carry, chunk);
    this.carry = carry;
    if (rows.length === 0) return [];
    this.rows.push(...rows);
    this.seen += rows.length;
    if (this.rows.length > this.capacity) {
      const drop = this.rows.length - this.capacity;
      this.rows.splice(0, drop);
      this.evicted += drop;
    }
    return rows;
  }

  /** The last `n` display rows, in-progress line included when non-empty. */
  tail(n: number): readonly string[] {
    const live = toDisplayRow(this.carry);
    const all = live.length > 0 ? [...this.rows, live] : this.rows;
    return Object.freeze(all.length > n ? all.slice(-n) : [...all]);
  }

  /** Every completed row plus the in-progress line. */
  all(): readonly string[] {
    return this.tail(this.capacity + 1);
  }

  /** Completed rows ever appended — the paging cursor and the revision term. */
  get rowsSeen(): number {
    return this.seen;
  }

  /** The ring has dropped at least one row. */
  get truncated(): boolean {
    return this.evicted > 0;
  }

  /**
   * Rows after cursor `since`, or the whole tail when `since` is omitted.
   *
   * `truncated` reports that the cursor FELL OFF the ring — the caller asked for
   * row 3 and the oldest row still held is 57 — which is a real loss the model
   * is entitled to be told about rather than have silently papered over.
   */
  page(since?: number): LogRingPage {
    const oldest = this.seen - this.rows.length;
    if (since === undefined || since < 0) {
      return { rows: this.all(), cursor: this.seen, truncated: this.truncated };
    }
    const from = Math.max(since, oldest);
    const rows = this.rows.slice(from - oldest);
    const live = toDisplayRow(this.carry);
    const withLive = live.length > 0 ? [...rows, live] : rows;
    return {
      rows: Object.freeze(withLive),
      cursor: this.seen,
      truncated: since < oldest,
    };
  }
}
