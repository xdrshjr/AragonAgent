/**
 * Which rows the rail shows (todo-plan-execution §3.10).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * THE ALGORITHM LIVES IN `row-window.ts` since todo-acceptance-criteria §6.9.4:
 * the acceptance section needs the same anchored-window fixpoint over a different
 * item shape, and two copies of it would be two places for the "anchor must stay
 * visible" rule to rot. The three exports below keep their EXACT signatures and
 * their field-for-field output (AC-13), so every existing caller and test is
 * unaffected.
 */

import type { AcceptanceItem, TodoItem } from './types.js';
import { selectCompactRowsAround, selectRowsAround, type RowWindow } from './row-window.js';

export type TodoRowSelection = RowWindow<TodoItem>;
export type AcceptanceRowSelection = RowWindow<AcceptanceItem>;

/**
 * The row the todo window is built around: the item in progress, or the first
 * unfinished one, or the last item when everything is done.
 *
 * `normalizeTodos` guarantees an `in_progress` item whenever one is not
 * completed (I-3), so the second branch is a belt-and-braces path for a list this
 * module was handed without going through the store.
 */
export function todoAnchorIndex(items: readonly TodoItem[]): number {
  if (items.length === 0) return 0;
  const active = items.findIndex((item) => item.status === 'in_progress');
  if (active >= 0) return active;
  const unfinished = items.findIndex((item) => item.status !== 'completed');
  if (unfinished >= 0) return unfinished;
  return items.length - 1;
}

/**
 * The row the acceptance window is built around (§6.9.4): the criterion being
 * checked, or the first unchecked one, or the last row when every verdict is in.
 *
 * THE `in_progress` BRANCH IS THE WHOLE POINT. Without it the anchor would be
 * "first pending", so re-sending the list while checking criterion 3 would snap
 * the rail back to criterion 1 - the F-2 lesson again, one feature later.
 */
export function acceptanceAnchorIndex(items: readonly AcceptanceItem[]): number {
  if (items.length === 0) return 0;
  const active = items.findIndex((item) => item.status === 'in_progress');
  if (active >= 0) return active;
  const unchecked = items.findIndex(
    (item) => item.status === 'pending' || item.status === 'in_progress',
  );
  if (unchecked >= 0) return unchecked;
  return items.length - 1;
}

/**
 * @param maxRows Rows available for the item rows AND the two overflow markers
 *                together. The shared layout subtracts actual team/menu rows.
 */
export function selectTodoRows(items: TodoItem[], maxRows: number): TodoRowSelection {
  return selectRowsAround(items, maxRows, todoAnchorIndex);
}

/** Select an anchored contiguous window without reserving overflow-marker rows. */
export function selectCompactTodoRows(items: TodoItem[], maxItemRows: number): TodoRowSelection {
  return selectCompactRowsAround(items, maxItemRows, todoAnchorIndex);
}

/** The acceptance section's window; same discipline, same anchors, other shape. */
export function selectAcceptanceRows(
  items: AcceptanceItem[],
  maxRows: number,
): AcceptanceRowSelection {
  return selectRowsAround(items, maxRows, acceptanceAnchorIndex);
}

/** The acceptance section's compact window (summary rung uses this). */
export function selectCompactAcceptanceRows(
  items: AcceptanceItem[],
  maxRows: number,
): AcceptanceRowSelection {
  return selectCompactRowsAround(items, maxRows, acceptanceAnchorIndex);
}
