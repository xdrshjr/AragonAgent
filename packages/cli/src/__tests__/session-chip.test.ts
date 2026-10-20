/**
 * The session-id chip planner (tui-session-id-resume 7.1 T-22..T-25 / D-12).
 *
 * THE ORDER OF THE RUNGS IS THE DECISION. The label goes first, then the whole
 * chip; the id itself is NEVER shortened, because a truncated id produces a
 * `--resume` command that is guaranteed to fail. 43 columns is the last width
 * that still shows a 6-character id, and it is measured against
 * `SESSION_CHIP_LIMITS.minStatusCells` rather than guessed.
 */

import { describe, expect, it } from 'vitest';
import { SESSION_CHIP_LIMITS, planSessionChip } from '../ui/layout/session-chip.js';

const ID = 'a4k2m9';

describe('T-22 / D-12: the labelled chip', () => {
  it('shows the labelled chip on a wide terminal', () => {
    const plan = planSessionChip({ columns: 120, sessionId: ID });
    expect(plan.visible).toBe(true);
    expect(plan.text).toBe(`id ${ID}`);
    expect(plan.cells).toBe(9);
    expect(plan.gap).toBe(SESSION_CHIP_LIMITS.gapCells);
  });

  it('T-23: drops the label before it touches the id', () => {
    const plan = planSessionChip({ columns: 70, sessionId: ID });
    expect(plan.text).toBe(ID);
    expect(plan.cells).toBe(6);
    expect(plan.visible).toBe(true);
  });
});

describe('T-24: never truncates an id', () => {
  it('shows the whole id at the last width that fits', () => {
    // 43 - 1 (redraw carrier) - 2 (gap) - 6 (id) = 34 = minStatusCells exactly.
    const plan = planSessionChip({ columns: 43, sessionId: ID });
    expect(plan.visible).toBe(true);
    expect(plan.text).toBe(ID);
  });

  it('hides entirely one column below that', () => {
    const plan = planSessionChip({ columns: 42, sessionId: ID });
    expect(plan).toEqual({ visible: false, text: '', cells: 0, gap: 0 });
  });

  it('walks the full range without ever emitting a partial id', () => {
    for (let columns = 1; columns <= 200; columns += 1) {
      const plan = planSessionChip({ columns, sessionId: ID });
      if (!plan.visible) continue;
      // Either the full label or the full id - never a slice of either.
      expect([`id ${ID}`, ID]).toContain(plan.text);
    }
  });
});

describe('T-25 / I-6: absent when there is no id', () => {
  it('is absent when the session has no id', () => {
    expect(planSessionChip({ columns: 120 })).toEqual({
      visible: false,
      text: '',
      cells: 0,
      gap: 0,
    });
    expect(planSessionChip({ columns: 120, sessionId: null })).toEqual({
      visible: false,
      text: '',
      cells: 0,
      gap: 0,
    });
    expect(planSessionChip({ columns: 120, sessionId: '' })).toEqual({
      visible: false,
      text: '',
      cells: 0,
      gap: 0,
    });
  });

  it('falls back to 80 columns for a width it cannot measure', () => {
    // THE SAME FALLBACK `planPrimaryStatusFields` USES, deliberately: the two
    // plans must agree about the terminal, and "unknown" has one answer in this
    // row. A real 0 or negative width is a different thing - that is a terminal
    // measuring nothing, so nothing is drawn.
    for (const columns of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planSessionChip({ columns, sessionId: ID }).text).toBe(`id ${ID}`);
    }
    for (const columns of [-5, 0, 5]) {
      expect(planSessionChip({ columns, sessionId: ID }).visible).toBe(false);
    }
  });
});
