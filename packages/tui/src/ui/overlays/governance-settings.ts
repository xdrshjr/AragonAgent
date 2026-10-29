/**
 * Settings > Governance: the pure half of the page (governance-mode 11.1).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * FIELD DEFINITIONS AND THE ARROW-KEY STEP, NOTHING ELSE. `SettingsScreen.tsx` is far past
 * the size limit, so the page lists its rows from here and adds wiring only, mirroring
 * `team-fanout-state.ts`. Every value a step produces goes back through
 * `clampGovernanceConfig`, so the page, `config set` and a hand-edited `config.json` can
 * never disagree about a range.
 *
 * THE PAGE MAY WRITE THE ELEVEN POLICY KEYS AND NOTHING ELSE. The structural bounds
 * (`GOV_LIMITS`) are not settings: a number a user can tune past what the store and the
 * panel can carry is not a preference, it is a crash.
 */

import {
  clampGovernanceConfig,
  governanceRangeOf,
  GOVERNANCE_NUMERIC_KEYS,
  type GovernanceConfig,
} from '../../model/config/governance-config.js';
import type { ModelSettingsDraft } from '../../model/config/model-settings-types.js';
import { PROFILE_IDS } from '../../model/governance/types.js';

export type GovernanceSettingKey = keyof GovernanceConfig;
export type GovernanceSettingKind = 'toggle' | 'number' | 'choice';

export interface GovernanceSettingDef {
  key: GovernanceSettingKey;
  /** At most 17 columns: the page pads labels to 18, like the Team page. */
  label: string;
  /** One line, at most 60 columns: WHY this setting, not a restatement of the label. */
  description: string;
  kind: GovernanceSettingKind;
  /** Inclusive; numbers only. Read from the clamp, never repeated here. */
  range?: { min: number; max: number };
  /** Arrow-key increment; numbers only. */
  step?: number;
  /** Cycle order; choices only. */
  choices?: readonly string[];
}

type NumericKey = (typeof GOVERNANCE_NUMERIC_KEYS)[number];

function numeric(
  key: NumericKey, label: string, description: string, step = 1,
): GovernanceSettingDef {
  return { key, label, description, kind: 'number', range: governanceRangeOf(key), step };
}

/** The rows in cursor order. The switch is first: the rest describe what it turns on. */
export const GOVERNANCE_SETTING_DEFS: readonly GovernanceSettingDef[] = [
  { key: 'enabled', label: 'Governance', kind: 'toggle',
    description: 'Off removes it entirely. Turning it on needs a restart.' },
  { key: 'shiftTab', label: 'Shift+Tab cycle', kind: 'toggle',
    description: 'Off keeps Shift+Tab on BUILD/PLAN; /gov still works.' },
  { key: 'panel', label: 'Legion panel', kind: 'toggle',
    description: 'Off shows the status chip only, no panel.' },
  { key: 'profile', label: 'Profile', kind: 'choice', choices: PROFILE_IDS,
    description: 'Domain wording for the roles and their checklists.' },
  numeric('maxWorkPackages', 'Work packages', 'Most work packages one run may define.'),
  numeric('maxPhases', 'Phases', 'Most dev/review/test rounds one run may take.'),
  numeric('maxRework', 'Rework rounds', 'Rework rounds per work package before escalation.'),
  numeric('maxFixCycles', 'Fix cycles', 'Fix cycles per phase after integration fails.'),
  numeric('minAskRounds', 'Ask rounds', 'Questions PLAN+GOVERN asks before a plan is allowed.'),
  numeric('budgetTokens', 'Token budget', 'Per-run token ceiling; 0 means unlimited.', 100_000),
  { key: 'confirmCharter', label: 'Confirm charter', kind: 'toggle',
    description: 'On asks you to approve the run plan before any dispatch.' },
];

export interface GovernanceSettingRow {
  key: GovernanceSettingKey;
  label: string;
  /** The value as the page prints it (`'on'` / `'3'` / `'unlimited'`). */
  value: string;
  /** Description plus the range, one line. */
  hint: string;
}

function formatValue(def: GovernanceSettingDef, config: GovernanceConfig): string {
  const value = config[def.key];
  if (def.kind === 'toggle') return value ? 'on' : 'off';
  if (def.key === 'budgetTokens') return value === 0 ? 'unlimited' : String(value);
  return String(value);
}

function formatHint(def: GovernanceSettingDef): string {
  if (def.range === undefined) return def.description;
  return `${def.description} (${def.range.min}-${def.range.max})`;
}

