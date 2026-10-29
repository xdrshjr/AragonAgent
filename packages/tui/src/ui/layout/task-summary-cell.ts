/**
 * The task-summary cell's decisions (tui-shortcut-drawer-and-task-summary §6.3).
 *
 * ASCII ONLY: `src/ui/**` is inside the glyph scanner's scope.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `header-left.ts`: the planner answers "how
 * wide is the cell", this one answers "should there be a cell at all, and what is
 * in it". The second question is the trigger rule (D-7) and it has to be testable
 * without a renderer - `task-summary-app.test.tsx` pins "one call per session" by
 * calling THIS function, not by counting renders.
 *
 * THE TRIGGER IS NARROW ON PURPOSE. A header label is an identity strip, not a
 * live subtitle: refreshing it every turn would flicker, cost money, and teach the
 * user to distrust the one thing on the row that is not a status field.
 */

/** Why no summary call was started. Every branch is a branch the tests can name. */
export type TaskSummarySkipReason =
  | 'already-set'
  | 'no-anchor'
  | 'not-user-initiated'
  | 'disabled'
  | 'pending';

/**
 * D-7's trigger rule.
 *
 * FIVE INPUTS, ONE ANSWER. `userInitiated` is the second guard on the same fact
 * `submitMessage` already knows (`opts.userInitiated !== false`): an automatic
 * continuation is not a new task, and paying for a label for it would spend the
 * user's money to describe work they did not start.
 */
export function shouldSummarize(input: {
  anchor: string;
  hasSummary: boolean;
  pending: boolean;
  enabled: boolean;
  userInitiated: boolean;
}): { start: true } | { start: false; reason: TaskSummarySkipReason } {
  // ORDER IS THE DOCUMENTED PRECEDENCE: a prompt that is not a task cannot start
  // one even when everything else says yes, and an OFF feature must report the
  // switch rather than a downstream reason the user cannot act on.
  if (!input.enabled) return { start: false, reason: 'disabled' };
  if (input.anchor.trim().length === 0) return { start: false, reason: 'no-anchor' };
  if (input.hasSummary) return { start: false, reason: 'already-set' };
  if (input.pending) return { start: false, reason: 'pending' };
  // ITS OWN REASON, not `no-anchor`: an automatic continuation HAS an anchor, it is
  // simply not a new task, and a skip reason a maintainer cannot trust is worse than
  // no reason at all (review fix RF-3).
  if (!input.userInitiated) return { start: false, reason: 'not-user-initiated' };
  return { start: true };
}

/**
 * The drawer's `Task` section, flattened from the view state so the pure layout
 * module never learns what a `ViewState` is.
 */
export function taskSectionFrom(input: {
  view: {
    text: string;
    tone: 'model' | 'fallback';
    reason: string | null;
    by: string;
    at: number;
  } | null;
  pending: boolean;
  enabled: boolean;
  now: number;
}): {
  text: string | null;
  tone: 'model' | 'fallback' | null;
  reason: string | null;
  by: string;
  ageMs: number | null;
  enabled: boolean;
  pending: boolean;
} {
  if (input.view === null) {
    return {
      text: null, tone: null, reason: null, by: '', ageMs: null,
      enabled: input.enabled, pending: input.pending,
    };
  }
  return {
    text: input.view.text,
    tone: input.view.tone,
    reason: input.view.reason,
    by: input.view.by,
    // The age is computed from the view's own timestamp and the caller's clock,
    // so the drawer never introduces a second one.
    ageMs: input.now >= input.view.at ? input.now - input.view.at : null,
    enabled: input.enabled,
    pending: input.pending,
  };
}
