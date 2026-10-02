/**
 * `selectTodoRows` — which items the rail shows (todo-plan-execution §3.10).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.
 *
 * PURE WINDOWING, NO OFFSET STATE ANYWHERE (non-goal 2 / R-10). Ink has no
 * absolute positioning and this codebase already owns one hand-rolled viewport
 * (`ScrollViewport`) whose invariants took a whole spec to pin down; a second
 * scrollable region with its own offset, its own intent nonce and its own wheel
 * band would be the largest source of new bugs in this feature by a wide margin.
 * The rail therefore never scrolls - it windows around the item being worked on
 * and reports what is off each end.
 *
 * THE DIRECT DESCENDANT OF `selectPanelRows`'s F-2 LESSON: the team panel
 * originally took the first five children by ARRAY INDEX, which showed the five
 * that finished FIRST and hid everything still working. Here the equivalent
 * mistake is `slice(0, maxRows)`, which on a 20-item plan shows steps 1-8 - all
 * completed - and hides the one the user is actually watching.
 */

import type { TodoItem } from './types.js';

export interface TodoRowSelection {
  visible: { item: TodoItem; index: number }[];
  hiddenAbove: number;
  hiddenBelow: number;
}

/**
 * The row the window is built around: the item in progress, or the first
 * unfinished one, or the last item when everything is done.
 *
 * `normalizeTodos` guarantees an `in_progress` item whenever one is not
 * completed (I-3), so the second branch is a belt-and-braces path for a list
 * this module was handed without going through the store.
 */
export function todoAnchorIndex(items: TodoItem[]): number {
  if (items.length === 0) return 0;
  const active = items.findIndex((item) => item.status === 'in_progress');
  if (active >= 0) return active;
  const unfinished = items.findIndex((item) => item.status !== 'completed');
  if (unfinished >= 0) return unfinished;
  return items.length - 1;
}

/**
 * How much of the window sits ABOVE the anchor.
 *
 * A QUARTER, and the asymmetry is the point: completed context above the anchor
 * is sacrificed before upcoming work below it, because the user's question is
 * "what is next", not "what is behind me".
 */
const ABOVE_SHARE = 0.25;

function windowFor(
  count: number,
  anchor: number,
  slots: number,
): { start: number; end: number } {
  if (slots >= count) return { start: 0, end: count };
  const above = Math.min(anchor, Math.max(0, Math.floor((slots - 1) * ABOVE_SHARE)));
  let start = anchor - above;
  let end = start + slots;
  if (end > count) {
    end = count;
    start = Math.max(0, end - slots);
  }
  return { start, end };
}

/**
 * @param maxRows Rows available for the item rows AND the two overflow markers
 *                together. The shared layout subtracts actual team/menu rows.
 *
 * THE ANCHOR IS ALWAYS VISIBLE, and that beats the row bound when the two
 * conflict. They can only conflict below `maxRows` 3 with overflow on BOTH
 * sides — one item plus two markers is three rows — where this returns the
 * anchor and lets the caller's `overflow="hidden"` clip a marker. Hiding the
 * one row the user is watching in order to keep a `+N above` would be the wrong
 * trade. The full rail has at least four item rows. The compact rail uses
 * `selectCompactTodoRows` with a single merged footer instead.
 */
export function selectTodoRows(items: TodoItem[], maxRows: number): TodoRowSelection {
  const count = items.length;
  const anchor = todoAnchorIndex(items);

  if (count === 0) return { visible: [], hiddenAbove: 0, hiddenBelow: 0 };
  if (maxRows <= 0) {
    return { visible: [], hiddenAbove: anchor, hiddenBelow: count - 1 - anchor };
  }

  // The marker rows and the window depend on each other: a `+N above` row costs
  // a slot, which can shrink the window, which can create a `+N below`. Two
  // passes reach the fixpoint for every input this can be handed; the loop bound
  // is a backstop, not a live case.
  let reserved = 0;
  let start = 0;
  let end = count;
  for (let pass = 0; pass < 3; pass += 1) {
    const slots = Math.max(1, maxRows - reserved);
    const win = windowFor(count, anchor, slots);
    start = win.start;
    end = win.end;
    const need = (start > 0 ? 1 : 0) + (end < count ? 1 : 0);
    if (need === reserved) break;
    reserved = need;
  }

  const visible: { item: TodoItem; index: number }[] = [];
  for (let i = start; i < end; i += 1) visible.push({ item: items[i]!, index: i });

  return { visible, hiddenAbove: start, hiddenBelow: count - end };
}

/** Select an anchored contiguous window without reserving overflow-marker rows.
 * maxItemRows is a row count; invalid/nonpositive values return an empty window
 * with every item counted below it. Does not mutate the list or throw.
 */
export function selectCompactTodoRows(items: TodoItem[], maxItemRows: number): TodoRowSelection {
  const slots = Number.isFinite(maxItemRows) ? Math.max(0, Math.floor(maxItemRows)) : 0;
  if (slots === 0 || items.length === 0) {
    return { visible: [], hiddenAbove: 0, hiddenBelow: items.length };
  }
  const { start, end } = windowFor(items.length, todoAnchorIndex(items), slots);
  return {
    visible: items.slice(start, end).map((item, offset) => ({ item, index: start + offset })),
    hiddenAbove: start,
    hiddenBelow: items.length - end,
  };
}
