/**
 * Settings > Team: the pure half of the page (subagent-fanout 3.4.2, extended by
 * team-command-forced-dispatch §3.9).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * THE PAGE WRITES FOUR KEYS AND CANNOT BE MADE TO WRITE A FIFTH (D-17 / R-P0-1).
 * `TeamFanoutPatch` is `Pick<TeamConfig, 'enabled' | 'maxSubagents' |
 * 'maxConcurrent' | 'overseer'>`, and `stepFanoutValue` returns
 * `Partial<TeamFanoutPatch>`: a width adjustment therefore CANNOT carry `model`
 * or `modelProfileId` into `draft.patch.team`. That matters because
 * `releasedSlots` reads those two keys as "the user re-decided the subagent
 * slot", so a page that returned the whole section would silently release the
 * model a session kit had just installed - and no test would notice, because
 * every value on screen would still be right.
 *
 * FOUR KEYS BECAUSE `enabled` MOVED HERE (team-command-forced-dispatch D-3): the
 * team switch used to be reachable only as `/team on|off`, which also wrote
 * `config.json`. The switch belongs on the same page as width, concurrency and
 * supervision - they are four faces of one decision - and `/team` is now the ACT
 * ("arm this session"), never a configuration write (I-4).
 *
 * EVERYTHING HERE IS A PURE FUNCTION over the draft. The page owns exactly one
 * piece of state (its cursor); values come from the reducer, which is the same
 * discipline the rest of this screen follows.
 */

import { clampTeamConfig, HARD_MAX_SUBAGENTS } from '../../model/config/schema.js';
import type { TeamConfig } from '../../model/config/schema.js';
import type { ModelSettingsDraft } from '../../model/config/model-settings-types.js';

export type TeamFanoutField = 'enabled' | 'maxSubagents' | 'maxConcurrent' | 'overseer';

/**
 * THE ONLY KEYS THIS PAGE MAY WRITE (R-P0-1).
 *
 * Not `Partial<TeamConfig>`: a fragment that could carry `model` would make a
 * width adjustment read as a model decision at save time.
 */
export type TeamFanoutPatch =
  Pick<TeamConfig, 'enabled' | 'maxSubagents' | 'maxConcurrent' | 'overseer'>;

export interface TeamFanoutRow {
  field: TeamFanoutField;
  label: string;
  /** The value as the page prints it (`'8'` / `'on'`). */
  value: string;
  /** One line, <= 60 columns: WHY this number, not a restatement of the label. */
  hint: string;
}

