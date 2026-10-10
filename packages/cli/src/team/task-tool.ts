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
 *
 * EVERY CHILD RUNS THE LEAD'S OWN MODEL (main-agent parity): same provider,
 * model, thinking level and token ambition, resolved from the LIVE config at
 * dispatch. There is no per-child `model` property and no cheap tier to pick -
 * a delegation is never a downgrade, and the fast tier reaches children the
 * same way it reaches the lead (compaction summaries, per-child reviews).
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
  maxSubagents: () => number;
  /** Whether a usable key exists for the active provider right now (P2-3). */
  hasApiKey: () => boolean;
  activeProvider: () => string;
  /** The lead's cost table, so the report header states real spend (R-5). */
  modelCost: () => ModelCost | undefined;
  /**
   * The FAST tier's cost table, so the report's supervisor spend line states
   * real spend (subagent-overseer-v2 D-7 / R-P1-2). OPTIONAL and returning
   * `undefined`: an unpriced fast model renders `pricing unknown`, never a
   * fabricated `$0.00` - the C-11 / RV-4 rule.
   */
  fastModelCost?: () => ModelCost | undefined;
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
  'this conversation - its prompt must be self-contained. Each runs on the same model ' +
  'you are running on. Use this when a task splits ' +
  'into 2 or more parts that do not depend on each other\'s output, especially reading or ' +
  'searching several areas at once. Do NOT use it when one part needs another part\'s ' +
  'result (do those yourself, in order), when two parts would edit the same file, or for ' +
  'a change small enough to just make. Subagents cannot dispatch further subagents and ' +
  'cannot ask the user anything. Give each a description of at most ' +
  `${TEAM_LIMITS.descriptionChars} characters and a complete prompt. Extra entries beyond the ` +
  'configured maximum are dropped, so keep within it. A supervisor watches the ' +
    'fan-out: a child that stalls or runs very long may be nudged with guidance ' +
    'or replaced by a fresh attempt, and the report\'s Supervisor section ' +
    'records every intervention.';

export function createTaskTool(deps: TaskToolDeps): AgentTool {
  return {
    name: 'task',
    label: 'Dispatch subagents',
    description: TASK_DESCRIPTION,
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
      const { specs, requested } = normalizeSubagentSpecs(
        (params as { subagents?: unknown }).subagents,
        deps.maxSubagents(),
      );
      if (specs.length === 0) {
        return errorResult('No usable subagent specs: each needs a description and a prompt.');
      }

      // 5. Pause the lead's watchdog for the whole dispatch (I-3).
      const outcome = await deps.withPausedWatchdog(() =>
        deps.runtime.dispatch(specs, requested, ctx.signal),
      );

      // 6. ALWAYS A NON-ERROR RESULT, abort and all-children-failed included.
      //    A cancellation or a partial result rendered as a tool FAILURE invites
      //    the model to retry the whole fan-out, which is the most expensive
      //    possible reaction (the same reasoning as `ask_user`'s cancelled
      //    shape, and D-14 one level up). Every child ran the lead's own model,
      //    so the lead's cost table is the one honest price for the total.
      const cost = deps.modelCost();
      const fastCost = deps.fastModelCost?.();
      return textResult(
        buildDispatchReport(outcome, {
          ...(cost ? { cost } : {}),
          ...(fastCost ? { fastCost } : {}),
        }),
      );
    },
  };
}
