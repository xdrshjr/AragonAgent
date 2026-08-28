/**
 * `ask_user` and `submit_plan` — the two tools that only exist because a human
 * is attached (plan-mode §4.1 / §4.2 / §5.3).
 *
 * ASCII ONLY: `tools/` is inside the glyph scanner's scope.
 *
 * THE SCHEMAS DECLARE SHAPE, NOT POLICY (P0-4). `type`, `required` and `default`
 * stay, because a `questions` value that is not an array has nothing for a
 * normalizer to repair and both validator strategies agree on that check.
 * Everything else — how many questions, how many options, how long a header may
 * be — lives in the `description`, which is what the model actually reads, and
 * is enforced by `normalizeQuestions` / `normalizePlan`. Putting `maxItems: 5`
 * in the schema instead had two failure modes at once: with `ajv` present
 * `ToolExecutor` rejected a six-question call outright and the repair rules were
 * dead code; without it (ajv is an OPTIONAL dependency of core) the same call
 * sailed straight through to the repair path. One design, two behaviours,
 * selected by whether an optional install step succeeded.
 */

import { errorResult, textResult, type AgentTool, type ToolResult } from '@aragon-agent/core';
import {
  formatAnswersResult,
  normalizePlan,
  normalizeQuestions,
  type HumanInputGate,
} from './human-input.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The outcome of trying to spend one `ask_user` round. */
export interface AskRoundTicket {
  ok: boolean;
  used: number;
  remaining: number;
  max: number;
}

export interface PlanToolsOptions {
  gate: HumanInputGate;
  /**
   * Spend one `ask_user` round. The counter is owned by the controller because
   * it resets per user turn, and the controller is the only object that sees a
   * turn begin.
   */
  takeAskRound: () => AskRoundTicket;
  /**
   * Run `fn` with the idle watchdog paused. `try/finally` inside, so a throw in
   * the overlay path cannot leave the watchdog disarmed for the rest of the run.
   */
  withHumanWait: <T>(fn: () => Promise<T>) => Promise<T>;
  /**
   * Approve the plan: flip the session to Build IMMEDIATELY, mid-run.
   *
   * This is the one place a `plan -> build` transition is not deferred to
   * `agent_end`, and the asymmetry is the whole point: the user has just read
   * the plan and authorized exactly this work. A stray `Shift+Tab` has not.
   */
  onPlanApproved: () => void;
}

// ---------------------------------------------------------------------------
// Shared refusal text
// ---------------------------------------------------------------------------

const NO_INTERACTIVE_USER =
  'No interactive user is attached (-p/--print mode). Do not ask questions: ' +
  'state your assumptions explicitly and continue.';

const NO_INTERACTIVE_REVIEWER =
  'No interactive reviewer is attached. Emit the full plan as your final answer ' +
  'in markdown instead.';

function roundCapRefusal(used: number): string {
  return (
    `You have already asked ${used} rounds of questions (the configured maximum). ` +
    'Proceed with your best assumptions and state them in the plan.'
  );
}

// ---------------------------------------------------------------------------
// ask_user
// ---------------------------------------------------------------------------

const ASK_USER_DESCRIPTION =
  'Ask the user 1-5 multiple-choice questions when a decision would change the work. ' +
  'Give each question a stable id, a header of at most 12 characters, and 2-4 options; ' +
  'exactly one option must set recommended:true, with the reason in its description. ' +
  'Extra questions or options beyond these limits are dropped, so keep within them. ' +
  'Do not ask anything you could answer by reading the workspace.';