export interface TeamFanoutView {
  /** Exactly four, in the fixed order the cursor indexes. */
  rows: TeamFanoutRow[];
  error?: string;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/**
 * The CLAMPED team section this draft would save (R-P0-2), for display only.
 *
 * THE CLAMP IS NOT COSMETIC. Without it a patch carrying only
 * `maxSubagents: 6` renders "6 per dispatch, 8 at once" on top of an 8-wide
 * baseline, while `mergePersistedConfig` clamps the same patch to 6/6 on the way
 * to disk - so the screen and the file disagree, and every arrow key makes the
 * user reconcile them by hand.
 */
export function teamFanoutValues(draft: ModelSettingsDraft): TeamConfig {
  return clampTeamConfig({ ...draft.baseline.team, ...draft.patch.team });
}

/**
 * The PATCH FRAGMENT for one arrow press, clamped exactly like `clampTeamConfig`.
 *
 * `current` must be the value the screen actually shows (`teamFanoutValues`), so
 * a step always starts from a number the user can see.
 *
 * NO WRAPAROUND: a form control is not a ring, and `Left` at 1 jumping to 10
 * would be a way to widen a dispatch while trying to narrow it.
 *
 * EVERY MEMBER IS HANDLED EXPLICITLY AND THE TAIL IS `never` (P0-1). The old
 * body was three `if`s with the `maxSubagents` branch as the FALLTHROUGH, so
 * adding `'enabled'` to the union compiled cleanly and made the new `Team mode`
 * row adjust `Max subagents` instead - every number on screen self-consistent,
 * no test red, and the user's intent to switch the team OFF arrived as a wider
 * fan-out. The `never` assignment below turns that class of mistake into a
 * compile error, which is the only place it can be caught cheaply.
 */
export function stepFanoutValue(current: TeamConfig, field: TeamFanoutField,
  delta: -1 | 1): Partial<TeamFanoutPatch> {
  if (field === 'enabled') {
    // Both arrows toggle: `Team mode` has two states, and a direction has no
    // meaning beyond "the user pressed an arrow" (the `Supervisor` rule below).
    return { enabled: !current.enabled };
  }
  if (field === 'overseer') {
    return { overseer: !current.overseer };
  }
  if (field === 'maxConcurrent') {
    const ceiling = Math.min(HARD_MAX_SUBAGENTS, current.maxSubagents);
    return { maxConcurrent: clampInt(current.maxConcurrent + delta, 1, ceiling) };
  }
  if (field === 'maxSubagents') {
    const next = clampInt(current.maxSubagents + delta, 1, HARD_MAX_SUBAGENTS);
    // THE FOLLOW-DOWN IS WRITTEN INTO THE PATCH (R-P1-9), not just rendered: a
    // narrower population cannot keep a wider pool, but a DISPLAY-only correction
    // would snap back the moment the user widened again, so "the change I just
    // made" would not stick - the exact complaint this design exists to answer.
    return current.maxConcurrent > next
      ? { maxSubagents: next, maxConcurrent: next }
      : { maxSubagents: next };
  }
  // THE EXHAUSTIVE GUARD IS THE POINT (P0-1): a new member of `TeamFanoutField`
  // must fail to COMPILE here, not silently fall through to `maxSubagents`.
  //
  // IT SITS AFTER EVERY BRANCH RETURNS, not before the last one. §3.9's snippet
  // shows it above the `maxSubagents` branch, where TypeScript rejects the file
  // outright (`'maxSubagents' is not assignable to 'never'`) - the intent
  // survives, the position does not.
  const _exhaustive: never = field;
  return _exhaustive;
}

/**
 * The page's four rows, in cursor order.
 *
 * `Team mode` IS FIRST because it is the premise of the other three: with `task`
 * out of the tool list there is no width to configure and no supervisor to run,
 * and a page that listed the numbers first would invite the user to tune a
 * capability they had switched off.
 *
 * TWO HINTS CARRY A CONDITION THE DESIGN OWNS RATHER THAN DECORATION (R-1 / C-2):
 * the default pool is 8, which is 8 simultaneous streams against one API key, and
 * the honest mitigation for an HTTP 429 storm is "lower this number" - said HERE,
 * where the number is, not only in a risk table nobody reads.
 *
 * `teamRegistered === false` (a `--no-team` session) changes TWO things on the
 * `enabled` row and nothing else: `on (next launch)` because the tool array is
 * immutable (I-7), and a hint that says why. Absent means "not disclosed",
 * which every existing fixture relies on.
 */
export function fanoutRows(team: TeamConfig, teamRegistered?: boolean): TeamFanoutRow[] {
  const blocked = teamRegistered === false && team.enabled;
  return [
    {
      field: 'enabled',
      label: 'Team mode',
      value: blocked ? 'on (next launch)' : team.enabled ? 'on' : 'off',
      hint: blocked
        ? '--no-team session: the task tool cannot be added live'
        : 'off: no task tool next launch; this session may lack it',
    },
    {
      field: 'maxSubagents',
      label: 'Max subagents',
      value: String(team.maxSubagents),
      hint: `children per dispatch; ${HARD_MAX_SUBAGENTS} is the hard ceiling`,
    },
    {
      field: 'maxConcurrent',
      label: 'Run at once',
      value: String(team.maxConcurrent),
      hint: 'provider limits: lower this if you see rate-limit errors',
    },
    {
      field: 'overseer',
      label: 'Supervisor',
      value: team.overseer ? 'on' : 'off',
      hint: 'checks stalled children; never kills them',
    },
  ];
}

/**
 * The one-line summary the settings root row prints for this page.
 *
 * `off - no subagents` rather than the numbers, because with the capability off
 * the numbers describe nothing the user can spend. This replaced
 * `fanoutSummary()` outright instead of living beside it: two summary functions
 * over one page is two authorities for one line, and the root row would sooner or
 * later disagree with the page it summarises.
 */
export function teamSummary(team: TeamConfig): string {
  if (!team.enabled) return 'off - no subagents';
  return `${team.maxSubagents} per dispatch, ${team.maxConcurrent} at once`;
}
