/**
 * `selectPanelRows` - which children the live roster shows (team-live-activity
 * F-2).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * THE DEFECT THIS REPLACES. `TeamPanel` took the first `panelMaxRows` runs by
 * ARRAY INDEX, and the slot pool hands out indices from a shared cursor in
 * order - so at `maxSubagents: 8, maxConcurrent: 3` the first five rows are the
 * five that finished first and everything still working sits behind `+3 more`.
 * The one thing the requirement asks the panel for - show that subagents are
 * running - is the one thing it stopped doing at the fan-out widths the
 * requirement explicitly permits.
 *
 * Pure: a function of a roster snapshot and a row cap, with no clock, no
 * terminal and no `Agent` anywhere near it.
 */

import type { SubagentRun } from './types.js';

export interface PanelRows {
  visible: SubagentRun[];
  hiddenTotal: number;
  hiddenRunning: number;
}

const RUNNING: ReadonlySet<string> = new Set(['starting', 'thinking', 'tool', 'waiting']);
const SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'aborted']);

/** 0 running, 1 queued, 2 settled. */
function group(run: SubagentRun): number {
  if (RUNNING.has(run.phase)) return 0;
  if (SETTLED.has(run.phase)) return 2;
  return 1;
}

/**
 * Rank the roster so that what is VISIBLE is what is HAPPENING.
 *
 * Ordering inside each group is chosen for ROW STABILITY, which is the real
 * usability constraint here: the panel re-renders every 200 ms and a row that
 * changes position on each tick is unreadable.
 *  - running: by `startedAt` ascending. `startedAt` changes exactly once in a
 *    run's life outside of its first assignment - on a cold-start retry (F-4),
 *    which re-stamps it (P2-4). A retried child therefore moves to the end of
 *    the running group, once, at the moment it visibly restarts. That is the
 *    correct reading of the ordering rule rather than an exception to it: the
 *    group is ordered by "how long has this been going", and a retry resets
 *    exactly that.
 *  - queued: original order; that IS the order the pool will start them in.
 *  - settled: most recently ended first, so the newest result is the one that
 *    stays on screen as others complete.
 * A run changes position at most twice in its life - queued -> running ->
 * settled - and each move carries real information.
 *
 * The final tiebreak is the original index. `Array.prototype.sort` is stable in
 * every Node this package supports, so the tiebreak is not load-bearing; it is
 * here so the ordering is total and the test can assert it without depending on
 * that guarantee.
 */
export function selectPanelRows(runs: SubagentRun[], max: number): PanelRows {
  const ranked = runs
    .map((run, index) => ({ run, index }))
    .sort((a, b) => {
      const ga = group(a.run);
      const gb = group(b.run);
      if (ga !== gb) return ga - gb;
      if (ga === 0) return (a.run.startedAt ?? 0) - (b.run.startedAt ?? 0) || a.index - b.index;
      if (ga === 2) return (b.run.endedAt ?? 0) - (a.run.endedAt ?? 0) || a.index - b.index;
      return a.index - b.index;
    })
    .map((e) => e.run);

  const limit = Math.max(0, max);
  const visible = ranked.slice(0, limit);
  const hidden = ranked.slice(limit);
  return {
    visible,
    hiddenTotal: hidden.length,
    hiddenRunning: hidden.filter((r) => RUNNING.has(r.phase)).length,
  };
}