function makeAskUser(opts: PlanToolsOptions): AgentTool {
  return {
    name: 'ask_user',
    label: 'Ask the user',
    description: ASK_USER_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          description: '1-5 questions, asked in one round.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable key echoed back in the answer.' },
              header: {
                type: 'string',
                description: 'Very short chip label (<= 12 chars), e.g. "Datastore".',
              },
              question: { type: 'string', description: '<= 300 chars.' },
              allowMultiple: { type: 'boolean', default: false },
              options: {
                type: 'array',
                description: '2-4 options. Exactly one must be recommended.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: '<= 60 chars.' },
                    description: {
                      type: 'string',
                      description: '<= 120 chars. Why this option.',
                    },
                    recommended: { type: 'boolean', default: false },
                  },
                  required: ['label'],
                },
              },
            },
            required: ['id', 'header', 'question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
    async execute(_id, params, ctx): Promise<ToolResult> {
      // Probed BEFORE the work, never discovered afterwards: a missing human
      // channel must mean "refuse with an actionable message", not "wait
      // forever" and not "assume yes".
      if (!opts.gate.canPrompt()) return errorResult(NO_INTERACTIVE_USER);

      const questions = normalizeQuestions((params as { questions?: unknown }).questions);
      if (questions.length === 0) {
        return errorResult('No usable questions: each needs 2-4 distinct options.');
      }

      const ticket = opts.takeAskRound();
      if (!ticket.ok) return errorResult(roundCapRefusal(ticket.used));

      const response = await opts.withHumanWait(() =>
        opts.gate.request({ kind: 'questions', questions }, ctx.signal),
      );

      // `null` covers cancel, unmount, abort AND timeout. From the model's point
      // of view an unanswered question and an abandoned one are the same
      // situation and want the same guidance, so they share a shape — and it is
      // a NON-error result on purpose: a cancellation rendered as a tool failure
      // invites a retry loop.
      const cancelled = response === null || response.kind !== 'answers' || response.cancelled;
      const answers = response !== null && response.kind === 'answers' ? response.answers : [];

      return textResult(
        formatAnswersResult(
          {
            answers,
            cancelled,
            roundsUsed: ticket.used,
            roundsRemaining: ticket.remaining,
          },
          questions.length,
        ),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// submit_plan
// ---------------------------------------------------------------------------

const SUBMIT_PLAN_DESCRIPTION =
  'Present the implementation plan for approval. Call this exactly once, after you ' +
  'have read enough of the workspace to be specific. Steps must be ordered and ' +
  'independently verifiable. Limits, enforced by truncation rather than rejection: ' +
  'title <= 80 chars, summary <= 600, at most 20 steps (title <= 100, detail <= 400), ' +
  'at most 30 filesTouched, 10 risks, 10 openQuestions.';

const APPROVED_RESULT =
  'Plan approved. You are now in Build mode - implement the plan step by step, in order.';

const DISMISSED_RESULT =
  'The user dismissed the plan review without a verdict. Ask a clarifying question ' +
  'or refine the plan, then call submit_plan again.';

function makeSubmitPlan(opts: PlanToolsOptions): AgentTool {
  return {
    name: 'submit_plan',
    label: 'Submit plan',
    description: SUBMIT_PLAN_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              detail: { type: 'string' },
            },
            required: ['title'],
          },
        },
        filesTouched: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        openQuestions: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'summary', 'steps'],
    },
    async execute(_id, params, ctx): Promise<ToolResult> {
      // Non-error: under `-p` the read-only gate still applies, so "plan this
      // and do not touch my repository" is a legitimate combination and must not
      // read as a malfunction.
      if (!opts.gate.canPrompt()) return textResult(NO_INTERACTIVE_REVIEWER);

      const plan = normalizePlan(params);
      if (!plan) return errorResult('A plan needs at least one step with a title.');

      const response = await opts.withHumanWait(() =>
        opts.gate.request({ kind: 'plan', plan }, ctx.signal),
      );

      if (response === null || response.kind !== 'planDecision') {
        return textResult(DISMISSED_RESULT);
      }

      if (response.decision === 'approved') {
        opts.onPlanApproved();
        return textResult(APPROVED_RESULT);
      }
      if (response.decision === 'revise') {
        return textResult(
          `Plan rejected. The user's feedback: "${response.feedback}". ` +
            'Revise and call submit_plan again.',
        );
      }
      return textResult(DISMISSED_RESULT);
    },
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Build the plan tools, or `[]` for a channel that can never reach a human.
 *
 * KEYED ON `neverPrompts`, NOT `canPrompt()` (P0-3). This function runs inside
 * `makeController()`, and in the interactive path the bridge handler is still
 * null there — the App attaches it later, in an effect. So `canPrompt()` is
 * false for EVERY session at this moment, and gating registration on it would
 * ship plan mode with no `ask_user` and no `submit_plan`, in every interactive
 * session, with nothing anywhere reporting it.
 *
 * Registration is a one-time structural question ("can this channel ever reach a
 * human?"). `canPrompt()` answers a live one ("is one attached right now?") and
 * is checked again inside each tool, where it belongs.
 */
export function createPlanTools(opts: PlanToolsOptions): AgentTool[] {
  if (opts.gate.neverPrompts) return [];
  return [makeAskUser(opts), makeSubmitPlan(opts)];
}
