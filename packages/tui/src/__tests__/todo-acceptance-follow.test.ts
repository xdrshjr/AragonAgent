/**
 * Follow-through and the continuation message (todo-acceptance-criteria AC-19..
 * AC-24, AC-44).
 *
 * ONE TABLE, SIX EXITS: with steps left every exit must say exactly what it said
 * before, and in the verification phase every exit must stop claiming "0 steps
 * left". Both directions are asserted, because only one of them is new.
 */

import { describe, expect, it } from 'vitest';
import {
  advanceBudget,
  buildContinuationMessage,
  decideFollowThrough,
  emptyBudget,
  type FollowThroughBudget,
} from '../model/todo/follow-through.js';
import { TODO_FOLLOW_LIMITS } from '../model/todo/limits.js';
import type { AcceptanceItem, TodoItem, TodoSnapshot } from '../model/todo/types.js';

function steps(done: number, total: number): TodoItem[] {
  return Array.from({ length: total }, (_, i) => ({
    content: `step ${i + 1}`,
    activeForm: `doing ${i + 1}`,
    status: i < done ? 'completed' as const : 'pending' as const,
  }));
}

function criteria(statuses: ('pending' | 'passed' | 'failed')[]): AcceptanceItem[] {
  return statuses.map((status, i) => ({
    content: `criterion ${i + 1}`,
    check: `check ${i + 1}`,
    status,
    evidence: status === 'pending' ? '' : `saw ${i + 1}`,
  }));
}

function snapshot(items: TodoItem[], acceptance: AcceptanceItem[] | null): TodoSnapshot {
  return {
    items,
    total: items.length,
    doneCount: items.filter((item) => item.status === 'completed').length,
    activeIndex: items.findIndex((item) => item.status === 'in_progress'),
    updatedAt: 0,
    acceptance: acceptance
      ? {
        items: acceptance,
        total: acceptance.length,
        checkedCount: acceptance.filter((a) => a.status !== 'pending').length,
        passedCount: acceptance.filter((a) => a.status === 'passed').length,
        failedCount: acceptance.filter((a) => a.status === 'failed').length,
        updatedAt: 0,
      }
      : null,
  };
}

const decision = (
  overrides: Partial<Parameters<typeof decideFollowThrough>[0]> & { snapshot: TodoSnapshot },
) => decideFollowThrough({
  mode: 'notify',
  runEnd: { aborted: false, errored: false },
  budget: emptyBudget(),
  interactive: true,
  ...overrides,
});

describe('decideFollowThrough: the verification phase (AC-19, AC-44)', () => {
  const verifying = snapshot(steps(3, 3), criteria(['passed', 'pending', 'pending']));

  it('notify (interactive) names the criteria, not the steps', () => {
    const result = decision({ snapshot: verifying });
    expect(result).toEqual({
      kind: 'notify',
      level: 'info',
      text: '2 acceptance criteria are unchecked. Use /todo continue to finish the check, '
        + '/todo clear to drop it.',
    });
  });

  it('notify (headless) says the same thing without the slash advice', () => {
    const result = decision({ snapshot: verifying, interactive: false });
    expect(result.kind === 'notify' && result.text).toBe('2 acceptance criteria unchecked');
  });

  it('auto continues with the verify message and a notice that matches it', () => {
    const result = decision({ snapshot: verifying, mode: 'auto' });
    expect(result.kind).toBe('continue');
    if (result.kind !== 'continue') return;
    expect(result.message).toContain('Every step is complete. Verify the acceptance criteria');
    expect(result.notice).toContain('Continuing with 2 unchecked acceptance criteria in 3s');
  });

  it('the ceiling, the streak and `errored` all switch wording', () => {
    const atCeiling = decision({
      snapshot: verifying,
      mode: 'auto',
      budget: { ...emptyBudget(), used: TODO_FOLLOW_LIMITS.maxAutoContinuesPerList },
    });
    expect(atCeiling.kind).toBe('notify');
    expect(atCeiling.kind === 'notify' && atCeiling.text)
      .toContain('2 acceptance criteria are unchecked; auto-continue has run');

    const streak = decision({
      snapshot: verifying,
      mode: 'auto',
      budget: { ...emptyBudget(), noProgressStreak: TODO_FOLLOW_LIMITS.maxNoProgressContinues },
    });
    expect(streak.kind === 'notify' && streak.text).toContain(
      `the last ${TODO_FOLLOW_LIMITS.maxNoProgressContinues} attempts checked none of them`,
    );

    const errored = decision({ snapshot: verifying, runEnd: { aborted: false, errored: true } });
    expect(errored.kind === 'notify' && errored.text).toContain(
      '2 acceptance criteria are unchecked; the run ended with an error.',
    );
  });

  it('no exit ever says "0 steps" in the verification phase', () => {
    const texts: string[] = [];
    for (const overrides of [
      { mode: 'notify' as const },
      { mode: 'auto' as const },
      { mode: 'auto' as const, runEnd: { aborted: false, errored: true } },
      {
        mode: 'auto' as const,
        budget: { ...emptyBudget(), used: TODO_FOLLOW_LIMITS.maxAutoContinuesPerList },
      },
      {
        mode: 'auto' as const,
        budget: { ...emptyBudget(), noProgressStreak: TODO_FOLLOW_LIMITS.maxNoProgressContinues },
      },
    ]) {
      const result = decision({ snapshot: verifying, ...overrides });
      if (result.kind === 'notify') texts.push(result.text);
      if (result.kind === 'continue') texts.push(result.notice);
    }
    expect(texts).toHaveLength(5);
    for (const text of texts) expect(text).not.toContain('0 steps');
  });
});

