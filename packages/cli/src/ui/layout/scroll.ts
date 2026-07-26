/**
 * Scroll maths for the self-drawn viewport (spec §4.5). Pure, React-free.
 *
 * `offset` counts LINES FROM THE BOTTOM — equivalently, the number of rows
 * currently hidden BELOW the viewport. `0` means pinned to the newest output;
 * `overflowLines` means parked at the very top. Counting from the bottom is what
 * makes auto-follow free: when new content arrives `overflowLines` grows while
 * `offset` stays 0, so the viewport keeps showing the tail without anyone
 * calling a "scroll to bottom" routine.
 *
 * The rows hidden ABOVE are therefore `overflowLines - offset`. Mixing the two
 * up inverts both the bottom-snap test and the "N new lines" hint.
 */

export interface ScrollState {
  offset: number;
}

export interface ViewportMetrics {
  /** Visible height of the clipping box, in rows. */
  viewport: number;
  /** Natural (unclipped) height of the content, in rows. */
  content: number;
}

export type ScrollIntent =
  | 'lineUp'
  | 'lineDown'
  | 'pageUp'
  | 'pageDown'
  | 'toTop'
  | 'toBottom';

/**
 * Rows of context kept across a page turn, and — not a coincidence — the
 * bottom-snap tolerance. The tolerance must be >= whatever a page turn can
 * leave behind, or PgDn parks the user in a fake off-bottom state that they
 * cannot press their way out of.
 */
const PAGE_CONTEXT_LINES = 2;
export const BOTTOM_SNAP_TOLERANCE = PAGE_CONTEXT_LINES;

export function clampScroll(offset: number, overflowLines: number): number {
  const max = Math.max(0, overflowLines);
  if (!Number.isFinite(offset) || offset < 0) return 0;
  return Math.min(Math.floor(offset), max);
}

export function pageSize(viewportHeight: number): number {
  return Math.max(1, Math.floor(viewportHeight) - PAGE_CONTEXT_LINES);
}

export function isPinnedToBottom(state: ScrollState): boolean {
  return state.offset === 0;
}

/** Intents that move toward the newest output; only these snap to the bottom. */
function isDownward(intent: ScrollIntent): boolean {
  return intent === 'lineDown' || intent === 'pageDown' || intent === 'toBottom';
}

export function applyScroll(
  state: ScrollState,
  intent: ScrollIntent,
  metrics: ViewportMetrics,
): ScrollState {
  const overflowLines = Math.max(0, metrics.content - metrics.viewport);
  const page = pageSize(metrics.viewport);

  let next: number;
  switch (intent) {
    case 'lineUp':
      next = state.offset + 1;
      break;
    case 'lineDown':
      next = state.offset - 1;
      break;
    case 'pageUp':
      next = state.offset + page;
      break;
    case 'pageDown':
      next = state.offset - page;
      break;
    case 'toTop':
      next = overflowLines;
      break;
    case 'toBottom':
      next = 0;
      break;
  }

  const clamped = clampScroll(next, overflowLines);
  // `offset` IS the number of rows hidden below the viewport, so proximity to
  // the bottom is `offset <= tolerance` — not `overflowLines - offset`, which
  // measures the distance to the TOP. Without the snap, a PgDn that lands one
  // row short parks the user in a fake off-bottom state (a stuck `↑1` and a
  // permanent "new lines" hint) that no further PgDn can clear, because the
  // hint row itself shrinks the viewport and keeps re-introducing the residue.
  //
  // Downward intents only: with the correct comparison, snapping on the way up
  // would turn `lineUp` from a pinned viewport into a no-op.
  if (isDownward(intent) && clamped <= BOTTOM_SNAP_TOLERANCE) {
    return { offset: 0 };
  }
  return { offset: clamped };
}
