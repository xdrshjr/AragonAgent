/**
 * The single slot the view state crosses the React boundary through
 * (tui-session-id-resume §3.6 / D-2).
 *
 * SHAPED AFTER `exit-snapshot.ts`, on purpose and for the same reason: two of the
 * three writers of a checkpoint are process-level (`process.on('exit')` and the
 * signal hook), and by the time they run the component tree may already be
 * unmounted or mid-unmount. A module variable stays readable for the whole
 * process lifetime; a React channel does not.
 *
 * NAMED `session-bridge` AND NOT `live-session` (R-15): `__tests__/live-session
 * .test.ts` already exists and tests something else entirely - the rule that a
 * running tool's output tail never reaches the disk. Two file names one grep away
 * from each other, meaning different things, is how a future reader loses an
 * afternoon.
 *
 * WRITES OVERWRITE AND ALLOCATE ALMOST NOTHING: `entries` travels by reference,
 * so publishing costs one object literal per view-state change.
 */

// TYPE-ONLY, so `session/checkpoint.ts` gains no runtime edge into the UI. The
// direction is the one `commands/registry.ts` already uses for `update/types.js`.
import type { LiveSessionView } from '../session/checkpoint.js';

let slot: LiveSessionView | undefined;

/** Called by `App` after every view-state change. Synchronous, side-effect free. */
export function publishSessionView(next: LiveSessionView): void {
  slot = next;
}

/** Read by the checkpoint writer. `undefined` means "no identity in this process". */
export function readSessionView(): LiveSessionView | undefined {
  return slot;
}

/** Test-only reset, so specs do not leak a session into one another. */
export function clearSessionView(): void {
  slot = undefined;
}