describe('decideFollowThrough: the work phase is untouched (AC-44 reverse)', () => {
  const working = snapshot(steps(1, 3), criteria(['failed', 'pending']));

  it('every exit says exactly what it said before the feature', () => {
    expect(decision({ snapshot: working })).toEqual({
      kind: 'notify',
      level: 'info',
      text: '2 todo items are unfinished. Use /todo continue to pick up where this run '
        + 'stopped, or /todo clear to drop it.',
    });
    expect(decision({ snapshot: working, interactive: false })).toEqual({
      kind: 'notify',
      level: 'info',
      text: '2 steps unfinished',
    });
    const cont = decision({ snapshot: working, mode: 'auto' });
    expect(cont.kind === 'continue' && cont.notice)
      .toBe('Continuing with 2 remaining steps in 3s - Esc to stop.');
  });

  it('both halves left still counts only the steps', () => {
    const result = decision({ snapshot: snapshot(steps(1, 2), criteria(['pending'])), mode: 'auto' });
    expect(result.kind === 'continue' && result.notice).toContain('1 remaining step');
  });
});

describe('decideFollowThrough: nothing left (AC-19)', () => {
  it('is silent when the whole plan is resolved', () => {
    expect(decision({ snapshot: snapshot(steps(2, 2), criteria(['passed'])) }).kind).toBe('none');
  });

  it('is silent with no plan at all', () => {
    expect(decideFollowThrough({
      mode: 'auto',
      snapshot: null,
      runEnd: { aborted: false, errored: false },
      budget: emptyBudget(),
      interactive: true,
    })).toEqual({ kind: 'none' });
  });

  it('AC-24: off and aborted stay silent, and errored never continues', () => {
    const verifying = snapshot(steps(3, 3), criteria(['pending']));
    expect(decision({ snapshot: verifying, mode: 'off' })).toEqual({ kind: 'none' });
    expect(decision({ snapshot: verifying, mode: 'auto', runEnd: { aborted: true, errored: false } }))
      .toEqual({ kind: 'none' });
    expect(decision({ snapshot: verifying, mode: 'auto', runEnd: { aborted: false, errored: true } }).kind)
      .toBe('notify');
  });
});

describe('buildContinuationMessage (AC-21)', () => {
  it('keeps the step enumeration while steps remain', () => {
    const text = buildContinuationMessage(snapshot(steps(1, 3), null));
    expect(text).toContain('These steps are not done yet:');
    expect(text).toContain('2. step 2');
  });

  it('switches to the verify message rather than an EMPTY enumeration', () => {
    const text = buildContinuationMessage(snapshot(steps(3, 3), criteria(['pending', 'failed'])));
    expect(text).not.toContain('These steps are not done yet');
    expect(text).toContain('Verify the acceptance criteria one at a time');
    expect(text).toContain('1 failed so far');
  });
});

describe('advanceBudget (AC-23)', () => {
  const budget = (overrides: Partial<FollowThroughBudget> = {}): FollowThroughBudget => ({
    ...emptyBudget(),
    ...overrides,
  });

  it('a PURE verification turn counts as progress', () => {
    // Without this, a plan that checks one criterion per turn would be recorded as
    // "no progress" twice and would then be unable to check a third criterion.
    const before = budget({ anchorTotal: 3, doneAtRunStart: 3 });
    const after = advanceBudget(before, snapshot(steps(3, 3), criteria(['passed', 'pending'])), true);
    expect(after.noProgressStreak).toBe(0);
  });

  it('a turn that settles nothing charges the streak', () => {
    // Identity is steps PLUS criteria: 3 steps and 2 criteria is anchor 5.
    const before = budget({ anchorTotal: 5, doneAtRunStart: 3 });
    const after = advanceBudget(before, snapshot(steps(3, 3), criteria(['pending', 'pending'])), true);
    expect(after.noProgressStreak).toBe(1);
  });

  it('a re-plan is recognised by the CRITERIA count as well as the steps', () => {
    const before = budget({ anchorTotal: 5, doneAtRunStart: 3, noProgressStreak: 2 });
    // Same steps, one MORE criterion: the plan changed, so the streak is forgiven -
    // and `used` is not, which is what keeps the hard ceiling reachable.
    const grown = advanceBudget(before, snapshot(steps(3, 3), criteria(['pending', 'pending', 'pending'])), true);
    expect(grown.anchorTotal).toBe(6);
    expect(grown.noProgressStreak).toBe(0);
    expect(grown.used).toBe(before.used);
    // ...and the forgiveness is one-off: an unchanged plan charges again.
    const stalled = advanceBudget(grown, snapshot(steps(3, 3), criteria(['pending', 'pending', 'pending'])), true);
    expect(stalled.noProgressStreak).toBe(1);
    expect(stalled.anchorTotal).toBe(6);
  });

  it('a cleared plan resets the whole budget', () => {
    expect(advanceBudget(budget({ used: 4 }), null, false)).toEqual(emptyBudget());
  });
});
