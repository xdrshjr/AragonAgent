/**
 * Bounded view state (tui-render-performance L1 / R5).
 *
 * `ViewState.entries` used to grow without any ceiling: `argsRaw`, assistant
 * `text` and `thinking` all concatenated forever, and the entry array was never
 * trimmed. That makes the per-frame cost of the renderer proportional to the
 * total number of characters the session has ever produced, because Ink's
 * `renderNodeToOutput` walks and measures every mounted text node whether or not
 * `overflow: hidden` clips it.
 *
 * Two bounds live here, both pure and React-free:
 *   - `appendBounded` caps one field by eliding its MIDDLE, and
 *   - `trimEntries` ring-trims the entry array itself.
 *
 * ASCII ONLY. This module is produced outside `src/ui/**`, where no terminal
 * capabilities are available, so the elision marker has to be safe on a legacy
 * `cmd.exe` -- the same rule `PREVIEW_TRUNCATION_MARK` in `reducer.ts` records.
 */

import type { Entry } from './reducer.js';
import { DEFAULT_TRANSCRIPT_RETAIN } from '../config/schema.js';

export interface EntryLimits {
  /** Assistant answer text ceiling, in characters. */
  text: number;
  /** Assistant thinking ceiling. */
  thinking: number;
  /** Streamed tool-argument JSON ceiling. */
  argsRaw: number;
}

/**
 * The per-field ceilings.
 *
 * `text` is the generous one on purpose: a 256 KiB answer is already far past
 * anything a terminal can usefully show, and the middle is what gets elided, so
 * both the opening and the live cursor survive. `argsRaw` is the tight one --
 * it is a streamed JSON fragment rendered as a 60-character card summary, so
 * anything past a few KiB is invisible by construction.
 */
export const ENTRY_LIMITS: EntryLimits = {
  text: 262_144,
  thinking: 65_536,
  argsRaw: 16_384,
};

/** Marker inserted at the elision point. ASCII -- produced outside `src/ui/**`. */
export const ELISION_MARK_PREFIX = '\n[... ';
export const ELISION_MARK_SUFFIX = ' characters elided ...]\n';

/** Matches a marker this module wrote, so re-elision collapses rather than nests. */
const ELISION_RE = /\n\[\.\.\. (\d+) characters elided \.\.\.\]\n/;

/** Fixed cost of the marker, before the digits of the count. */
const MARKER_FIXED = ELISION_MARK_PREFIX.length + ELISION_MARK_SUFFIX.length;

/**
 * Fraction of the cap reserved for the HEAD. The tail gets the rest because that
 * is where the cursor is; the head exists so the answer still starts where the
 * model started it.
 */
const HEAD_FRACTION = 4;

interface Split {
  head: string;
  elided: number;
  tail: string;
}

/** Undo one elision, so a second one merges into it rather than nesting. */
function splitElided(prev: string): Split {
  const m = ELISION_RE.exec(prev);
  if (!m) return { head: '', elided: 0, tail: prev };
  const index = m.index;
  return {
    head: prev.slice(0, index),
    elided: Number.parseInt(m[1]!, 10) || 0,
    tail: prev.slice(index + m[0].length),
  };
}

/**
 * Append `delta` to `prev`, keeping the result at or below `cap` by eliding the
 * MIDDLE. Head and tail are both preserved: the head is the answer's opening,
 * the tail is where the cursor is. Idempotent -- re-eliding an already elided
 * string collapses the two markers into one.
 *
 * The returned string is NEVER longer than `cap` (AC-7). The marker's own digit
 * count is bounded before the tail budget is computed, so the arithmetic cannot
 * overshoot by a digit the way a naive `cap - marker.length` would.
 */
export function appendBounded(prev: string, delta: string, cap: number): string {
  if (!Number.isFinite(cap) || cap <= 0) return '';

  const split = splitElided(prev);
  let head = split.head;
  let tail = split.tail + delta;
  let elided = split.elided;

  // Fast path: nothing has ever been elided and it still fits. This is the path
  // every ordinary answer takes, so it must allocate nothing beyond the concat.
  if (elided === 0 && tail.length <= cap) return tail;

  const headBudget = Math.max(0, Math.min(Math.floor(cap / HEAD_FRACTION), cap - MARKER_FIXED - 1));

  if (elided === 0) {
    // First elision: the head has to be carved out of the accumulated text.
    head = tail.slice(0, headBudget);
    tail = tail.slice(headBudget);
  } else if (head.length > headBudget) {
    // A later `cap` reduction can leave the stored head oversized; charge the
    // difference to the elision count rather than silently keeping it.
    elided += head.length - headBudget;
    head = head.slice(0, headBudget);
  }

  if (head.length + MARKER_FIXED >= cap) {
    // Degenerate cap (only reachable from a hand-written test): keep the tail.
    return tail.slice(Math.max(0, tail.length - cap));
  }

  // `elided + tail.length` is an UPPER BOUND on the final count, so its digit
  // count is an upper bound on the marker's width. Budgeting against the bound
  // is what makes the `<= cap` guarantee hold without a second pass.
  const digitBound = String(elided + tail.length).length;
  const markerBound = MARKER_FIXED + digitBound;
  const tailKeep = Math.max(0, Math.min(tail.length, cap - head.length - markerBound));
  const total = elided + (tail.length - tailKeep);

  return `${head}${ELISION_MARK_PREFIX}${total}${ELISION_MARK_SUFFIX}${tail.slice(
    tail.length - tailKeep,
  )}`;
}

export interface TrimResult {
  entries: Entry[];
  dropped: number;
}

/**
 * Ring-trim to `retain` entries; returns the SAME array reference when no-op.
 *
 * The identity return is load-bearing: the reducer spreads this result into a
 * new `ViewState` on every append, and a fresh array on every action would
 * defeat the `React.memo` boundaries L2 installs on the transcript.
 */
export function trimEntries(entries: Entry[], retain: number): TrimResult {
  const keep = Math.max(1, Math.floor(retain));
  if (entries.length <= keep) return { entries, dropped: 0 };
  return { entries: entries.slice(entries.length - keep), dropped: entries.length - keep };
}

// ---------------------------------------------------------------------------
// The resolved retain ceiling
// ---------------------------------------------------------------------------

/**
 * `viewReducer` is pure and takes no config, so the resolved `transcriptRetain`
 * reaches it through a module-level singleton -- the shape `prompt-history.ts`
 * already uses for `setHistoryEnabled`. `load.ts` is the ONLY writer.
 */
let resolvedRetain = DEFAULT_TRANSCRIPT_RETAIN;

export function setEntryRetain(value: number): void {
  if (Number.isFinite(value) && value > 0) resolvedRetain = Math.floor(value);
}

export function entryRetain(): number {
  return resolvedRetain;
}
