/**
 * Viewport geometry, published downward (tui-render-performance L3).
 *
 * `ScrollViewport`'s header records (P1-7) why it — and not its parent — owns
 * the metrics and the scroll offset: holding the offset in two places creates a
 * measure -> setState -> re-render -> measure loop whose convergence is provable
 * but whose frame count is not.
 *
 * Virtualisation needs those same three numbers one level DOWN, in
 * `TranscriptList`. So the viewport PUBLISHES rather than lifting: a `useMemo`d
 * context value, no new state, no second owner, no extra layout pass.
 */

import { createContext, useContext } from 'react';

export interface ViewportGeometry {
  /** Visible height of the clipping box, in rows. `0` before the first measure. */
  viewportRows: number;
  /** Rows hidden BELOW the viewport (`layout/scroll.ts` semantics; V-4). */
  offset: number;
  /** Natural (unclipped) height of the content, in rows. */
  contentRows: number;
}

/**
 * The default is the UNMEASURED geometry, and consumers must treat it as such:
 * a `TranscriptList` rendered outside a `ScrollViewport` (inline mode, and every
 * test that mounts it bare) sees `viewportRows: 0`, which `selectWindow` reads
 * as "first frame" and answers by pinning the live tail.
 */
export const ViewportGeometryContext = createContext<ViewportGeometry>({
  viewportRows: 0,
  offset: 0,
  contentRows: 0,
});

export function useViewportGeometry(): ViewportGeometry {
  return useContext(ViewportGeometryContext);
}
