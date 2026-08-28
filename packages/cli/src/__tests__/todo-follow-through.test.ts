/**
 * The follow-through decision table and the budget state machine
 * (todo-plan-followthrough §3.2).
 *
 * Both functions are pure, so this file needs no mounting, no fake timers and no
 * controller: it exercises the state machine DIRECTLY, which is the only way to
 * assert the property that matters most — that the worst case is arithmetic
 * (P0-1 / AC-35).
 */

import { describe, expect, it } from 'vitest';
import {
  advanceBudget,
  buildContinuationMessage,
  decideFollowThrough,
  emptyBudget,
  type FollowThroughBudget,
} from '../todo/follow-through.js';
import { TODO_FOLLOW_LIMITS } from '../todo/limits.js';
import type { TodoItem, TodoSnapshot } from '../todo/types.js';

function snapshot(total: number, doneCount: number): TodoSnapshot {
  const items: TodoItem[] = Array.from({ length: total }, (_, i) => ({
    content: `step ${i + 1}`,
    activeForm: `doing step ${i + 1}`,
    status: i < doneCount ? 'completed' : i === doneCount ? 'in_progress' : 'pending',
  }));
  return {
    items,
    total,
    doneCount,
    activeIndex: doneCount < total ? doneCount : -1,
    updatedAt: 0,
  };
}

function decide(
  over: Partial<Parameters<typeof decideFollowThrough>[0]> = {},
): ReturnType<typeof decideFollowThrough> {
  return decideFollowThrough({
    mode: 'auto',
    snapshot: snapshot(5, 2),
    runEnd: { aborted: false, errored: false },
    budget: emptyBudget(),
    interactive: true,
    ...over,
  });
}

describe('decideFollowThrough — the order is semantics, not style', () => {
  it('AC-1: `notify` + a clean end reproduces round 1s notice, STRING-IDENTICAL', () => {
    // Asserted against the literal rather than against a constant, on purpose:
    // this is the default path, and "byte-identical to bf6aeb1a" is only a claim
    // if the expected value is written out here in full.
    const d = decide({ mode: 'notify' });
    expect(d).toEqual({
      kind: 'notify',
      level: 'info',
      text:
        '3 todo items are unfinished. ' +
        'Use /todo continue to pick up where this run stopped, or /todo clear to drop it.',
    });
  });

  it('AC-1: keeps round 1s singular treatment', () => {
    const d = decide({ mode: 'notify', snapshot: snapshot(5, 4) });
    expect(d.kind === 'notify' && d.text.startsWith('1 todo item is unfinished.')).toBe(true);
  });

  it('a finished list decides nothing, in every mode', () => {
    for (const mode of ['notify', 'auto', 'off'] as const) {
      expect(decide({ mode, snapshot: snapshot(4, 4) })).toEqual({ kind: 'none' });
      expect(decide({ mode, snapshot: null })).toEqual({ kind: 'none' });
    }
  });

  it('AC-7: an ABORTED run says nothing at all, in every mode', () => {
    // A bug fix, not a policy (D-5): the user pressed Esc, and restating what
    // they interrupted is the CLI answering a question nobody asked.
    for (const mode of ['notify', 'auto', 'off'] as const) {
      expect(decide({ mode, runEnd: { aborted: true, errored: false } })).toEqual({ kind: 'none' });
    }
  });

  it('AC-8: an ERRORED run warns and NEVER continues, including in auto', () => {
    for (const mode of ['notify', 'auto'] as const) {
      const d = decide({ mode, runEnd: { aborted: false, errored: true } });
      expect(d.kind).toBe('notify');
      expect(d.kind === 'notify' && d.level).toBe('warn');
      expect(d.kind === 'notify' && d.text).toContain('ended with an error');
    }
  });

  it('an aborted run outranks an errored one', () => {
    // Esc during a failing stream is still Esc; both flags can be set.
    expect(decide({ runEnd: { aborted: true, errored: true } })).toEqual({ kind: 'none' });
  });

  it('AC-9: `off` is silent — no notice and no continuation, ever', () => {
    expect(decide({ mode: 'off' })).toEqual({ kind: 'none' });
    expect(decide({ mode: 'off', runEnd: { aborted: false, errored: true } })).toEqual({
      kind: 'none',
    });
  });

  it('AC-10: `auto` with room in the budget continues', () => {
    const d = decide();
    expect(d.kind).toBe('continue');
    expect(d.kind === 'continue' && d.graceMs).toBe(TODO_FOLLOW_LIMITS.graceMs);
    // The notice names the same number of seconds the timer will actually wait.
    expect(d.kind === 'continue' && d.notice).toContain(
      `in ${Math.round(TODO_FOLLOW_LIMITS.graceMs / 1000)}s`,
    );
    expect(d.kind === 'continue' && d.notice).toContain('Esc to stop');
  });

  it('AC-14: the total cap binds and the text NAMES it', () => {
    const budget: FollowThroughBudget = {
      ...emptyBudget(),
      used: TODO_FOLLOW_LIMITS.maxAutoContinuesPerList,
      anchorTotal: 5,
    };
    const d = decide({ budget });
    expect(d.kind).toBe('notify');
    expect(d.kind === 'notify' && d.text).toContain(
      String(TODO_FOLLOW_LIMITS.maxAutoContinuesPerList),
    );
  });

  it('AC-11: the no-progress streak hands back rather than continuing', () => {
    const budget: FollowThroughBudget = {
      ...emptyBudget(),
      noProgressStreak: TODO_FOLLOW_LIMITS.maxNoProgressContinues,
      anchorTotal: 5,
    };
    const d = decide({ budget });
    expect(d.kind).toBe('notify');
    expect(d.kind === 'notify' && d.level).toBe('warn');
    expect(d.kind === 'notify' && d.text).toContain(
      `${TODO_FOLLOW_LIMITS.maxNoProgressContinues} attempts`,
    );
    // One below the cap still continues, which is what "exactly one free nudge"
    // means (§8.1).
    const under = decide({
      budget: { ...budget, noProgressStreak: TODO_FOLLOW_LIMITS.maxNoProgressContinues - 1 },
    });
    expect(under.kind).toBe('continue');
  });

  it('headless drops the grace window and the /todo advice', () => {
    const d = decide({ interactive: false });
    expect(d.kind === 'continue' && d.graceMs).toBe(0);
    expect(d.kind === 'continue' && d.notice).toBe('continuing (3 steps left)');

    const errored = decide({ interactive: false, runEnd: { aborted: false, errored: true } });
    // `/todo continue` is not reachable from `-p`, so advertising it would be a
    // lie in the one mode with no command line to type it on.
    expect(errored.kind === 'notify' && errored.text).not.toContain('/todo');
  });

  it('every string this module produces is ASCII (C-4)', () => {
    const inputs = [
      decide({ mode: 'notify' }),
      decide({ runEnd: { aborted: false, errored: true } }),
      decide({ budget: { ...emptyBudget(), used: 99, anchorTotal: 5 } }),
      decide({ budget: { ...emptyBudget(), noProgressStreak: 9, anchorTotal: 5 } }),
      decide(),
      decide({ interactive: false }),
    ];
    for (const d of inputs) {
      const text = d.kind === 'notify' ? d.text : d.kind === 'continue' ? d.notice + d.message : '';
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/[^\x00-\x7f]/);
    }
  });
});

