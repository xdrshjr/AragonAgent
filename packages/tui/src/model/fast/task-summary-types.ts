/**
 * The task-summary types (tui-shortcut-drawer-and-task-summary §6.1).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope.
 *
 * WHY THIS FILE EXISTS AT ALL (v2 P1-3). `fast/summary-call.ts` and
 * `fast/summary-prompt.ts` produce and consume these shapes, and the header cell,
 * the reducer and the controller only display them. Declaring them in
 * `agent/controller.ts` - the v1 plan - would make `fast/` import `agent/` while
 * `agent/` imports `fast/`, and `.claude-index/config.md` already records one
 * real cycle in this package (`agent <-> compaction`). One more is not a style
 * question: a cycle makes the import graph unusable for ordering, and it is
 * exactly what `shortcut-table.test.ts` scans for. So the types live DOWN here,
 * in the lowest layer that needs them, and `agent/**` reaches them with
 * `import type` only.
 */

/** How the label was produced. `fallback` is the user's own words, never a guess. */
export type TaskSummaryTone = 'model' | 'fallback';

/**
 * The dominant character class of a string, by letter majority.
 *
 * A NAMED UNION rather than the free-form `Script` v1 mentioned (and never
 * defined, P1-8). Only three answers are actionable: the label must be CJK, must
 * be Latin, or is neither (a prompt in Cyrillic, or only punctuation).
 */
export type TaskSummarySpan = 'cjk' | 'latin' | 'other';

/**
 * Why a label is what it is.
 *
 * THE FIRST NINE VALUES ALL MEAN "the model did not give us a label" and every
 * one of them converges on the SAME deterministic floor (D-9); they are kept
 * apart only so the drawer and `/task` can say which one happened. `empty` is
 * the tenth and means there was no floor to show either (fallback disabled).
 */
export type TaskSummaryReason =
  | 'tier-off'
  | 'no-model'
  | 'no-adapter'
  | 'no-key'
  | 'timeout'
  | 'aborted'
  | 'error'
  | 'bad-output'
  | 'language-mismatch'
  | 'empty';

/**
 * The one task label a session has, as the header and the drawer read it.
 *
 * A PURE VIEW: it is never persisted, never enters the conversation history and
 * never touches `config.json` (§0-2). Everything a surface needs to explain the
 * label without a second lookup is on this record.
 */
export interface TaskSummaryView {
  /** Normalised, width-safe, at most `TASK_SUMMARY_LIMITS.maxCells` columns. */
  text: string;
  tone: TaskSummaryTone;
  /** `null` exactly when `tone === 'model'`. */
  reason: TaskSummaryReason | null;
  /** The anchor's dominant script, so the drawer can disclose a mismatch. */
  script: TaskSummarySpan;
  /** Epoch ms of the attempt. The drawer renders `12s ago` from it, no clock of its own. */
  at: number;
  /** `provider:model` that produced it; `''` for a fallback. */
  by: string;
}

/**
 * What one attempt produced.
 *
 * `view: null` happens in exactly one case: the call failed AND
 * `taskSummary.fallback` is false. That is a deliberate "show nothing" rather
 * than an empty string, because an empty header cell would read as a broken
 * feature (D-9).
 */
export interface TaskSummaryOutcome {
  view: TaskSummaryView | null;
}
