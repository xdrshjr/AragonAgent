/**
 * Module-level single-slot snapshot — the ONE way view state crosses the React
 * boundary out to `cli.tsx` (spec §4.4, review P1-3).
 *
 * Why not `useImperativeHandle` / a ref callback: two of the four restore paths
 * (`process.on('exit')` and the signal hooks) are process-level, and by the time
 * they run the component tree may already be unmounted or mid-unmount. A module
 * variable stays readable for the whole process lifetime; a React channel does
 * not.
 *
 * Writes are overwriting, not appending: `entries` is passed by reference, so
 * publishing costs one object literal per view-state change.
 */

import type { Entry, UsageTotal } from '../agent/reducer.js';

export interface ExitSnapshot {
  entries: Entry[];
  usageTotal: UsageTotal;
  provider: string;
  model: string;
  startedAt: number;
  /**
   * Entries the retain ring removed (tui-render-performance L1).
   *
   * OPTIONAL so every existing caller and test is unchanged; absent means the
   * replay says nothing, which is correct for a session that dropped nothing.
   */
  droppedEntries?: number;
}

let snapshot: ExitSnapshot | undefined;

/** Called by `App` after every view-state change. Synchronous, side-effect free. */
export function publishExitSnapshot(next: ExitSnapshot): void {
  snapshot = next;
}

/** Called by `cli.tsx` after `restore()`. `undefined` ⇒ skip the replay entirely. */
export function readExitSnapshot(): ExitSnapshot | undefined {
  return snapshot;
}

/** Test-only reset so specs do not leak state into one another. */
export function clearExitSnapshot(): void {
  snapshot = undefined;
}
