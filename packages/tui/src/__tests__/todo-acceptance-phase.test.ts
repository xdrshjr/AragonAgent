/**
 * `derivePlanPhase` / `planIsResolved` / the counting helpers, over the full
 * cartesian product (todo-acceptance-criteria AC-12, AC-44's pure halves).
 *
 * The phase is DERIVED, never stored (I-3), so the only thing worth testing is the
 * whole table: every combination of "how many steps are done" and "what verdicts
 * exist" must land in exactly one phase, and the judge that follow-through, `App`
 * and the store all share must agree with it.
 */

import { describe, expect, it } from 'vitest';
import {
  countUncheckedCriteria,
  countUnfinishedSteps,
  criteriaPhrase,
  derivePlanPhase,
  outstandingOf,
  planIsResolved,
  buildVerifyMessage,
  acceptanceSummary,
} from '../model/todo/acceptance.js';
import { VERIFY_MESSAGE_LIMITS } from '../model/todo/limits.js';
import type { AcceptanceItem, AcceptanceStatus, TodoItem, TodoSnapshot } from '../model/todo/types.js';

function steps(done: number, total: number): TodoItem[] {
  return Array.from({ length: total }, (_, i) => ({
    content: `step ${i + 1}`,
    activeForm: `doing ${i + 1}`,
    status: i < done ? 'completed' as const : 'pending' as const,
  }));
}

function criteria(statuses: AcceptanceStatus[]): AcceptanceItem[] {
  return statuses.map((status, i) => ({
    content: `criterion ${i + 1}`,
    check: `check ${i + 1}`,
    status,
    evidence: status === 'pending' || status === 'in_progress' ? '' : `saw ${i + 1}`,
  }));
}

const TABLES: Record<string, AcceptanceStatus[] | null> = {
  none: null,
  empty: [],
  pending: ['pending'],
  passed: ['passed'],
  failed: ['failed'],
  mixed: ['passed', 'failed', 'pending'],
};

describe('derivePlanPhase', () => {
  for (const done of [0, 1, 3]) {
    for (const [label, table] of Object.entries(TABLES)) {
      const acceptance = table === null ? null : criteria(table);
      const allDone = done === 3;
      const expected = !allDone
        ? 'work'
        : !acceptance || acceptance.length === 0
          ? 'done'
          : acceptance.some((item) => item.status === 'pending' || item.status === 'in_progress')
            ? 'verify'
            : 'done';
      it(`steps ${done}/3 + table "${label}" => ${expected}`, () => {
        expect(derivePlanPhase(steps(done, 3), acceptance)).toBe(expected);
      });
    }
  }

  it('an EMPTY plan is never resolved, whatever the table says', () => {
    expect(derivePlanPhase([], null)).toBe('work');
    expect(derivePlanPhase([], criteria(['passed']))).toBe('work');
    expect(planIsResolved([], null)).toBe(false);
    expect(planIsResolved([], criteria(['passed']))).toBe(false);
  });

  it('AC-43: `in_progress` counts as unresolved, which is why VERIFY keeps its anchor', () => {
    expect(derivePlanPhase(steps(3, 3), criteria(['passed', 'in_progress']))).toBe('verify');
  });
});

describe('planIsResolved', () => {
  it('is true only when every step is completed AND every criterion is settled', () => {
    expect(planIsResolved(steps(3, 3), null)).toBe(true);
    expect(planIsResolved(steps(3, 3), criteria(['passed', 'failed']))).toBe(true);
    expect(planIsResolved(steps(3, 3), criteria(['passed', 'pending']))).toBe(false);
    expect(planIsResolved(steps(2, 3), criteria(['passed']))).toBe(false);
  });
});