describe('advanceBudget — the state machine', () => {
  it('AC-15: a vanished list is the ONLY thing that clears `used`', () => {
    const spent: FollowThroughBudget = {
      used: 7,
      noProgressStreak: 1,
      anchorTotal: 5,
      doneAtRunStart: 2,
    };
    expect(advanceBudget(spent, null, true)).toEqual(emptyBudget());
  });

  it('AC-13: a re-plan zeroes the STREAK and preserves `used` (P0-1)', () => {
    const spent: FollowThroughBudget = {
      used: 7,
      noProgressStreak: 1,
      anchorTotal: 5,
      doneAtRunStart: 2,
    };
    const next = advanceBudget(spent, snapshot(9, 2), true);
    expect(next.noProgressStreak).toBe(0);
    // v1 zeroed this too, which is what made the ceiling unreachable.
    expect(next.used).toBe(7);
    expect(next.anchorTotal).toBe(9);
  });

  it('an auto-continuation that completed nothing charges the streak', () => {
    const prev: FollowThroughBudget = {
      used: 1,
      noProgressStreak: 0,
      anchorTotal: 5,
      doneAtRunStart: 2,
    };
    expect(advanceBudget(prev, snapshot(5, 2), true).noProgressStreak).toBe(1);
  });

  it('AC-12: a USER-initiated run that completed nothing does not', () => {
    // The user asking a question mid-plan is not the model failing to advance it.
    const prev: FollowThroughBudget = {
      used: 1,
      noProgressStreak: 1,
      anchorTotal: 5,
      doneAtRunStart: 2,
    };
    expect(advanceBudget(prev, snapshot(5, 2), false).noProgressStreak).toBe(1);
  });

  it('progress resets the streak, whoever started the run', () => {
    const prev: FollowThroughBudget = {
      used: 3,
      noProgressStreak: 1,
      anchorTotal: 5,
      doneAtRunStart: 2,
    };
    expect(advanceBudget(prev, snapshot(5, 3), true).noProgressStreak).toBe(0);
    expect(advanceBudget(prev, snapshot(5, 3), false).noProgressStreak).toBe(0);
  });

  it('`doneAtRunStart` tracks the CURRENT doneCount in every branch', () => {
    // The comment on the field says so, and an implementer who captures it at
    // `runStart` instead builds a different state machine that happens to agree
    // in the normal case.
    for (const wasAuto of [true, false]) {
      expect(advanceBudget(emptyBudget(), snapshot(5, 3), wasAuto).doneAtRunStart).toBe(3);
      expect(
        advanceBudget({ ...emptyBudget(), anchorTotal: 5 }, snapshot(5, 1), wasAuto)
          .doneAtRunStart,
      ).toBe(1);
    }
  });

  it('the initial zero budget re-anchors on the first snapshot without a special case', () => {
    const next = advanceBudget(emptyBudget(), snapshot(6, 0), false);
    expect(next).toEqual({ used: 0, noProgressStreak: 0, anchorTotal: 6, doneAtRunStart: 0 });
  });
});

