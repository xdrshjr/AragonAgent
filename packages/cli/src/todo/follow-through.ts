/**
 * follow-through — what happens when a run ends with unfinished steps
 * (todo-plan-followthrough §3.2 / §3.3).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope
 * (`glyphs.test.ts`), and every string this module builds is user-visible.
 *
 * PURE. No I/O, no timers, no React, no `Date.now()` — the discipline
 * `TodoStore`'s injected clock already establishes. The TUI (`App.tsx`) and
 * headless mode (`agent/headless.ts`) both call `decideFollowThrough`, which is
 * the only reason the two cannot drift; a second copy of this table in either
 * caller is the defect this file exists to prevent.
 *
 * IT NEVER WRITES TO `TodoStore` (I-1 / C-3). Follow-through reads snapshots and
 * produces a MESSAGE; the plan changes only when the model calls `todo_write`,
 * which keeps the list a projection of what the model believes.
 */

import { TODO_FOLLOW_LIMITS } from './limits.js';
import type { TodoSnapshot } from './types.js';

/**
 * `notify` — say something true and stop (the default; round 1's behaviour).
 * `auto`   — continue the plan, under the economy below.
 * `off`    — say nothing at all.
 */
export type FollowThroughMode = 'notify' | 'auto' | 'off';

/** Carried across runs by the caller. Serializable, comparable, inert. */
export interface FollowThroughBudget {
  /**
   * Auto-continuations issued against this list LINEAGE.
   *
   * MONOTONIC UNTIL THE LIST IS GONE (P0-1 / D-16 / I-8). It is NOT reset by a
   * re-plan: a model that emits a differently-sized list on every continuation
   * would otherwise zero both counters every turn while `staleTurns` also never
   * fires (it IS writing), which is an unbounded loop reachable by ordinary
   * "re-plan as you learn" behaviour rather than by anything adversarial.
   *
   * A refactor that "simplifies" `advanceBudget` back to returning a zeroed
   * budget on a `total` change re-opens that hole, and the symptom is a bill
   * rather than a test failure. `advanceBudget`'s own test pins it.
   */
  used: number;
  /** Consecutive auto-continuations after which `doneCount` did not increase. */
  noProgressStreak: number;
  /** `TodoSnapshot.total` the budget was opened against. Identity, not a count. */
  anchorTotal: number;
  /**
   * `doneCount` as observed at the PREVIOUS `agent_end` — which is what
   * `advanceBudget` assigns, in every branch, and therefore what the next call
   * compares against. An implementer who captures it at `runStart` instead
   * builds a different state machine that happens to agree in the normal case.
   */
  doneAtRunStart: number;
}

export interface FollowThroughInput {
  mode: FollowThroughMode;
  snapshot: TodoSnapshot | null;
  /**
   * Why the run ended. Derived by the caller, never carried by `AgentEndEvent`
   * (C-2): core's event has `messages` and nothing else, and this round does not
   * change core to make it otherwise.
   */
  runEnd: { aborted: boolean; errored: boolean };
  budget: FollowThroughBudget;
  /**
   * `false` in headless: no grace window (there is nobody to use it), and a
   * different notice verb, because `-p` writes `[todo] ...` lines rather than
   * transcript notices.
   */
  interactive: boolean;
}

export type FollowThroughDecision =
  | { kind: 'none' }
  | { kind: 'notify'; level: 'info' | 'warn'; text: string }
  | { kind: 'continue'; message: string; graceMs: number; notice: string };

/** The zero budget. A fresh App, a fresh headless run, and every cleared list. */
export function emptyBudget(): FollowThroughBudget {
  return { used: 0, noProgressStreak: 0, anchorTotal: 0, doneAtRunStart: 0 };
}

/**
 * Round 1's notice, preserved BYTE FOR BYTE (AC-1).
 *
 * This is what makes `followThrough: 'notify'` — the default — indistinguishable
 * from `bf6aeb1a` on the path that matters. Its singular/plural treatment
 * ("item is" / "items are") is round 1's; the strings added by this round use
 * "steps", the noun `<todo_planning>` and the rail already use.
 */
function legacyUnfinishedNotice(left: number): string {
  return (
    `${left} todo ${left === 1 ? 'item is' : 'items are'} unfinished. ` +
    'Use /todo continue to pick up where this run stopped, or /todo clear to drop it.'
  );
}

/** `/todo continue ...` advice, which means nothing in `-p`. */
function advise(interactive: boolean, text: string): string {
  return interactive ? ` ${text}` : '';
}

