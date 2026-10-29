/**
 * Frame geometry + render-mode decision (spec §4.1 / §4.2).
 *
 * Two pure functions with zero React dependency so the load-bearing invariant
 * I-1 (`frameHeight(r) < r`) can be pinned by a unit test rather than by hope.
 */

/** Below this many rows a full-screen frame has no usable viewport left. */
export const MIN_FULLSCREEN_ROWS = 12;
/** Below this many columns the chrome (composer + status bar) cannot line-wrap sanely. */
export const MIN_FULLSCREEN_COLS = 40;
/** Used when `stdout.rows` is missing (pipes, test stubs, some PTYs). */
export const FALLBACK_ROWS = 24;
/** Used when `stdout.columns` is missing. */
export const FALLBACK_COLS = 80;

/**
 * Frame height. MUST stay strictly below `rows`:
 *  - `>= rows` hits ink.js:121, which drops incremental `eraseLines` updates and
 *    writes `clearTerminal + <all Static history> + output` on EVERY frame —
 *    30×/s under a 33 ms streaming window, with write amplification that grows
 *    monotonically with the session;
 *  - `== rows` lets the trailing '\n' log-update appends scroll the buffer by one
 *    line, so `eraseLines(previousLineCount)` drifts and the frame slowly eats
 *    the content above it.
 * `frame.test.ts` asserts `frameHeight(r) < r` for every r in [1, 200].
 *
 * The lower clamp is 0 — NEVER `MIN_FULLSCREEN_ROWS - 1` (returns 11 for
 * rows ∈ [1, 11], i.e. `>= rows`: precisely the clearTerminal disaster this
 * function exists to prevent) and NEVER 1 either, because `Math.max(1, r - 1)`
 * returns 1 for r = 1 and `1 >= 1` violates the invariant all the same. That
 * range IS reachable: §4.11 keeps the alt-screen and renders a "terminal too
 * small" placeholder when a resize drops below MIN_FULLSCREEN_ROWS, so a user
 * dragging their window down lands in it. The placeholder takes its height from
 * this same function. A 0-height frame renders nothing, which on a 1-row
 * terminal is strictly better than a per-frame full-screen repaint.
 */
export function frameHeight(rows: number | undefined): number {
  const r = rows && rows > 0 ? rows : FALLBACK_ROWS;
  return Math.max(0, r - 1);
}
