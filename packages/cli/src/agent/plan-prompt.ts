/**
 * The `<plan_mode>` system-prompt block (plan-mode §8).
 *
 * Spliced into `buildSystemPrompt` ONLY when the mode is `plan`, exactly as
 * `skillsBlock` already is, so a build-mode prompt stays byte-identical to the
 * pre-feature output (invariant I-P1).
 *
 * ASCII ONLY — `agent/` is inside the glyph scanner's scope.
 */

/** Bump when the wording changes, so a transcript can be dated. */
export const PLAN_MODE_BLOCK_VERSION = 'v1-2026-07';

export interface PlanModeBlockOptions {
  /** False under `-p` / piped stdin: no overlay can be rendered, so no tools. */
  interactive: boolean;
  /** `planModeMaxAskRounds`; substituted into the guidance so the two agree. */
  maxAskRounds: number;
}

/**
 * The closing paragraph of the interactive block.
 *
 * THIS PARAGRAPH IS LOAD-BEARING, NOT BOILERPLATE (§3.9 / I-P9).
 *
 * `runLoopWithLifecycle` passes `systemPrompt: this.systemPrompt` BY VALUE into
 * `runAgentLoop`, and every LLM call in the loop reads that same captured
 * string. So the block cannot be rewritten mid-run — which matters most in the
 * feature's headline flow: the user approves a plan, `submit_plan` flips the
 * session to Build and returns "implement the plan", and the model is still
 * holding a system prompt that says "you must not change anything on disk".
 * The well-aligned resolution of that standoff is to refuse, which would break
 * the whole point of the approval.
 *
 * Two halves must survive any edit: the read-only rule is SCOPED to "while PLAN
 * MODE is active", and the approval result is NAMED as the authority that
 * supersedes it. `plan-mode.test.ts` asserts both as a static regex, because
 * the failure presents as "the model is being unhelpful today" rather than as a
 * bug in this feature.
 */
const SUPERSEDE_PARAGRAPH = [
  '- This block is written once, when the run starts, and is NOT re-issued if the',
  '  mode changes during the run. A submit_plan result reporting that the plan was',
  '  APPROVED is therefore authoritative and supersedes the read-only rule above',
  '  for the remainder of this run: you are in Build mode, the tools are available,',
  '  and you should implement the plan in order without asking again.',
].join('\n');

/** The headless replacement: there is no overlay, so there is nobody to ask. */
const HEADLESS_PARAGRAPH = [
  '- There is no interactive user. Do not ask questions and do not call submit_plan;',
  '  write the finished plan as your final message in markdown.',
].join('\n');

export function buildPlanModeBlock(options: PlanModeBlockOptions): string {
  const { interactive, maxAskRounds } = options;

  const askStep = interactive
    ? [
        '2. If a decision would change the work and you cannot settle it by reading, call',
        '   ask_user with 3-5 multiple-choice questions in ONE call. Mark exactly one',
        `   option recommended:true and put the reason in its description. You may ask up`,
        `   to ${maxAskRounds} rounds; each round costs the user time, so make them count.`,
      ]
    : [
        '2. If a decision would change the work and you cannot settle it by reading, state',
        '   the assumption you are making and why, then continue. There is nobody to ask.',
      ];

  const submitStep = interactive
    ? [
        '3. Call submit_plan exactly once, with ordered steps a reviewer could check off.',
        '   Name the real files you intend to touch. State the risks you actually found.',
      ]
    : [
        '3. Finish with the full plan as your final message: ordered steps a reviewer could',
        '   check off, the real files you intend to touch, and the risks you actually found.',
      ];

  const verdictRule = interactive
    ? [
        '- After submit_plan, wait for the verdict. If it is rejected, address the',
        '  feedback and call submit_plan again.',
      ]
    : [];

  return [
    '<plan_mode>',
    'You are in PLAN MODE. The user toggled it with Shift+Tab. This is a research and',
    'design mode: you must not change anything on disk and must not run commands.',
    '',
    'Work in this order:',
    '1. Ground yourself in the real code. Use read_file, list_dir, glob, grep and any',
    '   relevant skill. Never plan against a directory structure you have not read.',
    ...askStep,
    ...submitStep,
    '',
    'Rules:',
    '- While PLAN MODE is active, write_file, edit_file, bash, skill_install and',
    '  skill_create are refused. Do not attempt to work around a refusal; finish the',
    '  plan instead.',
    '- Never ask a question the workspace already answers.',
    '- Never invent a path. Cite files you have read.',
    ...verdictRule,
    interactive ? SUPERSEDE_PARAGRAPH : HEADLESS_PARAGRAPH,
    '</plan_mode>',
  ].join('\n');
}
