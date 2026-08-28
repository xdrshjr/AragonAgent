/**
 * `task` — the delegation tool, registered on a LEAD only (team-subagents §3.3 /
 * §4.1).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * THE BATCH SHAPE IS FORCED BY THE CORE LOOP, NOT CHOSEN FOR TASTE (D-1 / I-1 /
 * R-1). `agent-loop.ts` executes tool calls in a `for...of` with an `await`
 * inside, strictly sequentially, so N single-spec `task` calls would produce N
 * SERIAL subagents — the exact opposite of this feature. Making that loop
 * concurrent is not an available fix: plan mode pins the sequencing as invariant
 * I-P11, because the human-input bridge holds ONE outstanding request slot and
 * is correct only while tool calls never overlap. Breaking it would silently
 * mis-route a plan approval to a question wizard. So the fan-out lives inside
 * one tool call, where the scheduling is ours.
 *
 * THE SCHEMA DECLARES SHAPE, NOT POLICY (§3.3.1). Every bound lives in the
 * `description` — which is what the model reads — and is enforced by
 * `normalizeSubagentSpecs`, which is deterministic and unit-tested. `maxItems`
 * in the schema would behave differently depending on whether `ajv`, an OPTIONAL
 * dependency of core, happened to install.
 */

import { errorResult, textResult, type AgentTool, type ToolResult } from '@aragon-agent/core';
import type { ModelCost } from '@aragon-agent/core';
import { TEAM_LIMITS } from './limits.js';
import { normalizeSubagentSpecs } from './normalize.js';
import { buildDispatchReport } from './report.js';
import type { TeamRuntime } from './runtime.js';

export interface TaskToolDeps {
  runtime: TeamRuntime;
  /** Read LIVE, never cached: `/team off` flips this, it does not unregister. */
  isTeamEnabled: () => boolean;
  /**
   * Whether the fast tier was resolvable AT CONSTRUCTION (fast-model-tier §3.3 /
   * C-2).
   *
   * DECIDED ONCE, because the tool array is built once and must never be
   * rebuilt: `Agent.setTools()` mutates the live `ToolRegistry`, and
   * `submit_plan` flips the session mode from INSIDE a tool execution. So the
   * `model` property either exists in this schema for the whole session or never
   * does — and with it absent, `TASK_DESCRIPTION` and the schema are
   * BYTE-IDENTICAL to the pre-feature build (AC-3).
   *
   * Optional so every existing construction site and test compiles unchanged.
   */
  fastRegistered?: boolean;
  /**
   * Whether `model:"fast"` is honoured RIGHT NOW. Read LIVE, at dispatch time
   * (RV-3) — the tier can stop resolving mid-session, and a downgrade is the
   * honest observable either way.
   */
  fastAvailable?: () => boolean;
  maxSubagents: () => number;
  /** Whether a usable key exists for the active provider right now (P2-3). */
  hasApiKey: () => boolean;
  activeProvider: () => string;
  /** The lead's cost table, so the report header states real spend (R-5). */
  modelCost: () => ModelCost | undefined;
  /** The FAST model's cost table (fast-model-tier §3.4). Absent when the tier is
   *  off, which is what leaves the report byte-identical. */
  fastModelCost?: () => ModelCost | undefined;
  /** Whether the static price table has never heard of the fast model (C-11 /
   *  RV-4). `unknown` is rendered as unknown, NEVER as `$0.00`. */
  fastPricingUnknown?: () => boolean;
  /**
   * Run the dispatch with the LEAD's idle watchdog paused, `try/finally` inside.
   *
   * THE SINGLE MOST LIKELY WAY TO SHIP THIS FEATURE BROKEN (I-3 / R-3). The
   * watchdog fires on EVENT SILENCE, not on inactivity, and a lead blocked
   * inside `task` emits nothing — so a six-minute dispatch under the default
   * 210 s `idleTimeoutMs` is aborted at 210 s with `[Agent] idle watchdog fired`
   * on stderr and no other explanation.
   */
  withPausedWatchdog: <T>(fn: () => Promise<T>) => Promise<T>;
}

const BUSY_REFUSAL =
  'A team dispatch is already running. Wait for its report before starting another.';

const TEAM_OFF_REFUSAL =
  'Team mode is off for this session. Do this work yourself, in order.';

/**
 * The model-facing description. Deliberately close to Claude Code's `Task` tool
 * (R-f): what a model already knows about that transfers directly, and the one
 * visible difference — the batch — is stated in the first sentence.
 */
const TASK_DESCRIPTION =
  'Run several independent subagents in parallel and get one combined report. Each ' +
  'subagent is a fresh agent with the same tools and working directory but NO memory of ' +
  'this conversation - its prompt must be self-contained. Use this when a task splits ' +
  'into 2 or more parts that do not depend on each other\'s output, especially reading or ' +
  'searching several areas at once. Do NOT use it when one part needs another part\'s ' +
  'result (do those yourself, in order), when two parts would edit the same file, or for ' +
  'a change small enough to just make. Subagents cannot dispatch further subagents and ' +
  'cannot ask the user anything. Give each a description of at most ' +
  `${TEAM_LIMITS.descriptionChars} characters and a complete prompt. Extra entries beyond the ` +
  'configured maximum are dropped, so keep within it.';

/**
 * The one sentence appended when the fast tier exists (fast-model-tier §4.1).
 *
 * WHEN to use a tier is POLICY and lives here and in `<fast_tier>`, where the
 * model actually reads it; the `enum` below is SHAPE and lives in the schema.
 * That split is what keeps behaviour the same whether or not `ajv` — an OPTIONAL
 * dependency of core — happened to install (C-8).
 */
