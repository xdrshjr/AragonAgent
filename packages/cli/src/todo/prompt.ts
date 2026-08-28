/**
 * The `<todo_planning>` system-prompt block (todo-plan-execution §3.7).
 *
 * ASCII ONLY: `src/todo/**` is inside the glyph scanner's scope, and this string
 * also reaches a model that may be running in a `cmd.exe` terminal.
 *
 * SPLICED CONDITIONALLY by `buildSystemPrompt`, which is what preserves C-10:
 * with `todo.enabled: false` the prompt is BYTE-IDENTICAL to the pre-todo output
 * for a fixed tool array. An unconditional guidance line anywhere here would
 * quietly break `--no-todo`, `--no-team`, `--no-skills` and the plan-mode
 * snapshot all at once.
 *
 * THE BLOCK'S THRESHOLD (3+ steps) IS STRICTER THAN THE STRUCTURAL GUARD
 * (`minFreshItems`, 2). A backstop looser than the guidance never argues with a
 * judgement call the model made on purpose: a 2-step list for two genuinely
 * separate deliverables is fine, and the prompt simply does not encourage it.
 *
 * `TODO_BLOCK_VERSION` exists so a change to this wording is greppable from a
 * behaviour report - INCLUDING a change to either `{{VISIBILITY}}` variant,
 * which is part of the block.
 */

import { TODO_BLOCK_VERSION } from './limits.js';

export { TODO_BLOCK_VERSION };

export interface TodoBlockParams {
  /**
   * Whether this session can actually render the rail.
   *
   * FOUR SUPPORTED PATHS HAVE THE TOOL AND NO PANEL — `-p` (§3.12), inline mode
   * (non-goal 4), `--no-todo-panel` (§4.3), and a terminal under 80 columns or 6
   * viewport rows (§6.4) — and in the first three the answer is fixed for the
   * whole session, before the prompt is composed. Telling the model about a
   * panel the user does not have is the same error `composeSystemPrompt` already
   * guards against for team mode with its TWO flags (P1-6 / D-24).
   *
   * Dropping the block instead would be wrong: the planning discipline is worth
   * having without the column, which is precisely why `enabled` and `panel` are
   * separate config keys, and a screen-reader user is the case that argument was
   * written for.
   */
  panelVisible: boolean;
}

/**
 * The ONLY sentence in the block that mentions a display at all. Everything else
 * talks about "the list", which is what makes "the two variants differ in
 * exactly one sentence" checkable rather than approximate (AC-42).
 */
const VISIBLE =
  'The user sees this list in a panel beside the conversation, so it is the only place ' +
  'they can watch a long task progress.';

const NOT_VISIBLE =
  'The user cannot see this list in this session, but keeping it is still how you stay ' +
  'on one step at a time and report what is left.';

/**
 * BOUNDED AT 1600 CHARACTERS, and the number is asserted in `todo-tool.test.ts`.
 *
 * The block is paid for on EVERY turn of every todo-enabled session, so anything
 * that does not change a planning decision does not belong in it (the discipline
 * `buildTeamBlock` records at 1200 for a shorter block). This one lands at ~1430
 * as designed — three bullet lists plus the `{{VISIBILITY}}` sentence — and was
 * NOT trimmed to reach a borrowed budget, because every line in it changes a
 * planning decision, which is the test that actually applies. The bound exists
 * so that adding a paragraph stays a decision someone makes on purpose. See
 * spec §15 IF-3.
 */
export function buildTodoBlock(params: TodoBlockParams): string {
  return [
    '<todo_planning>',
    'For work that takes three or more distinct steps, keep a visible plan with the',
    'todo_write tool.',
    params.panelVisible ? VISIBLE : NOT_VISIBLE,
    '',
    'Use it when:',
    '- the request has three or more steps that must happen in order;',
    '- the user gave you several things to do in one message;',
    '- you are part-way through a long task and the user asks what is left.',
    '',
    'Do NOT use it for:',
    '- anything you can finish in one or two steps - just do it and say what you did;',
    '- a question, an explanation, or a search with no work attached;',
    '- restating a step you are already in the middle of.',
    '',
    'How to use it:',
    '- Send the COMPLETE list every time. The tool replaces the whole list; it has no',
    '  add or update operation.',
    '- Exactly one item is in_progress at a time. Mark an item completed the moment',
    '  it is done and mark the next one in_progress in the SAME call.',
    '- Do not batch. Finishing three steps and reporting them together hides where you',
    '  are RIGHT NOW, which is the whole point of keeping the list.',
    '- Give each item a content ("Add the rail to AppShell") and an activeForm',
    '  ("Adding the rail to AppShell"). The list shows activeForm for the step in',
    '  progress and content for the rest.',
    '- Only mark an item completed when it is really finished. If you hit a blocker,',
    '  leave it in_progress, add an item describing what is blocking, and say so.',
    '</todo_planning>',
  ].join('\n');
}