/** The page's rows for the CLAMPED section, so the screen shows what would be saved. */
export function governanceSettingRows(values: unknown): GovernanceSettingRow[] {
  const config = clampGovernanceConfig(values);
  return GOVERNANCE_SETTING_DEFS.map((def) => ({
    key: def.key,
    label: def.label,
    value: formatValue(def, config),
    hint: formatHint(def),
  }));
}

function stepNumber(
  config: GovernanceConfig, def: GovernanceSettingDef, delta: -1 | 1,
): Partial<GovernanceConfig> {
  const key = def.key as NumericKey;
  // NO WRAPAROUND: a form control is not a ring, and Left at the floor jumping to the
  // ceiling would be a way to raise a limit while trying to lower it. The clamp does it.
  const next = clampGovernanceConfig({ ...config, [key]: config[key] + delta * (def.step ?? 1) });
  return { [key]: next[key] };
}

function stepChoice(
  config: GovernanceConfig, def: GovernanceSettingDef, delta: -1 | 1,
): Partial<GovernanceConfig> {
  const choices = def.choices ?? [];
  const at = choices.indexOf(String(config[def.key]));
  const next = choices[(at + delta + choices.length) % choices.length];
  // Through the clamp, so a choice list that ever drifts from the clamp's vocabulary cannot
  // write a value the read path would silently repair.
  const stored = clampGovernanceConfig({ ...config, [def.key]: next })[def.key];
  return { [def.key]: stored };
}

/**
 * The PATCH FRAGMENT for one arrow press, for a section the screen already shows
 * (`current`). Exactly one key, so a step can never carry a second one into the draft.
 * Toggles flip on either arrow, as on the Team page: a direction means nothing for two
 * states. An unknown key yields an empty patch rather than throwing.
 */
export function stepGovernanceSetting(
  current: unknown, key: GovernanceSettingKey, delta: -1 | 1,
): Partial<GovernanceConfig> {
  const config = clampGovernanceConfig(current);
  const def = GOVERNANCE_SETTING_DEFS.find((candidate) => candidate.key === key);
  if (def === undefined) return {};
  if (def.kind === 'toggle') return { [key]: !config[key] };
  return def.kind === 'number' ? stepNumber(config, def, delta) : stepChoice(config, def, delta);
}

/**
 * The governance section this draft would save: the patch over the disk baseline, then the
 * clamp (governance-mode-v1-1 5.2). Same order as `teamFanoutValues`, and the clamp is not
 * cosmetic: it is what makes the number on screen the number `Ctrl+S` writes, whatever a
 * hand-edited `config.json` or an old patch carried.
 */
export function draftGovernance(draft: ModelSettingsDraft): GovernanceConfig {
  return clampGovernanceConfig({ ...draft.baseline.governance, ...draft.patch.governance });
}

/** `0` is unlimited; otherwise a compact figure (`500k`, `1.2M`). */
function budgetText(tokens: number): string {
  if (tokens <= 0) return 'unlimited';
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1_000)}k`;
}

/**
 * The one-line summary the settings root row prints. A DERIVED row, never a control: the
 * values change on the page Enter opens, so the root row cannot be moved by a stray arrow.
 * `off` alone when the switch is off, because the numbers then describe a capability that
 * is not there (the `teamSummary` rule).
 */
export function governanceSummary(config: GovernanceConfig): string {
  if (!config.enabled) return 'off';
  return [
    'on',
    `${config.maxWorkPackages} WP`,
    `${config.maxPhases} phases`,
    `rework ${config.maxRework}`,
    `budget ${budgetText(config.budgetTokens)}`,
  ].join(' | ');
}

export type GovernanceRestartNote = string | null;

/**
 * Whether saving the `enabled` switch would not take effect in THIS session. The tool array
 * is immutable after construction (v1 D-22), so a draft that disagrees with what was
 * registered at launch only applies next launch, and the page says so rather than letting a
 * user believe a toggle summoned `gov_run` into the running session. `undefined` means the
 * host did not say, and the page then discloses nothing (every fixture builds props by
 * literal).
 */
export function governanceRestartNote(
  enabledInDraft: boolean,
  registeredAtLaunch: boolean | undefined,
): GovernanceRestartNote {
  if (registeredAtLaunch === undefined || enabledInDraft === registeredAtLaunch) return null;
  return 'Governance is registered at launch; this change applies next launch.';
}
