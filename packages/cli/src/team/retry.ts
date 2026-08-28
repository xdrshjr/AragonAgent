/**
 * The cold-start retry decision (team-live-activity F-4).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * RETRY IS SAFE ONLY WHEN THE CHILD PROVABLY DID NOTHING. `turns === 0 &&
 * toolCalls === 0` is the side-effect proof: no turn completed, so nothing was
 * written to the transcript, and no tool ran, so nothing was written to disk.
 * Everything else about the child is fresh by construction.
 *
 * THE TRAP IS THAT EVERY ABORT LOOKS RETRYABLE. `wrapFetchError` in
 * `packages/core` classifies an `AbortError` as `errorType: 'timeout'` with
 * `retryable: true`, and every abort in this system reaches the provider as an
 * aborted fetch - so a user pressing Esc produces a "retryable" error. The
 * predicate below does NOT see that, and must not be asked to: `TeamRuntime`
 * excludes the abort paths before it ever calls the predicate, and there are
 * exactly four of them (user Esc / `AgentController.abort()`, the `task` tool's
 * `ctx.signal`, the dispatch timeout - all three via `this.aborted` - and the
 * per-child timeout via the local `timedOut` flag). The turn-cap abort is
 * excluded twice over, by `run.truncated` here and by `turns === 0`.
 *
 * There is a fifth guard and it is DEFENCE IN DEPTH, NOT A SUBSTITUTE. The core
 * agent loop tests `ctx.signal.aborted` at the top of every stream iteration and
 * breaks BEFORE emitting `message_update`, so on an aborted request the
 * provider's `error` event never reaches a subscriber and `run.retryable` is
 * never even set. That is a property of a `break` in another package that no
 * test in this repo pins; it could change under a refactor of core's steering
 * handling without anyone here noticing. The four exclusions stay, and the
 * acceptance test keeps asserting all four from this side of the boundary.
 */

import { TEAM_LIMITS } from './limits.js';
import type { SubagentRun } from './types.js';

/**
 * Read `retryable` STRUCTURALLY rather than with `instanceof LLMError`.
 *
 * The error is constructed inside `packages/core` and crosses a package
 * boundary; a duplicated core instance (a linked checkout, a hoisting accident)
 * would make `instanceof` false while the field is plainly there, and the
 * failure mode would be "retries silently stopped happening". `formatStreamError`
 * reads `errorType` exactly this way for the same reason (reducer.ts).
 */
export function isRetryableStreamError(err: unknown): boolean {
  return (err as { retryable?: unknown } | null | undefined)?.retryable === true;
}

/**
 * Whether this attempt may be replaced by a fresh child.
 *
 * `attemptsSoFar` counts the attempt that just ended, so the first failure calls
 * this with `1` and `maxColdStartRetries` of 1 permits exactly one replacement.
 */
export function shouldRetryColdStart(run: SubagentRun, attemptsSoFar: number): boolean {
  return (
    attemptsSoFar <= TEAM_LIMITS.maxColdStartRetries &&
    run.retryable === true &&
    run.turns === 0 &&
    run.toolCalls === 0 &&
    !run.truncated
  );
}