describe('counting helpers', () => {
  it('counts steps and criteria separately, and `outstandingOf` reports both', () => {
    const snapshot = snapshotOf(steps(2, 4), criteria(['passed', 'pending', 'failed']));
    expect(countUnfinishedSteps(snapshot.items)).toBe(2);
    expect(countUncheckedCriteria(snapshot.acceptance!.items)).toBe(1);
    expect(outstandingOf(snapshot)).toEqual({ steps: 2, checks: 1 });
  });

  it('a null table has nothing unchecked', () => {
    expect(countUncheckedCriteria(null)).toBe(0);
    expect(outstandingOf(snapshotOf(steps(1, 2), null))).toEqual({ steps: 1, checks: 0 });
  });

  it('decides singular and plural in one place', () => {
    expect(criteriaPhrase(1)).toBe('1 acceptance criterion');
    expect(criteriaPhrase(2)).toBe('2 acceptance criteria');
    expect(criteriaPhrase(0)).toBe('0 acceptance criteria');
  });
});

describe('buildVerifyMessage', () => {
  it('names the open criteria with their checks and the failures with their evidence', () => {
    const acceptance = criteria(['passed', 'failed', 'pending']);
    const text = buildVerifyMessage(snapshotOf(steps(3, 3), acceptance));
    expect(text).toContain('Every step is complete. Verify the acceptance criteria one at a time.');
    expect(text).toContain('Unchecked:');
    expect(text).toContain('3. criterion 3');
    expect(text).toContain('check: check 3');
    expect(text).toContain('1 failed so far');
    expect(text).toContain('2. criterion 2');
    expect(text).toContain('evidence: saw 2');
    expect(text.endsWith('Check ONE, then call todo_write with that verdict and its evidence.'))
      .toBe(true);
  });

  it('AC-22: bounded by CONSTRUCTION, on BOTH axes at once', () => {
    // The worst case the design accepts: twelve unchecked and twelve failed cannot
    // coexist, so build the largest legal pair and then the largest total.
    const acceptance = [
      ...criteria(Array.from({ length: 12 }, () => 'pending' as const)),
      ...criteria(Array.from({ length: 12 }, () => 'failed' as const)).map((item, i) => ({
        ...item,
        content: `failed ${i}`,
        evidence: 'e'.repeat(120),
        check: 'c'.repeat(140),
      })),
    ];
    const text = buildVerifyMessage(snapshotOf(steps(3, 3), acceptance));
    const rows = text.split('\n');
    expect(rows.length).toBeLessThanOrEqual(VERIFY_MESSAGE_LIMITS.maxRows);
    expect(text.length).toBeLessThanOrEqual(VERIFY_MESSAGE_LIMITS.maxChars);
    // 5 unchecked rows, 2 failed rows: counting them here is what keeps the bound a
    // property of the function rather than of this particular input.
    expect(text.match(/^ {3}check: /gm)?.length ?? 0).toBeGreaterThan(0);
    expect(text.match(/^ {3}check: /gm)?.length ?? 0).toBeLessThanOrEqual(
      VERIFY_MESSAGE_LIMITS.uncheckedItems,
    );
    expect(text.match(/^ {3}evidence: /gm)?.length ?? 0).toBeLessThanOrEqual(
      VERIFY_MESSAGE_LIMITS.failedItems,
    );
    // Every clipped row is clipped to the stated width.
    for (const line of rows.filter((row) => row.startsWith('   check: '))) {
      expect(line.length).toBeLessThanOrEqual('   check: '.length + VERIFY_MESSAGE_LIMITS.checkChars);
    }
  });
});

describe('acceptanceSummary', () => {
  it('derives every count from the table and stamps the injected clock', () => {
    const summary = acceptanceSummary(criteria(['passed', 'failed', 'pending']), () => 42);
    expect(summary.total).toBe(3);
    expect(summary.checkedCount).toBe(2);
    expect(summary.passedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
    expect(summary.updatedAt).toBe(42);
  });
});

function snapshotOf(items: TodoItem[], acceptance: AcceptanceItem[] | null): TodoSnapshot {
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
        checkedCount: acceptance.filter(
          (item) => item.status === 'passed' || item.status === 'failed',
        ).length,
        passedCount: acceptance.filter((item) => item.status === 'passed').length,
        failedCount: acceptance.filter((item) => item.status === 'failed').length,
        updatedAt: 0,
      }
      : null,
  };
}
