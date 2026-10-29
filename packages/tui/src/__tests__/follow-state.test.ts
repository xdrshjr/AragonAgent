/**
 * The follow state machine (tui-selection-and-scroll-follow §4.3).
 *
 * WRITTEN AGAINST THE PURE REDUCER, not against a mounted `ScrollViewport`, and
 * that is P1-10 rather than convenience: `ink-testing-library`'s stdout stub
 * reports no height, so a mounted viewport measures `content === viewport`,
 * `overflowLines === 0`, and neither rule ever engages. `render-at-width.ts` and
 * `transcript-virtual.test.tsx` record the same limitation and the same
 * workaround.
 */

import { describe, expect, it } from 'vitest';
import {
  advanceTailRows,
  emptyTailState,
  reduceFollow,
  shouldArmResume,
  type FollowInput,
  type TailState,
} from '../ui/layout/follow-state.js';

function follow(over: Partial<FollowInput> = {}): FollowInput {
  return {
    offset: 0,
    overflowLines: 1000,
    tailDelta: 0,
    hold: false,
    newLinesWhilePaused: 0,
    ...over,
  };
}

describe('reduceFollow — Rule A (tail anchoring)', () => {
  it('T-15: +12 rows at the tail while parked at 5 moves the offset to 17', () => {
    // G4. `shiftUp = overflowLines - offset` is then CONSTANT, which is the whole
    // mechanism: the rows the user is reading do not move, and the new output
    // lands below the window instead of dragging the window along with it.
    // `overflowLines` is the AFTER value: the twelve rows are already in the
    // content when this runs, which is why the before-picture below subtracts
    // them back out.
    const out = reduceFollow(follow({ offset: 5, tailDelta: 12, overflowLines: 200 }));
    expect(out.offset).toBe(17);

    // The property the offset exists to preserve, stated directly. Before the
    // change `offset` stayed at 5 while `overflowLines` grew by 12, so `shiftUp`
    // grew by 12 and the window moved DOWN twelve rows — the reading position
    // slid off the top, which is complaint #2.
    const shiftUpBefore = 200 - 12 - 5;
    const shiftUpAfter = 200 - out.offset;
    expect(shiftUpAfter).toBe(shiftUpBefore);
    expect(out.newLinesWhilePaused).toBe(12);
  });

  it('T-16: growth while pinned and not holding leaves the offset at 0', () => {
    // Auto-follow stays FREE — no "scroll to bottom" routine, exactly as
    // `scroll.ts`'s header promises.
    const out = reduceFollow(follow({ offset: 0, tailDelta: 40 }));
    expect(out).toEqual({ offset: 0, newLinesWhilePaused: 0 });
  });

  it('T-20: `hold` anchors even from a pinned viewport', () => {
    // A drag that STARTS while pinned must still freeze the rows under the
    // pointer, so `hold` lifts Rule A's precondition. Without this the transcript
    // slides out from under the pointer during a streaming run — which is exactly
    // when users most want to copy output.
    const out = reduceFollow(follow({ offset: 0, hold: true, tailDelta: 9 }));
    expect(out.offset).toBe(9);
    expect(out.newLinesWhilePaused).toBe(9);
  });

  it('T-26: a zero tail delta never moves the offset, whatever the content did', () => {
    // ═══ P0-1, AND THE REASON THIS CASE EXISTS AT ALL ═══
    //
    // The reducer takes NO measurement. Ctrl+T, Ctrl+O, a first real measurement
    // of an entry the user just scrolled past, and the scroll horizon dropping
    // entries off the FRONT all move `measureElement(inner).height` by a lot
    // while appending nothing at the tail. `virtual-window.ts`'s V-4 says an
    // offset counted from the bottom self-compensates for every one of them;
    // reacting to total height would turn each into a jump, would arm the idle
    // timer on a transcript that produced nothing, and would close a loop from
    // the offset through `selectWindow` back to the offset.
    //
    // Written against the reducer so it cannot be satisfied by accident: the only
    // way to pass is for the rule to consume a tail delta.
    for (const overflowLines of [0, 5, 5_000]) {
      const out = reduceFollow(follow({ offset: 7, tailDelta: 0, overflowLines, newLinesWhilePaused: 3 }));
      expect(out.offset).toBe(Math.min(7, overflowLines));
      expect(out.newLinesWhilePaused).toBe(overflowLines === 0 ? 0 : 3);
    }
  });

  it('T-27: a negative tail delta walks the offset back, clamped at 0', () => {
    // I-7's signed half. While paused, a streaming tail entry may be a spacer
    // standing on `estimateEntryRows`, which is deliberately an UPPER bound; when
    // it is finally measured the tail total comes down. An unsigned rule
    // over-counts once and never finds its way back.
    expect(reduceFollow(follow({ offset: 17, tailDelta: -5, overflowLines: 200 })).offset).toBe(12);
    const bottomed = reduceFollow(follow({ offset: 3, tailDelta: -8, overflowLines: 200 }));
    expect(bottomed.offset).toBe(0);
    // Reaching the bottom by ANY route resets the paused counter (G6).
    expect(bottomed.newLinesWhilePaused).toBe(0);
  });

  it('clamps against the metrics the delta was computed from', () => {
    // P1-9. `scroll.offset` is raw state while everything on screen derives from
    // `clampScroll(...)`; accumulating past `overflowLines` would yank a viewport
    // the user believes is pinned and show a phantom chip after the next shrink.
    expect(reduceFollow(follow({ offset: 8, tailDelta: 50, overflowLines: 20 })).offset).toBe(20);
  });

  it('never lets the paused counter go negative', () => {
    const out = reduceFollow(follow({ offset: 9, tailDelta: -4, newLinesWhilePaused: 1, overflowLines: 99 }));
    expect(out.newLinesWhilePaused).toBe(0);
  });
});