export function decideFollowThrough(input: FollowThroughInput): FollowThroughDecision {
  const { mode, snapshot, runEnd, budget, interactive } = input;

  // 1. Nothing is unfinished. `beginUserTurn` already drops a fully-completed
  //    list at the next turn, so this branch must not pre-empt that feedback.
  if (!snapshot || snapshot.doneCount >= snapshot.total) return { kind: 'none' };

  const left = snapshot.total - snapshot.doneCount;

  // 2. The user asked for silence and gets silence, INCLUDING no notice.
  if (mode === 'off') return { kind: 'none' };

  // 3. A BUG FIX, NOT A POLICY (D-5). The user pressed Esc; restating what they
  //    interrupted is the CLI answering a question nobody asked, and offering to
  //    continue it is worse.
  if (runEnd.aborted) return { kind: 'none' };

  // 4. NEVER `continue`, IN ANY MODE (D-6). Auto-continuing into a model that
  //    just failed authentication or ran out of quota is the unbounded cost loop
  //    with none of the upside.
  if (runEnd.errored) {
    return {
      kind: 'notify',
      level: 'warn',
      text:
        `${left} ${left === 1 ? 'step' : 'steps'} left; the run ended with an error.` +
        advise(interactive, '/todo continue to retry, /todo clear to drop it.'),
    };
  }

  // 5. The default. Byte-identical to round 1 in the TUI (AC-1).
  if (mode === 'notify') {
    return {
      kind: 'notify',
      level: 'info',
      text: interactive
        ? legacyUnfinishedNotice(left)
        : `${left} ${left === 1 ? 'step' : 'steps'} unfinished`,
    };
  }

  // 6. The ceiling that holds when everything else is wrong.
  if (budget.used >= TODO_FOLLOW_LIMITS.maxAutoContinuesPerList) {
    return {
      kind: 'notify',
      level: 'warn',
      text:
        `${left} ${left === 1 ? 'step' : 'steps'} left; auto-continue has run ` +
        `${TODO_FOLLOW_LIMITS.maxAutoContinuesPerList} times for this plan.` +
        advise(interactive, '/todo continue to keep going.'),
    };
  }

  // 7. A model that has stopped engaging with its own plan hands back after one
  //    nudge rather than after twenty-five.
  if (budget.noProgressStreak >= TODO_FOLLOW_LIMITS.maxNoProgressContinues) {
    return {
      kind: 'notify',
      level: 'warn',
      text:
        `${left} ${left === 1 ? 'step' : 'steps'} left; the last ` +
        `${TODO_FOLLOW_LIMITS.maxNoProgressContinues} attempts completed none of them.` +
        advise(interactive, '/todo continue to retry, or take over.'),
    };
  }

  const graceMs = interactive ? TODO_FOLLOW_LIMITS.graceMs : 0;
  return {
    kind: 'continue',
    message: buildContinuationMessage(snapshot),
    graceMs,
    // The seconds figure is DERIVED from the constant, never spelled again: a
    // notice that promises 3 s while the timer waits 5 is worse than no notice.
    notice: interactive
      ? `Continuing with ${left} remaining ${left === 1 ? 'step' : 'steps'} in ` +
        `${Math.round(graceMs / 1000)}s - Esc to stop.`
      : `continuing (${left} ${left === 1 ? 'step' : 'steps'} left)`,
  };
}

/**
 * Fold a finished run into the budget. Called BEFORE `decideFollowThrough`, on
 * every `agent_end` (and on every resolved `prompt()` in headless).
 *
 * `used` is NOT incremented here — a decision that is never acted on costs
 * nothing. Both fire points charge it themselves (I-5): the TUI's grace timer
 * and the headless loop, and BOTH are required. An uncharged counter in `-p` is
 * an uncapped loop in the one environment with no human to press Esc (P1-2).
 */
export function advanceBudget(
  prev: FollowThroughBudget,
  snapshot: TodoSnapshot | null,
  wasAutoContinuation: boolean,
): FollowThroughBudget {
  // THE ONLY PATH THAT CLEARS `used` (I-8). The list is gone; so is its economy.
  // It is not reachable by a model on its own: `TodoStore.write` leaves the
  // previous list untouched when a payload yields zero usable items, and the
  // other three ways a list disappears are `/todo clear`, `/reset` and
  // `beginUserTurn` dropping a list that is either finished (nothing to
  // continue) or stale (which the streak rule beats to the punch, §3.5).
  if (!snapshot) return emptyBudget();

  // A RE-PLAN BUYS FORGIVENESS, NOT A FRESH WALLET (D-16). Replanning is
  // engagement rather than looping, which is why the streak is forgiven; zeroing
  // `used` as well is what makes the hard ceiling unreachable, because a size
  // change every turn would reset it every turn.
  if (snapshot.total !== prev.anchorTotal) {
    return {
      used: prev.used,
      noProgressStreak: 0,
      anchorTotal: snapshot.total,
      doneAtRunStart: snapshot.doneCount,
    };
  }

  const progressed = snapshot.doneCount > prev.doneAtRunStart;
  // NOTE THE GUARD: a run the USER started never charges the streak, because the
  // user asking a question mid-plan is not the model failing to advance it.
  const noProgressStreak = progressed
    ? 0
    : wasAutoContinuation
      ? prev.noProgressStreak + 1
      : prev.noProgressStreak;

  return {
    used: prev.used,
    noProgressStreak,
    anchorTotal: prev.anchorTotal,
    // Assigned in EVERY branch, which is what makes the next call's comparison
    // meaningful.
    doneAtRunStart: snapshot.doneCount,
  };
}

/**
 * The text an auto-continuation — or `/todo continue` — submits.
 *
 * IT ENUMERATES RATHER THAN REFERRING (D-11). Round 1 submitted the fixed string
 * "Continue with the remaining todo items.", which is a reference to a
 * `todo_write` call that in a long session may have scrolled far enough back
 * that the model reconstructs it wrong — and reconstructing it wrong is SILENT,
 * because whatever it writes next is a full replacement and becomes the new
 * truth.
 *
 * `content` and never `activeForm`: the imperative is what an instruction wants.
 * Numbers are the item's 1-based position in the WHOLE list, so "step 5" means
 * the same thing here as it does in the rail. Completed items are omitted.
 * `TODO_LIMITS.maxItems` bounds the whole message at roughly 1.8 kB.
 */
export function buildContinuationMessage(snapshot: TodoSnapshot): string {
  const remaining = snapshot.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.status !== 'completed')
    .map(({ item, index }) => `${index + 1}. ${item.content}`);

  return [
    'Continue the plan. These steps are not done yet:',
    ...remaining,
    'Work the next one, then call todo_write to mark it completed and the following ' +
      'one in_progress before you move on.',
  ].join('\n');
}