const TASK_FAST_SENTENCE =
  ' Set model:"fast" on a subagent whose job is bulk reading, searching or summarizing; ' +
  'leave it out for work that needs judgement.';

/**
 * NOT `as const`: `AgentTool.parameters` is a `JSONSchema7`, whose `enum` is a
 * MUTABLE `unknown[]`, and a readonly tuple is not assignable to it.
 */
const SUBAGENT_MODEL_PROPERTY = {
  type: 'string',
  enum: ['main', 'fast'],
  default: 'main',
  description:
    'Which tier runs this subagent. "fast" is a cheaper, quicker model - use it for ' +
    'mechanical, high-volume work (reading or searching many files, summarizing long ' +
    'output, mechanical edits). Keep "main" for design, tricky debugging, and anything ' +
    'that must be right the first time.',
};

export function createTaskTool(deps: TaskToolDeps): AgentTool {
  const fastRegistered = deps.fastRegistered === true;
  return {
    name: 'task',
    label: 'Dispatch subagents',
    // BYTE-IDENTICAL WITHOUT THE TIER (AC-3): concatenation is conditional, so a
    // default session's description is the exact string it always was.
    description: fastRegistered ? `${TASK_DESCRIPTION}${TASK_FAST_SENTENCE}` : TASK_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        subagents: {
          type: 'array',
          description:
            `2-5 independent subagents to run in parallel (hard maximum ${TEAM_LIMITS.hardMaxSubagents}; ` +
            'extras are dropped).',
          items: {
            type: 'object',
            properties: {
              label: {
                type: 'string',
                description: `Short id, <= ${TEAM_LIMITS.labelChars} chars, e.g. "api". Shown in the UI.`,
              },
              description: {
                type: 'string',
                description: `<= ${TEAM_LIMITS.descriptionChars} chars. What this subagent is for.`,
              },
              prompt: {
                type: 'string',
                description:
                  'The full brief. Self-contained: the subagent cannot see this conversation.',
              },
              readOnly: {
                type: 'boolean',
                default: false,
                description: 'Refuse all writes and shell for this subagent.',
              },
              // Spread rather than a `?:` property, so with the tier off the
              // object has exactly the four keys it always had — `undefined`
              // survives `JSON.stringify` as an absent key but not as an
              // identical object, and AC-3 is asserted on the schema itself.
              ...(fastRegistered ? { model: SUBAGENT_MODEL_PROPERTY } : {}),
            },
            required: ['description', 'prompt'],
          },
        },
      },
      required: ['subagents'],
    },

    async execute(_id, params, ctx): Promise<ToolResult> {
      // 1. Already dispatching. Unreachable while I-1 holds; present so the
      //    guarantee belongs to this module (R-14).
      if (deps.runtime.isBusy()) return textResult(BUSY_REFUSAL);

      // 2. Turned off mid-session. `task` is registered ONCE at construction and
      //    the array is immutable (§4.5 / D-17), so `/team off` cannot
      //    unregister it — it flips this closure instead. Read live, never
      //    cached.
      if (!deps.isTeamEnabled()) return textResult(TEAM_OFF_REFUSAL);

      // 3. No usable key (P2-3). `preflight()` runs before the LOOP, not before
      //    a tool call, so a key emptied through the settings screen mid-session
      //    would otherwise produce N identical stream failures — N times the
      //    cost of one refusal, and a report the model may well retry.
      if (!deps.hasApiKey()) {
        return textResult(
          `Team dispatch skipped: no API key for ${deps.activeProvider()}. Do this work ` +
            'yourself, or ask the user to set a key.',
        );
      }

      // 4. Repair, never reject. Zero survivors is the single hard failure.
      //    `fastAvailable` is read HERE, at dispatch time, not captured at
      //    construction (RV-3): the tier can stop resolving mid-session, and the
      //    normalizer and the subagent factory must agree about that at the same
      //    instant or a child gets built against a provider with no key.
      const { specs, requested, downgraded } = normalizeSubagentSpecs(
        (params as { subagents?: unknown }).subagents,
        deps.maxSubagents(),
        { fastAvailable: deps.fastAvailable?.() === true },
      );
      if (specs.length === 0) {
        return errorResult('No usable subagent specs: each needs a description and a prompt.');
      }

      // 5. Pause the lead's watchdog for the whole dispatch (I-3).
      const outcome = await deps.withPausedWatchdog(() =>
        deps.runtime.dispatch(specs, requested, ctx.signal, { downgraded }),
      );

      // 6. ALWAYS A NON-ERROR RESULT, abort and all-children-failed included.
      //    A cancellation or a partial result rendered as a tool FAILURE invites
      //    the model to retry the whole fan-out, which is the most expensive
      //    possible reaction (the same reasoning as `ask_user`'s cancelled
      //    shape, and D-14 one level up).
      //    TWO COST TABLES (§3.4 / R-7). Summing fast-tier tokens at the lead's
      //    price is not a rounding error: for a Haiku child under a Sonnet lead
      //    it over-reports by roughly an order of magnitude, and the whole
      //    justification for the feature is a number in this report.
      const cost = deps.modelCost();
      const fastCost = deps.fastModelCost?.();
      return textResult(
        buildDispatchReport(outcome, {
          ...(cost ? { cost } : {}),
          ...(fastCost ? { fastCost } : {}),
          ...(deps.fastPricingUnknown?.() ? { fastPricingUnknown: true } : {}),
        }),
      );
    },
  };
}