describe('shouldArmResume — Rule B', () => {
  const armed = { resumeMs: 5000, offset: 12, newLinesWhilePaused: 12, hold: false };

  it('T-17: arms when there is somewhere to return from AND something to return to', () => {
    expect(shouldArmResume(armed)).toBe(true);
  });

  it('T-18: does NOT arm on a static transcript, however long the user sits there', () => {
    // ═══ G6, AND THE ONE THAT STOPS THE FIX BECOMING A NEW COMPLAINT ═══
    //
    // "除非超过一定时间用户没动" is about returning to output that ARRIVED, not
    // about a timeout. A rule keyed on time alone would yank a user reading a
    // finished transcript to the bottom every five seconds — a new bug wearing
    // the fix's clothes (D-3).
    expect(shouldArmResume({ ...armed, newLinesWhilePaused: 0 })).toBe(false);
  });

  it('does not arm when there is nowhere to return from', () => {
    expect(shouldArmResume({ ...armed, offset: 0 })).toBe(false);
  });

  it('T-19: `hold` suppresses the timer', () => {
    expect(shouldArmResume({ ...armed, hold: true })).toBe(false);
  });

  it('AC-9: `scrollResumeMs: 0` refuses before anything else is considered', () => {
    // The revert for Rule B is one config key, and it has to mean NO TIMER IS
    // EVER CREATED rather than "a timer that does nothing".
    expect(shouldArmResume({ ...armed, resumeMs: 0 })).toBe(false);
    expect(shouldArmResume({ ...armed, resumeMs: -1 })).toBe(false);
    expect(shouldArmResume({ ...armed, resumeMs: Number.NaN })).toBe(false);
  });
});

describe('advanceTailRows — the tail counter (§4.3.1a)', () => {
  /** Heights by id, so a case reads as "this entry is this tall". */
  function heights(table: Record<string, number>) {
    return (ids: string[]) => (index: number) => table[ids[index]!] ?? 0;
  }

  it('contributes nothing on the first frame', () => {
    const ids = ['a', 'b'];
    const next = advanceTailRows(emptyTailState(), ids, heights({ a: 3, b: 4 })(ids));
    expect(next).toEqual({ rows: 0, lastId: 'b', lastHeight: 4 });
  });

  it('counts entries appended after the anchor', () => {
    const table = { a: 3, b: 4, c: 5, d: 6 };
    let state: TailState = { rows: 0, lastId: 'b', lastHeight: 4 };
    const ids = ['a', 'b', 'c', 'd'];
    state = advanceTailRows(state, ids, heights(table)(ids));
    expect(state.rows).toBe(11); // c + d
    expect(state.lastId).toBe('d');
  });

  it('counts a streaming tail entry growing IN PLACE', () => {
    // The second half of §4.3.1a's definition. Without it, an assistant message
    // that streams in without a new entry ever being created would register as
    // zero tail growth, and the reading position would drift down by its whole
    // length.
    const ids = ['a'];
    const state = advanceTailRows({ rows: 0, lastId: 'a', lastHeight: 2 }, ids, () => 9);
    expect(state.rows).toBe(7);
    expect(state.lastHeight).toBe(9);
  });

  it('re-anchors with a delta of ZERO when the horizon drops the anchor (R-11)', () => {
    // ═══ THE FRONT-DROP CASE, AND IT IS THE ONE THAT MUST NOT JUMP ═══
    //
    // `Transcript.tsx` renders `entries.slice(-size)`, so on a long session the
    // OLDEST entries stop being drawn. Treating that as tail motion would be an
    // unbounded, visible jump every time the horizon slides; losing one frame of
    // anchoring is a row of drift at worst and self-corrects on the next frame.
    const ids = ['c', 'd', 'e'];
    const state = advanceTailRows(
      { rows: 40, lastId: 'gone', lastHeight: 7 },
      ids,
      heights({ c: 1, d: 2, e: 3 })(ids),
    );
    expect(state.rows).toBe(40);
    expect(state.lastId).toBe('e');
  });

  it('survives an emptied transcript (/clear, /reset)', () => {
    const state = advanceTailRows({ rows: 12, lastId: 'a', lastHeight: 3 }, [], () => 0);
    expect(state).toEqual({ rows: 12, lastId: null, lastHeight: 0 });
  });

  it('AC-17: reads only the height table, never a measurement', async () => {
    // Stated as something a grep can check rather than as a habit. The module
    // must not import `ink`, and it must not mention `measureElement` — an offset
    // that is a function of a measured height closes P0-1's loop.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(resolve(here, '../ui/layout/follow-state.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/measureElement/);
    expect(code).not.toMatch(/from 'ink'/);
    expect(code).not.toMatch(/viewport-geometry/);
  });
});


describe('unified footer anchoring', () => {
  it('combines signed deltas before one clamp', () => {
    expect(reduceFollow(follow({ offset: 60, overflowLines: 55, tailDelta: 5,
      layoutTailDelta: -10 }))).toEqual({ offset: 55, newLinesWhilePaused: 5 });
  });
  it('counts output but not footer growth or consumed padding', () => {
    expect(reduceFollow(follow({ hold: true, overflowLines: 3, tailDelta: 5,
      layoutTailDelta: -2 }))).toEqual({ offset: 3, newLinesWhilePaused: 5 });
    expect(reduceFollow(follow({ offset: 10, tailDelta: 0, layoutTailDelta: 3 })))
      .toEqual({ offset: 13, newLinesWhilePaused: 0 });
    expect(reduceFollow(follow({ offset: 10, tailDelta: 0, layoutTailDelta: -4 })))
      .toEqual({ offset: 6, newLinesWhilePaused: 0 });
  });
});
