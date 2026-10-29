/**
 * Follow rules for the self-drawn viewport (tui-selection-and-scroll-follow
 * §4.3). PURE, React-free, unit-tested — the shape `scroll.ts`,
 * `virtual-window.ts` and `frame-differ.ts` all already use.
 *
 * It lives here rather than inside `ScrollViewport` because
 * `ink-testing-library`'s stdout stub reports no height, so a MOUNTED viewport
 * measures `content === viewport`, `overflowLines === 0`, and neither rule below
 * ever engages (`__tests__/render-at-width.ts`, and `transcript-virtual.test.tsx`
 * records the same limitation and the same workaround). A state machine that can
 * only be exercised through a box the test cannot size is a state machine with
 * no tests (P1-10).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IN THIS FILE MAY READ A MEASUREMENT (AC-17, and it is a `grep`).
 *
 * The gate is a `grep` for the name of Ink's element-measuring helper returning
 * NOTHING from this file, so that name is deliberately left unspelled here and
 * below, even where writing it would read more directly. A grep a COMMENT can
 * trip is a grep whoever runs it learns to ignore, and then the import it exists
 * to catch walks straight past it — the same reason `glyphs.test.ts` strips
 * comments before judging a line.
 *
 * The transcript's MEASURED CONTENT HEIGHT — what `ScrollViewport` reads out of
 * Ink's layout for the inner box — is the height of everything the transcript is
 * currently drawing, and FOUR different things move it — only one of which is
 * "the agent produced output":
 *
 *   1. rows appended at the tail                        <- Rule A must react
 *   2. an entry ABOVE the reading position changing     <- must NOT move
 *      height (Ctrl+T, Ctrl+O, a first real measurement
 *      of an entry that stood on an estimate)
 *   3. the scroll horizon dropping entries off the      <- must NOT move
 *      FRONT (`Transcript.tsx`, `entries.slice(-size)`)
 *   4. a re-wrap after a resize                         <- must NOT move
 *
 * For (2) and (3) `virtual-window.ts`'s invariant V-4 is explicit: counting the
 * offset FROM THE BOTTOM makes an above-the-viewport height change
 * self-compensating, and that is what buys virtualisation its "no
 * scroll-anchoring compensation pass required". Reacting to total content growth
 * would make Rule A that compensation pass, applied to changes that never needed
 * compensating — and it would additionally make (3) look like new output and arm
 * the idle timer on a transcript that produced nothing, the exact failure G6
 * exists to prevent.
 *
 * There is a second, sharper reason. `selectWindow` TAKES `offset` AS AN INPUT,
 * so the mounted set — and therefore which entries are measured rather than
 * estimated — is a function of the offset. An offset that is in turn a function
 * of the measured height closes a loop: offset -> mounted set -> measured
 * heights -> content height -> offset. The loop is broken by the INPUT rather
 * than by a convergence argument: `advanceTailRows` reads the height table and
 * never the geometry context (P0-1 / D-13).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { clampScroll } from './scroll.js';

// ---------------------------------------------------------------------------
// Rule A — tail anchoring
// ---------------------------------------------------------------------------

export interface FollowInput {
  /** Current RENDERED (already clamped) offset — see the caller's P1-9 note. */
  offset: number;
  overflowLines: number;
  /** Signed: rows appended at (or removed from) the tail since the last frame. */
  tailDelta: number;
  layoutTailDelta?: number;
  /** True while a selection drag holds the viewport (§4.4). */
  hold: boolean;
  newLinesWhilePaused: number;
}

export interface FollowOutput {
  offset: number;
  newLinesWhilePaused: number;
}

/**
 * Rule A. When rows are appended AT THE TAIL while the user is not pinned to the
 * bottom, grow the offset by the same amount: `shiftUp = overflowLines - offset`
 * is then constant and the rows on screen do not move.
 *
 * SIGNED, NOT GROWTH-ONLY (I-7). A tail SHRINK is rows that no longer exist
 * below the reading position, so shrinking the offset by the same amount is what
 * keeps the screen still — and it is self-correcting when the source of the
 * delta was an upper-bound height estimate that a later measurement brings down
 * (`estimateEntryRows` is deliberately an upper bound). An unsigned rule
 * over-counts once and never finds its way back.
 */
