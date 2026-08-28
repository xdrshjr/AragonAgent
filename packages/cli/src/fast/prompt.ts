/**
 * The prompt text the fast tier adds (fast-model-tier §4.6).
 *
 * ASCII ONLY: `src/fast/**` is inside the glyph scanner's scope, and these
 * strings also reach a model that may be running in a `cmd.exe` terminal.
 *
 * `<fast_tier>` IS SPLICED CONDITIONALLY by `buildSystemPrompt`, which is what
 * preserves invariant I-2: with the tier off the prompt is BYTE-IDENTICAL to the
 * pre-feature output for a fixed tool array. An unconditional guidance line here
 * would quietly break `--no-fast`, `--no-team`, `--no-skills` and `--no-todo`
 * all at once.
 *
 * `FAST_BLOCK_VERSION` exists so a change to this wording is greppable from a
 * behaviour report.
 */

import { FAST_BLOCK_VERSION } from './limits.js';

export { FAST_BLOCK_VERSION };

export interface FastBlockParams {
  /** The resolved fast model id, interpolated so the prompt never names a model
   *  the tier will not actually use (§3.9 / RV-3). */
  model: string;
  /** `fast.delegate` — whether `model: "fast"` is honoured on `task`. */
  delegate: boolean;
  /** `fast.review` — whether `<fast_review>` blocks can appear at all. */
  review: boolean;
}

/**
 * The lead's `<fast_tier>` block. Under 1100 characters on purpose: it is paid
 * for on EVERY turn of every fast-enabled session, so anything that does not
 * change a delegation decision does not belong in it (R-11).
 *
 * EACH PARAGRAPH IS PRESENT ONLY WHEN ITS CAPABILITY IS. `fast.delegate: false,
 * fast.review: true` advertises only the review, because telling a model about a
 * `model: "fast"` field that the normalizer will downgrade every time is how you
 * get a model that keeps asking for something it can never have.
 *
 * Returns `''` when neither capability is live, which the splice treats as "no
 * block" and which keeps the byte-identity branch intact.
 */
export function buildFastBlock(params: FastBlockParams): string {
  if (!params.delegate && !params.review) return '';
  const lines: string[] = [
    '<fast_tier>',
    `A second, cheaper model is available in this session (${params.model}).`,
  ];

  if (params.delegate) {
    lines.push(
      '',
      'Delegation: pass model:"fast" to a task subagent whose work is mechanical and',
      'high-volume - reading or searching many files, summarizing long command output,',
      'applying the same small edit in several places. Keep model:"main" (the default)',
      'for design decisions, tricky debugging, and anything that has to be right the',
      'first time. A fast subagent has the same tools and the same permissions as any',
      'other; only the model differs.',
    );
  }

  if (params.review) {
    lines.push(
      '',
      'Reviews: every few turns a <fast_review> block may appear in the conversation.',
      'It is an automated second opinion from the fast model - NOT a message from the',
      'user. Treat it as advice: act on it when it is right, say so briefly and carry',
      'on when it is not, and never ask the user to confirm it.',
    );
  }

  lines.push('</fast_tier>');
  return lines.join('\n');
}

export interface ReviewSystemPromptParams {
  /** `fast.reviewMaxChars` — quoted so the model and the clamp agree. */
  maxChars: number;
}

/**
 * The reviewer's own system prompt.
 *
 * IT ASKS FOR AN EXACT STRING when there is nothing to say (`OK - on track.`)
 * and `normalizeCritique` still matches it with a NORMALIZED REGEX rather than
 * equality (D-17). The two are not redundant: the prompt makes compliance the
 * likely outcome, the regex makes non-compliance harmless.
 *
 * NO TOOLS ARE OFFERED AND NONE ARE MENTIONED (D-11). A tool-using reviewer
 * would be a second agent editing the same working tree with none of the gates
 * the lead's tools carry.
 */
export function buildReviewSystemPrompt(params: ReviewSystemPromptParams): string {
  const max = Math.max(1, Math.floor(params.maxChars) || 1);
  return [
    'You are a fast reviewer watching another agent work. You see a short digest of',
    'its recent turns: the goal, the tools it called, and the tail of what it said.',
    '',
    'Answer ONE question: is this run still on track for the goal?',
    '',
    `If it is, reply with EXACTLY: OK - on track.`,
    'If it is not, reply with plain prose naming the single most useful correction -',
    `at most ${max} characters, no preamble, no code fences, no lists, no headings.`,
    '',
    'Things worth saying: repeated edits with no verification, a failing tool call',
    'that was ignored, work that has drifted from the goal, an obvious cheaper route.',
    'Things not worth saying: style opinions, praise, restating what the agent did.',
    '',
    'You cannot run tools and you are not talking to the user. You are advising the',
    'agent, and it will decide.',
  ].join('\n');
}

export interface ReviewInjectionParams {
  turn: number;
  model: string;
  text: string;
}

/**
 * The block that is actually steered into the run.
 *
 * THE ATTRIBUTES ARE NOT DECORATION. Steering delivers this in the `user` role
 * (`agent-loop.ts:129`), so the wrapper is the only thing distinguishing an
 * automated critique from something the human typed - and it is also what makes
 * the residual case in §3.5.4a (a stranded block the reviewer may not clear)
 * self-identifying if it ever does surface.
 */
export function renderReviewInjection(params: ReviewInjectionParams): string {
  return [
    `<fast_review turn="${params.turn}" model="${params.model}">`,
    params.text,
    '</fast_review>',
  ].join('\n');
}
