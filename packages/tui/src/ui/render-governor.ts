/**
 * Adaptive render governor (tui-render-performance L4 / R7). Pure, React-free.
 *
 * Neither the streaming coalescer nor Ink adapts when a frame overruns its
 * budget: the coalescer keeps its 33 ms timer, Ink keeps its 32 ms throttle, and
 * the event loop saturates. Renders then queue behind each other on Node's
 * single thread and KEYSTROKES QUEUE BEHIND THE RENDERS — which is what turns a
 * slow frame into an unresponsive terminal.
 *
 * The ladder is the safety net under L1/L2/L3, not a substitute for them: it
 * cannot make a frame cheaper, only rarer. Its job is to turn any residual
 * pathology from a freeze into a visibly slower but still interactive UI.
 *
 * I-L4-1 — the governor changes only HOW OFTEN the view updates. Never what is
 * dispatched, never the order, never the final state. `mergeDeltas` already
 * guarantees that a longer window is simply a larger merge and that any
 * non-delta action flushes the pending run first, so the same event sequence
 * must produce the same final `ViewState` at every rung
 * (`render-governor.test.ts`).
 */

/** Coalescing intervals, in ms. Rung 0 is the pre-feature `COALESCE_MS`. */
export const GOVERNOR_LADDER = [33, 50, 80, 125, 200, 320] as const;

/** Step up when a commit costs more than this fraction of the current interval. */
export const GOVERNOR_UP_RATIO = 0.7;

/**
 * Consecutive cheap frames required before stepping back down.
 *
 * Hysteresis, and it has to be asymmetric: stepping up on one expensive frame
 * and down on one cheap one would oscillate through the whole ladder while a
 * long answer streams past a couple of code blocks.
 */
export const GOVERNOR_DOWN_STREAK = 8;

export interface GovernorState {
  rung: number;
  cheapStreak: number;
}

export function initialGovernor(): GovernorState {
  return { rung: 0, cheapStreak: 0 };
}

/** Highest rung reachable under `maxIntervalMs`. Always at least 0. */
function topRung(maxIntervalMs: number): number {
  let top = 0;
  for (let i = 1; i < GOVERNOR_LADDER.length; i += 1) {
    if (GOVERNOR_LADDER[i]! <= maxIntervalMs) top = i;
  }
  return top;
}

/**
 * The coalescing interval for a state.
 *
 * Clamped to `maxIntervalMs` in BOTH directions: `maxRenderIntervalMs = 33`
 * flattens the ladder to one rung, which is the documented way to get the
 * pre-feature cadence without reaching for the kill switch.
 */
export function intervalOf(state: GovernorState, maxIntervalMs: number): number {
  const ceiling = Number.isFinite(maxIntervalMs) ? maxIntervalMs : GOVERNOR_LADDER[0]!;
  const rung = Math.min(Math.max(0, Math.floor(state.rung)), topRung(ceiling));
  return Math.min(ceiling, GOVERNOR_LADDER[rung] ?? GOVERNOR_LADDER[0]!);
}

/**
 * Fold one commit's cost into the ladder.
 *
 * `lastCommitMs` covers React reconciliation AND Ink's yoga layout, because Ink
 * computes layout in `onRender`, which React runs before layout effects. It does
 * NOT cover Ink's serialisation and the stdout write, which happen after. In
 * practice layout dominates, and the ladder's job is DIRECTION, not accuracy.
 */
export function stepGovernor(
  state: GovernorState,
  lastCommitMs: number,
  maxIntervalMs: number,
): GovernorState {
  const top = topRung(Number.isFinite(maxIntervalMs) ? maxIntervalMs : GOVERNOR_LADDER[0]!);
  const rung = Math.min(Math.max(0, Math.floor(state.rung)), top);
  const interval = intervalOf({ rung, cheapStreak: state.cheapStreak }, maxIntervalMs);
  const cost = Number.isFinite(lastCommitMs) ? lastCommitMs : 0;

  if (cost > interval * GOVERNOR_UP_RATIO) {
    return { rung: Math.min(top, rung + 1), cheapStreak: 0 };
  }

  const streak = state.cheapStreak + 1;
  if (streak >= GOVERNOR_DOWN_STREAK) {
    return { rung: Math.max(0, rung - 1), cheapStreak: 0 };
  }
  return { rung, cheapStreak: streak };
}