describe('AC-35: the P0-1 scenario — a re-planning model cannot lift the ceiling', () => {
  it('continuation 26 does not fire, however the plan is reshaped', () => {
    // The model returns a DIFFERENT-SIZED list on every continuation and never
    // completes anything. Under v1's rule both counters reset every turn and
    // this loop never ends; `staleTurns` cannot save it either, because the
    // model IS calling `todo_write`.
    let budget = emptyBudget();
    let fired = 0;
    for (let turn = 0; turn < 200; turn += 1) {
      // Alternating totals, so `anchorTotal` changes on every single turn.
      const live = snapshot(turn % 2 === 0 ? 5 : 6, 0);
      budget = advanceBudget(budget, live, fired > 0);
      const d = decideFollowThrough({
        mode: 'auto',
        snapshot: live,
        runEnd: { aborted: false, errored: false },
        budget,
        interactive: true,
      });
      if (d.kind !== 'continue') break;
      budget = { ...budget, used: budget.used + 1 };
      fired += 1;
    }
    expect(fired).toBe(TODO_FOLLOW_LIMITS.maxAutoContinuesPerList);
  });

  it('a fully productive plan is never cut off by the total cap (D-14)', () => {
    // 25 > TODO_LIMITS.maxItems (20) is the point: the ceiling binds on
    // pathology, never on success.
    let budget = emptyBudget();
    let fired = 0;
    for (let done = 0; done < 20; done += 1) {
      const live = snapshot(20, done);
      budget = advanceBudget(budget, live, fired > 0);
      const d = decideFollowThrough({
        mode: 'auto',
        snapshot: live,
        runEnd: { aborted: false, errored: false },
        budget,
        interactive: true,
      });
      if (d.kind !== 'continue') break;
      budget = { ...budget, used: budget.used + 1 };
      fired += 1;
    }
    // 19 continuations carry a 20-step plan from step 1 to step 20; the 20th
    // snapshot is complete and decides `none`.
    expect(fired).toBeLessThan(TODO_FOLLOW_LIMITS.maxAutoContinuesPerList);
    expect(decideFollowThrough({
      mode: 'auto',
      snapshot: snapshot(20, 20),
      runEnd: { aborted: false, errored: false },
      budget,
      interactive: true,
    })).toEqual({ kind: 'none' });
  });
});

describe('TODO_FOLLOW_LIMITS — every constant is load-bearing (DoD-7)', () => {
  it('the total cap exceeds the item cap, or it would bind on success', () => {
    expect(TODO_FOLLOW_LIMITS.maxAutoContinuesPerList).toBeGreaterThan(20);
  });

  it('the streak cap is inside the stale window, so the user gets a sentence', () => {
    // `beginUserTurn` drops an unwritten list after `TODO_LIMITS.staleTurns` (3).
    // The streak rule firing first is what turns "the rail vanished" into "here
    // is why I stopped" (§3.5).
    expect(TODO_FOLLOW_LIMITS.maxNoProgressContinues).toBeLessThan(3);
  });

  it('the grace window is the one the notice promises', () => {
    const d = decide();
    expect(d.kind === 'continue' && d.graceMs).toBe(TODO_FOLLOW_LIMITS.graceMs);
  });
});

describe('AC-16: a continue decision carries the ENUMERATED message', () => {
  it('is `buildContinuationMessage`, not round 1s fixed string', () => {
    // The enumeration itself is covered in `todo-continuation-message.test.ts`;
    // what matters here is that the decision reaches for that function at all.
    const d = decide();
    expect(d.kind === 'continue' && d.message).toBe(buildContinuationMessage(snapshot(5, 2)));
    expect(d.kind === 'continue' && d.message).not.toBe(
      'Continue with the remaining todo items.',
    );
  });
});
