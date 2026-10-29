/**
 * Commit-cost timing for the render governor (tui-render-performance L4).
 *
 * `performance.now()` is taken at the TOP of the `App` render body (this hook
 * must therefore be called early, before any other work) and again in a layout
 * effect. Ink computes yoga layout in `onRender`, which React runs BEFORE layout
 * effects, so that span covers React reconciliation AND the Ink layout pass —
 * the same mechanism `ScrollViewport.tsx:87-88` and `AppShell.tsx:100-102`
 * already document and rely on.
 *
 * ONLY THE RUNG IS REACT STATE. The measured cost and the resolved interval live
 * in refs: putting a millisecond count in state would re-render the whole tree
 * on every frame to record how expensive rendering the whole tree was.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { performance } from 'node:perf_hooks';
import {
  GOVERNOR_LADDER,
  initialGovernor,
  intervalOf,
  stepGovernor,
  type GovernorState,
} from './render-governor.js';

export interface RenderGovernorOptions {
  /** `false` pins rung 0 forever (`--no-render-governor`, `ARAGON_RENDER_GOVERNOR=0`). */
  enabled: boolean;
  /** Ceiling of the ladder; `33` flattens it. */
  maxIntervalMs: number;
}

export interface RenderGovernorHandle {
  /**
   * The coalescing interval to arm the next flush timer with.
   *
   * A REF, read at `setTimeout` time. The coalescer's callbacks are `useCallback`d
   * with stable deps and must stay that way (the controller subscription effect
   * never re-runs), so a plain value would be pinned to the mount render.
   */
  intervalMs: { current: number };
  /** Rendered as the `eco` chip when > 0 (I-L4-2). */
  rung: number;
  /** Most recent commit cost in ms, for `/perf`. Not state. */
  lastCommitMs: () => number;
  /** `/perf reset` — back to rung 0. */
  reset: () => void;
}

export function useRenderGovernor(opts: RenderGovernorOptions): RenderGovernorHandle {
  const { enabled, maxIntervalMs } = opts;
  const stateRef = useRef<GovernorState>(initialGovernor());
  const intervalMs = useRef<number>(GOVERNOR_LADDER[0]!);
  const lastCommit = useRef(0);
  const startedAt = useRef(0);
  const mounted = useRef(true);
  const [rung, setRung] = useState(0);

  // Stamped during render, which is the whole point of calling this hook first.
  startedAt.current = performance.now();

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useLayoutEffect(() => {
    const cost = performance.now() - startedAt.current;
    lastCommit.current = cost;
    if (!enabled) {
      stateRef.current = initialGovernor();
      intervalMs.current = Math.min(maxIntervalMs, GOVERNOR_LADDER[0]!);
      if (rung !== 0) setRung(0);
      return;
    }
    const next = stepGovernor(stateRef.current, cost, maxIntervalMs);
    stateRef.current = next;
    intervalMs.current = intervalOf(next, maxIntervalMs);
    // React bails out when the value is unchanged, so this is a no-op on every
    // frame that did not move the ladder — which is almost all of them.
    if (mounted.current && next.rung !== rung) setRung(next.rung);
  });

  const reset = useCallback(() => {
    stateRef.current = initialGovernor();
    intervalMs.current = Math.min(maxIntervalMs, GOVERNOR_LADDER[0]!);
    if (mounted.current) setRung(0);
  }, [maxIntervalMs]);

  const lastCommitMs = useCallback(() => lastCommit.current, []);

  return { intervalMs, rung, lastCommitMs, reset };
}