export function reduceFollow(input: FollowInput): FollowOutput {
  const { offset, overflowLines, tailDelta, hold } = input;

  // Pinned and not holding: anchoring is free — `offset` stays 0 and the
  // existing arithmetic keeps showing the tail. `hold` LIFTS the precondition
  // because a drag that starts while pinned must still freeze the rows under the
  // pointer (S3), and freezing means the pin becomes an anchor for the duration
  // of the drag (T-20).
  if (offset === 0 && !hold) return { offset, newLinesWhilePaused: 0 };
  const next = clampScroll(offset + tailDelta + (input.layoutTailDelta ?? 0), overflowLines);
  return {
    offset: next,
    // Only real arrivals arm the resume timer, and reaching the bottom by ANY
    // route resets the count (Rule B condition 2 / G6). Expressing the reset
    // here is what keeps it one rule rather than two.
    newLinesWhilePaused: next === 0 ? 0 : Math.max(0, input.newLinesWhilePaused + tailDelta),
  };
}

// ---------------------------------------------------------------------------
// Rule B — idle resume
// ---------------------------------------------------------------------------

export interface ResumeInput {
  /** `scrollResumeMs`; `0` (or anything non-finite) disables auto-resume. */
  resumeMs: number;
  offset: number;
  newLinesWhilePaused: number;
  hold: boolean;
}

/**
 * Rule B's three conditions, and they are three rather than one on purpose:
 *
 *  1. `offset > 0`   — there is somewhere to return FROM;
 *  2. `newLines > 0` — something arrived that is worth returning TO. THIS IS
 *     G6: a user reading a FINISHED transcript is never yanked to the bottom,
 *     which is the new bug that a timing-only rule would ship wearing the fix's
 *     clothes (D-3);
 *  3. `!hold`        — no selection drag is in progress (§4.4).
 *
 * AC-9 rides on the first line: with `scrollResumeMs: 0` this returns `false`
 * before anything else is considered, so no timer is ever created.
 */
export function shouldArmResume(input: ResumeInput): boolean {
  if (!Number.isFinite(input.resumeMs) || input.resumeMs <= 0) return false;
  if (input.offset <= 0) return false;
  if (input.newLinesWhilePaused <= 0) return false;
  if (input.hold) return false;
  return true;
}

// ---------------------------------------------------------------------------
// The tail row counter (§4.3.1a) — Rule A's ONLY legal input
// ---------------------------------------------------------------------------

/**
 * What the transcript publishes through a ref written during render.
 *
 * `lastHeight` is not decoration: §4.3.1a defines the per-frame delta as "heights
 * of entries after the previously-last entry PLUS the delta of that entry's own
 * height (a streaming entry grows in place)", and the second term cannot be
 * computed without remembering what that height was.
 */
export interface TailState {
  /** Monotonic-ish cumulative count of rows produced at the tail. Signed deltas. */
  rows: number;
  /** Identity anchor — the last entry's id when this state was written. */
  lastId: string | null;
  /** That entry's height when this state was written. */
  lastHeight: number;
}

export interface TailSink {
  current: TailState;
}

export function emptyTailState(): TailState {
  return { rows: 0, lastId: null, lastHeight: 0 };
}

/**
 * Advance the tail counter by one frame.
 *
 * `ids` are the entries the transcript is drawing, in order; `heightOf(index)`
 * is the transcript's own per-entry height table (measured where it exists, an
 * upper-bound estimate where it does not). NO GEOMETRY IS READ HERE, which is
 * what breaks P0-1's loop by construction.
 *
 * RE-ANCHORING CONTRIBUTES ZERO (R-11). When the scroll horizon drops the entry
 * this counter was anchored on, the anchor is simply moved to the new last entry
 * and the frame contributes a delta of 0. Losing one frame of anchoring is a row
 * of drift at worst; treating a FRONT-DROP as tail motion is a visible jump, and
 * an unbounded one.
 */
export function advanceTailRows(
  prev: TailState,
  ids: readonly string[],
  heightOf: (index: number) => number,
): TailState {
  if (ids.length === 0) return { rows: prev.rows, lastId: null, lastHeight: 0 };

  const lastIndex = ids.length - 1;
  const lastId = ids[lastIndex]!;
  const lastHeight = heightOf(lastIndex);

  if (prev.lastId === null) {
    // First frame: there is no "before", so there is no delta to attribute.
    return { rows: prev.rows, lastId, lastHeight };
  }

  const anchor = ids.lastIndexOf(prev.lastId);
  if (anchor === -1) {
    // The anchor is gone (horizon front-drop, `/clear`, `/reset`, `/resume`).
    return { rows: prev.rows, lastId, lastHeight };
  }

  // The anchor entry may have grown in place (a streaming tail entry), and
  // everything after it is new. Both terms are signed.
  let delta = heightOf(anchor) - prev.lastHeight;
  for (let i = anchor + 1; i <= lastIndex; i += 1) delta += heightOf(i);

  return { rows: prev.rows + delta, lastId, lastHeight };
}
