/**
 * `selectRowsAround` — the generic anchored window (todo-acceptance-criteria §6.9.4).

ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope.

PURE WINDOWING, NO OFFSET STATE ANYWHERE (non-goal 2 / R-10). Ink has no absolute
positioning and this codebase already owns one hand-rolled viewport
(`ScrollViewport`) whose invariants took a whole spec to pin down; a second
scrollable region with its own offset, its own intent nonce and its own wheel band
would be the largest source of new bugs in that feature by a wide margin. The rail
therefore never scrolls - it windows around the row being worked on and reports
what is off each end.

THE DIRECT DESCENDANT OF `selectPanelRows`'s F-2 LESSON: the team panel originally
took the first five children by ARRAY INDEX, which showed the five that finished
FIRST and hid everything still working. Here the equivalent mistake is
`slice(0, maxRows)`, which on a 20-row plan shows rows 1-8 - all completed - and
hides the one the user is actually watching.

GENERIC OVER THE ROW TYPE (todo-acceptance-criteria §6.9.4): the todo window and
the acceptance window are the same algorithm over two different item shapes, so
the anchored-window fixpoint lives here once and three thin wrappers expose it.
The wrappers' outputs are field-for-field identical to the original todo-only
implementation (AC-13).
 */

export interface RowWindow<T> {
  visible: { item: T; index: number }[];
  hiddenAbove: number;
  hiddenBelow: number;
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
 * The anchored contiguous window, WITHOUT reserving overflow-marker rows.
 *
 * `maxRows` is a row count; invalid or non-positive values return an empty window
 * with every row counted below it, which is what makes a caller whose arithmetic
 * produced 0 render nothing rather than render everything.
 */
export function selectCompactRowsAround<T>(
  items: readonly T[],
  maxRows: number,
  anchor: (items: readonly T[]) => number,
): RowWindow<T> {
  const slots = Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 0;
  if (slots === 0 || items.length === 0) {
    return { visible: [], hiddenAbove: 0, hiddenBelow: items.length };
  }
  const { start, end } = windowFor(items.length, anchor(items), slots);
  return {
    visible: items.slice(start, end).map((item, offset) => ({ item, index: start + offset })),
    hiddenAbove: start,
    hiddenBelow: items.length - end,
  };
}

/**
 * The anchored window WITH the two overflow markers accounted for.
 *
 * THE ANCHOR IS ALWAYS VISIBLE, and that beats the row bound when the two
 * conflict. They can only conflict below `maxRows` 3 with overflow on BOTH sides
 * - one row plus two markers is three rows - where this returns the anchor and
 * lets the caller's `overflow="hidden"` clip a marker. Hiding the one row the user
 * is watching in order to keep a `+N above` would be the wrong trade.
 */
export function selectRowsAround<T>(
  items: readonly T[],
  maxRows: number,
  anchor: (items: readonly T[]) => number,
): RowWindow<T> {
  const count = items.length;
  const anchorIndex = anchor(items);

  if (count === 0) return { visible: [], hiddenAbove: 0, hiddenBelow: 0 };
  if (maxRows <= 0) {
    return {
      visible: [],
      hiddenAbove: anchorIndex,
      hiddenBelow: count - 1 - anchorIndex,
    };
  }

  // The marker rows and the window depend on each other: a `+N above` row costs a
  // slot, which can shrink the window, which can create a `+N below`. Two passes
  // reach the fixpoint for every input this can be handed; the loop bound is a
  // backstop, not a live case.
  let reserved = 0;
  let start = 0;
  let end = count;
  for (let pass = 0; pass < 3; pass += 1) {
    const slots = Math.max(1, maxRows - reserved);
    const win = windowFor(count, anchorIndex, slots);
    start = win.start;
    end = win.end;
    const need = (start > 0 ? 1 : 0) + (end < count ? 1 : 0);
    if (need === reserved) break;
    reserved = need;
  }

  const visible: { item: T; index: number }[] = [];
  for (let i = start; i < end; i += 1) visible.push({ item: items[i]!, index: i });

  return { visible, hiddenAbove: start, hiddenBelow: count - end };
}
