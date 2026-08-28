/**
 * TeamHumanQueue — serializes subagent confirmations onto the ONE human slot
 * (team-subagents §3.11 / I-4).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * `App.tsx` holds `humanRequest` as a SINGLE state slot and `resolveHuman`
 * broadcasts one response to every pending entry, so two children raising a
 * `--confirm` dialog at the same instant would double-resolve it. This queue is
 * a plain promise chain that admits one request at a time and prefixes the
 * summary with the child's label, so the user can always tell WHICH agent is
 * asking.
 *
 * THE WATCHDOG IS PAUSED ON ENQUEUE, NOT ON DISPLAY (D-18 / P0-4). This is
 * invariant I-3 one level down, and it is the second-most likely way to ship
 * this feature broken. A child sitting third in the FIFO is emitting nothing,
 * and its own `idleTimeout` (210 s by default) is armed: a user who takes four
 * minutes over the first dialog would otherwise lose children 2 and 3 to their
 * own watchdogs, each printing `[Agent] idle watchdog fired` over the TUI and
 * each landing in the report as a failure that has nothing to do with the work.
 * `controller.ts` records fixing exactly this for the LEAD's `--confirm` gate;
 * repeating it for children would regress a fix this codebase already paid for.
 * The wait starts when the promise is chained, which is where the time actually
 * goes — hence enqueue, not display.
 */

import type { ConfirmRequest } from '../tools/index.js';

/** The slice of `Agent` this queue needs. Structural, so tests can stub it. */
export interface WatchdogPausable {
  pauseIdleWatchdog(): void;
  resumeIdleWatchdog(): void;
}

export class TeamHumanQueue {
  /** The chain. Never rejects: a failed request resolves `false` (deny). */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly confirm: (req: ConfirmRequest) => Promise<boolean>) {}

  /**
   * Ask the human about `req` on behalf of `label`, one at a time.
   *
   * @param child  Paused for the whole wait, queue time included. May be `null`
   *               in the window before the child's `Agent` exists.
   * @param signal The child's `ctx.signal`. An abort resolves `false` so the
   *               child is never left owing an answer to a dialog nobody is
   *               going to reach.
   */
  request(
    child: WatchdogPausable | null,
    label: string,
    req: ConfirmRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    child?.pauseIdleWatchdog();

    const queued = this.enqueue(async () => {
      if (signal?.aborted) return false;
      return this.confirm({ ...req, summary: `[${label}] ${req.summary}` });
    });

    const raced = signal ? Promise.race([queued, abortsToFalse(signal)]) : queued;
    return raced.finally(() => child?.resumeIdleWatchdog());
  }

  /**
   * Chain `run` after everything already queued.
   *
   * The `catch` is what keeps the chain alive: an unhandled rejection here would
   * poison `this.tail` and every LATER request would reject without ever being
   * shown, which presents as "the second file write silently did nothing".
   */
  private enqueue(run: () => Promise<boolean>): Promise<boolean> {
    const next = this.tail.then(run, run).catch(() => false);
    this.tail = next;
    return next;
  }
}

/** Resolve `false` when `signal` aborts, with the listener cleaned up after. */
function abortsToFalse(signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    signal.addEventListener('abort', () => resolve(false), { once: true });
  });
}
