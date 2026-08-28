/**
 * The CLI-local side channel a running tool's output travels on
 * (agent-activity-presentation-live L1 / §3.1.1).
 *
 * It mirrors `file-change-store.ts` in shape and in its documented reasoning,
 * with ONE deliberate difference: it is PEEK-AND-CLEAR, not take-once, because a
 * running command is read many times and consumed once.
 *
 * Four properties, each load-bearing, each with the failure it prevents:
 *
 *  - **Owner-scoped.** The key is `${owner}:${toolCallId}`, for D-13's reason
 *    unchanged: only `'lead'` is written this round, but subagents build their
 *    tools from the same factory, and a child's tool-call id must never be able
 *    to paint a lead's card.
 *  - **Sanitised on write.** `append` calls `sanitizeChunk` BEFORE storing, so
 *    the store's contract is "terminal-safe rows" and no consumer can forget.
 *  - **Bounded twice.** `LIVE_TAIL_ROWS` per call and `TOOL_OUTPUT_STORE_CAP`
 *    calls. A command emitting 400 MB to stdout costs a fixed number of retained
 *    rows: the per-call bound is what makes the DISPLAY bounded, the cap is what
 *    makes a session that never settles a call bounded.
 *  - **Cleared at settle, not at read.** The authoritative result arrives with
 *    `tool_execution_end`; from that instant the tail is superseded and must be
 *    released. Clearing there keeps the store's size a function of CONCURRENT
 *    calls rather than of total calls.
 */

import { sanitizeChunk, toDisplayRow } from './terminal-output.js';

/**
 * ROWS retained per tool call.
 *
 * THIS AND THE CAP BELOW ARE DELIBERATELY DIFFERENT NUMBERS (P2-8). They bound
 * unrelated things -- rows inside one call, and calls inside one session -- and
 * a shared literal is how a later edit collapses two bounds into one.
 */
export const LIVE_TAIL_ROWS = 8;

/** CONCURRENT CALLS retained before the oldest is evicted. */
export const TOOL_OUTPUT_STORE_CAP = 16;

/**
 * Silence after which the card stops claiming progress and says so (§3.3.4).
 *
 * It lives here rather than in `ToolCard` because it is the STORE's notion of
 * "quiet": the card reads it so there is no second copy to drift.
 */
export const STALL_AFTER_MS = 10_000;

export interface ToolOutputStore {
  /**
   * Append a raw chunk. Sanitises (§3.2), then returns the display tail: the
   * last `LIVE_TAIL_ROWS` of `[...completedRows, carry]`, `carry` last and
   * included only when non-empty.
   */
  append(owner: string, toolCallId: string, chunk: string): readonly string[];
  /** Current tail, or `undefined`. Does NOT remove. Test-facing (P2-2). */
  peek(owner: string, toolCallId: string): readonly string[] | undefined;
  /** Drop the entry -- called at `tool_execution_end`. */
  clear(owner: string, toolCallId: string): void;
  size(): number;
}

/**
 * What the controller's fourth CLI-local emitter carries (§3.1.3).
 *
 * `rows` IS THE WHOLE TAIL, not an increment, and that is what lets
 * `mergeDeltas` keep only the last one per `toolCallId` (D-30). It is frozen, so
 * a listener cannot mutate the array a later listener will see.
 */
export interface ToolOutputEvent {
  toolCallId: string;
  rows: readonly string[];
}

export type ToolOutputListener = (event: ToolOutputEvent) => void;

interface Slot {
  /** Completed rows, already terminal-safe, at most `LIVE_TAIL_ROWS` of them. */
  rows: string[];
  /**
   * The in-progress line as `sanitizeChunk` returns it: STATE, not a row. It is
   * threaded back verbatim on the next append and rendered through
   * `toDisplayRow`, never directly.
   */
  carry: string;
}

const EMPTY: readonly string[] = Object.freeze([]);

export function createToolOutputStore(cap = TOOL_OUTPUT_STORE_CAP): ToolOutputStore {
  // A `Map` iterates in insertion order, so the first key IS the oldest.
  const entries = new Map<string, Slot>();
  const limit = Math.max(1, Math.floor(cap));

  const keyOf = (owner: string, toolCallId: string): string => `${owner}:${toolCallId}`;

  /**
   * The tail a consumer sees.
   *
   * THE IN-PROGRESS LINE IS PART OF IT, and that is the display half of P0-1: a
   * command whose output is one continuously-rewritten line -- every progress
   * bar there is -- has NO completed rows until it exits, and a tail built from
   * completed rows alone would be empty for its entire run.
   */
  const tailOf = (slot: Slot): readonly string[] => {
    const live = toDisplayRow(slot.carry);
    const rows = live.length > 0 ? [...slot.rows, live] : [...slot.rows];
    return Object.freeze(rows.length > LIVE_TAIL_ROWS ? rows.slice(-LIVE_TAIL_ROWS) : rows);
  };

  return {
    append(owner, toolCallId, chunk) {
      const key = keyOf(owner, toolCallId);
      const slot = entries.get(key) ?? { rows: [], carry: '' };
      // Delete first so an append moves the key to the END of the ring rather
      // than leaving it at its original age: the cap must evict the least
      // recently WRITTEN call, not the one that started first.
      entries.delete(key);
      entries.set(key, slot);

      const { rows, carry } = sanitizeChunk(slot.carry, chunk);
      if (rows.length > 0) {
        slot.rows.push(...rows);
        if (slot.rows.length > LIVE_TAIL_ROWS) {
          slot.rows.splice(0, slot.rows.length - LIVE_TAIL_ROWS);
        }
      }
      slot.carry = carry;

      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return tailOf(slot);
    },
    peek(owner, toolCallId) {
      const slot = entries.get(keyOf(owner, toolCallId));
      if (!slot) return undefined;
      const tail = tailOf(slot);
      return tail.length > 0 ? tail : EMPTY;
    },
    clear(owner, toolCallId) {
      entries.delete(keyOf(owner, toolCallId));
    },
    size() {
      return entries.size;
    },
  };
}
