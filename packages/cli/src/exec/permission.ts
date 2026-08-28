/**
 * The non-interactive tool-permission policy (cli-integration-surface section
 * 4.2 / 5.3).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope.
 *
 * PURE. No I/O, no process access. The only import is the comm-tool name set,
 * for the reason invariant 4 records below.
 *
 * TWO ORTHOGONAL CONTROLS, EACH WITH EXACTLY ONE MEANING:
 *
 *   `--permission-mode`  selects the BASELINE  (`auto` everything, `plan`
 *                        everything, `strict` nothing)
 *   `--allow-tool`       ADDS to the baseline
 *   `--deny-tool`        REMOVES, and wins over allow
 *
 * `plan` CONTRIBUTES NOTHING TO THE FILTER, and getting that wrong was P0-2.
 * `--plan` does not unregister the five in `PLAN_MODE_BLOCKED_TOOLS`:
 * `tools/index.ts::withPlanModeGate` wraps every tool and returns
 * `planRefusal(name)` for those five AT CALL TIME, so they stay in
 * `listTools()`. Unregistering them here instead would (a) make AC-15
 * unsatisfiable - it compares the registered set against `-p --plan` name by
 * name, (b) make `system/init.tools` disagree between two spellings of one mode,
 * and (c) cost the model the refusal text that steers it to `submit_plan`. In
 * plan mode the point is that the model KNOWS the write exists and is being
 * deferred; for a deny list the point is the opposite (D-4).
 */

import { TEAM_SUBAGENT_TOOL_NAMES } from '../team/limits.js';

export type PermissionMode = 'auto' | 'plan' | 'strict';

export interface ToolPermission {
  mode: PermissionMode;
  allow: ReadonlySet<string>;
  deny: ReadonlySet<string>;
  /** Resolved per tool array; the only method the tool factory calls. */
  isAllowed(tool: string): boolean;
}

export interface ResolvePermissionInput {
  mode: PermissionMode;
  allow: readonly string[];
  deny: readonly string[];
}

/**
 * Whether a single name survives the policy.
 *
 * `TEAM_SUBAGENT_TOOL_NAMES` IS ALWAYS ALLOWED (invariant 4 / P1-3).
 * `team_send` / `team_wait` are registered only on CHILDREN and are the
 * mechanism children use to coordinate; filtering them out of a `strict` run
 * would break subagent messaging in a way that reads as a hang - a child waiting
 * for mail that can never arrive.
 *
 * The set is IMPORTED, not restated. v1 proposed a new `EXEC_POLICY_EXEMPT`
 * beside `SKILL_TOOL_FLOOR`; that would be a second list of the same two names
 * (the drift `tools/index.ts` keeps its two sets adjacent to avoid) AND a third
 * meaning for one word, since `policyExempt` already means "skips the CEILING
 * wrapper only, never the plan gate, never confirmation".
 */
function decide(input: ResolvePermissionInput, tool: string): boolean {
  if (TEAM_SUBAGENT_TOOL_NAMES.has(tool)) return true;
  // Deny wins, unconditionally and first. A caller who names one tool in both
  // lists gets the safe reading, and a wrapper that concatenates two config
  // fragments cannot accidentally re-enable something the outer one removed.
  if (input.deny.includes(tool)) return false;
  if (input.mode === 'strict') return input.allow.includes(tool);
  return true;
}

/**
 * The whole policy as a pure set operation over a REGISTERED list.
 *
 * Exported for the unit test and for anything that wants to describe the policy
 * without building tools. The runtime path goes through `isAllowed` instead,
 * because `createBuiltinTools` filters the array it is in the middle of
 * assembling and has no "registered list" to hand over.
 */
export function resolveToolAllowList(
  registered: readonly string[],
  mode: PermissionMode,
  allow: readonly string[],
  deny: readonly string[],
): ReadonlySet<string> {
  const input: ResolvePermissionInput = { mode, allow, deny };
  return new Set(registered.filter((name) => decide(input, name)));
}

/**
 * Build the object the tool factory receives, or `undefined` when the policy is
 * a no-op.
 *
 * RETURNING `undefined` IS WHAT MAKES SECTION 4.2 INVARIANT 2 HOLD BY
 * CONSTRUCTION RATHER THAN BY CARE (P1-2). With no `permission` key in the
 * options bag, `createBuiltinTools` never enters its filter branch and returns
 * the same tool OBJECTS it does today - which is what AC-28 asserts by identity,
 * the discipline `AC-G17` already applies to `--no-skills`.
 *
 * `strict` always produces an object, even with empty lists: an empty allow list
 * under `strict` means "no tools at all", which is a real posture and not an
 * absence of one. `auto` and `plan` with no lists produce nothing, and that
 * covers every existing path plus the documented `--permission-mode plan`
 * alias of `-p --plan`.
 */
export function resolvePermission(input: ResolvePermissionInput): ToolPermission | undefined {
  if (input.mode !== 'strict' && input.allow.length === 0 && input.deny.length === 0) {
    return undefined;
  }
  const allow = new Set(input.allow);
  const deny = new Set(input.deny);
  return {
    mode: input.mode,
    allow,
    deny,
    isAllowed: (tool: string) => decide(input, tool),
  };
}
