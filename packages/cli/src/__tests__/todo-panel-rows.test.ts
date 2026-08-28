/**
 * `selectTodoRows` — anchored windowing (AC-22, AC-28).
 *
 * AC-22 is asserted EXHAUSTIVELY over every `(length, anchor, maxRows)` triple
 * rather than over a handful of hand-picked cases, because the property it pins
 * — the item being worked on is always on screen — is exactly the one that a
 * `slice(0, maxRows)` implementation satisfies for small lists and breaks for
 * long ones. That is the F-2 lesson `selectPanelRows` records.
 */

import { describe, expect, it } from 'vitest';
import { selectTodoRows, todoAnchorIndex } from '../todo/panel-rows.js';
import { TODO_LIMITS } from '../todo/limits.js';
import type { TodoItem, TodoStatus } from '../todo/types.js';

function list(length: number, anchor: number): TodoItem[] {
  return Array.from({ length }, (_, i) => {
    const status: TodoStatus = i < anchor ? 'completed' : i === anchor ? 'in_progress' : 'pending';
    return { content: `step ${i + 1}`, activeForm: `doing ${i + 1}`, status };
  });
}

describe('selectTodoRows', () => {
  it('AC-22: the anchor is ALWAYS visible, for every length/anchor/maxRows triple', () => {
    for (let length = 1; length <= TODO_LIMITS.maxItems; length += 1) {
      for (let anchor = 0; anchor < length; anchor += 1) {
        for (let maxRows = 1; maxRows <= TODO_LIMITS.maxItems; maxRows += 1) {
          const { visible } = selectTodoRows(list(length, anchor), maxRows);
          expect(
            visible.some((v) => v.index === anchor),
            `length=${length} anchor=${anchor} maxRows=${maxRows}`,
          ).toBe(true);
        }
      }
    }
  });

  it('AC-28: a 20-item list at 10 rows shows the anchor plus both markers, and fits', () => {
    const { visible, hiddenAbove, hiddenBelow } = selectTodoRows(list(20, 9), 10);
    expect(hiddenAbove).toBeGreaterThan(0);
    expect(hiddenBelow).toBeGreaterThan(0);
    expect(visible.some((v) => v.index === 9)).toBe(true);
    // Rows used = items + one row per non-zero marker, and it never exceeds the
    // budget: Ink clips overflow from the BOTTOM, which would eat the `+N below`
    // marker — the one row whose absence is indistinguishable from a short list.
    expect(visible.length + 2).toBeLessThanOrEqual(10);
  });

  it('sacrifices COMPLETED CONTEXT ABOVE before upcoming work below', () => {
    // The user's question is "what is next", not "what is behind me".
    const { visible, hiddenAbove, hiddenBelow } = selectTodoRows(list(20, 10), 8);
    const below = visible.filter((v) => v.index > 10).length;
    const above = visible.filter((v) => v.index < 10).length;
    expect(below).toBeGreaterThan(above);
    expect(hiddenAbove).toBeGreaterThan(hiddenBelow);
  });

  it('shows everything, with no markers, when the list fits', () => {
    const { visible, hiddenAbove, hiddenBelow } = selectTodoRows(list(5, 2), 10);
    expect(visible.map((v) => v.index)).toEqual([0, 1, 2, 3, 4]);
    expect(hiddenAbove).toBe(0);
    expect(hiddenBelow).toBe(0);
  });

  it('keeps the tail on screen when the anchor is the last item', () => {
    const { visible, hiddenBelow } = selectTodoRows(list(20, 19), 6);
    expect(hiddenBelow).toBe(0);
    expect(visible.at(-1)!.index).toBe(19);
  });

  it('reports the indices it hid, so the markers can be honest', () => {
    const { visible, hiddenAbove, hiddenBelow } = selectTodoRows(list(20, 9), 7);
    expect(hiddenAbove + visible.length + hiddenBelow).toBe(20);
  });

  it('degrades rather than throwing on an empty list or a zero budget', () => {
    expect(selectTodoRows([], 5)).toEqual({ visible: [], hiddenAbove: 0, hiddenBelow: 0 });
    const { visible, hiddenAbove, hiddenBelow } = selectTodoRows(list(5, 2), 0);
    expect(visible).toEqual([]);
    expect(hiddenAbove + hiddenBelow).toBe(4);
  });
});

describe('todoAnchorIndex', () => {
  it('prefers in_progress, falls back to the first unfinished, then to the last', () => {
    expect(todoAnchorIndex(list(5, 3))).toBe(3);
    const noActive: TodoItem[] = [
      { content: 'a', activeForm: 'a', status: 'completed' },
      { content: 'b', activeForm: 'b', status: 'pending' },
    ];
    expect(todoAnchorIndex(noActive)).toBe(1);
    const allDone: TodoItem[] = noActive.map((i) => ({ ...i, status: 'completed' as const }));
    expect(todoAnchorIndex(allDone)).toBe(1);
    expect(todoAnchorIndex([])).toBe(0);
  });
});
