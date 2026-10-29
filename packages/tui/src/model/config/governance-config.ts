/**
 * Governance-mode configuration (governance-mode sections 11.1 / 13.2).
 *
 * LIVES IN ITS OWN FILE, NOT IN `schema.ts`: that file is far past the repo's
 * 1000-line limit, and a section whose clamp depends on nothing else in it has no
 * reason to grow it. `schema.ts` imports and re-exports everything below, so every
 * importer still reaches the section through `config/schema.js`.
 *
 * SELF-CONTAINED ON PURPOSE. The integer/boolean helpers in `schema.ts` are private,
 * and importing back from it would make a cycle (`schema.ts` re-exports this file).
 * The two helpers here are four lines each.
 *
 * ASCII ONLY: `src/config/**` is inside the glyph scanner's scope.
 */

import process from 'node:process';
import { GOV_LIMITS } from '../governance/limits.js';
import type { Posture } from '../governance/posture.js';
import { PROFILE_IDS, type ProfileId } from '../governance/types.js';

export interface GovernanceConfig {
  /** `false` => the feature is absent: no tools, no prompt blocks, no posture. */
  enabled: boolean;
  /** `false` => Shift+Tab stays BUILD<->PLAN; `/gov` still works. */
  shiftTab: boolean;
  /** `false` => the status chip only, no legion panel. */
  panel: boolean;
  /** Domain profile that names the roles' focus areas. */
  profile: ProfileId;
  /** 1..8. Work packages per run. */
  maxWorkPackages: number;
  /** 1..6. Phases per run. */
  maxPhases: number;
  /** 1..5. Rework rounds per work package. */
  maxRework: number;
  /** 1..5. Fix cycles per phase. */
  maxFixCycles: number;
  /** 0..5. Question rounds before PLAN+GOVERN may submit a plan. */
  minAskRounds: number;
  /** 0..1_000_000_000. Token budget per run; `0` = unlimited. */
  budgetTokens: number;
  /** `true` => the user approves the run charter before any dispatch. */
  confirmCharter: boolean;
}

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = {
  enabled: true,
  shiftTab: true,
  panel: true,
  profile: 'general',
  maxWorkPackages: 4,
  maxPhases: 3,
  maxRework: 3,
  maxFixCycles: 3,
  minAskRounds: 2,
  budgetTokens: 0,
  confirmCharter: false,
};

/**
 * Inclusive range per numeric key. The upper bounds of the four structural keys are
 * `GOV_LIMITS.hardMax*` (NOT repeated here), so the clamp and the engine can never
 * disagree: a hand-edited `config.json` cannot exceed what the engine enforces.
 */
const NUMERIC_RANGES: Readonly<Record<NumericKey, { min: number; max: number }>> = {
  maxWorkPackages: { min: 1, max: GOV_LIMITS.hardMaxWorkPackages },
  maxPhases: { min: 1, max: GOV_LIMITS.hardMaxPhases },
  maxRework: { min: 1, max: GOV_LIMITS.hardMaxRework },
  maxFixCycles: { min: 1, max: GOV_LIMITS.hardMaxFixCycles },
  minAskRounds: { min: 0, max: 5 },
  budgetTokens: { min: 0, max: 1_000_000_000 },
};

type NumericKey =
  | 'maxWorkPackages' | 'maxPhases' | 'maxRework' | 'maxFixCycles'
  | 'minAskRounds' | 'budgetTokens';

/** The numeric keys, in display order; shared with the settings and `config` surfaces. */
export const GOVERNANCE_NUMERIC_KEYS: readonly NumericKey[] = Object.keys(
  NUMERIC_RANGES,
) as NumericKey[];

/** The inclusive range a numeric key is clamped to. */
export function governanceRangeOf(key: NumericKey): { min: number; max: number } {
  return NUMERIC_RANGES[key];
}

/**
 * Only a real, finite INTEGER survives. A float, NaN, a string ("2") or null is
 * REPAIRED TO THE DEFAULT, not rounded or coerced: a hand-edited `maxRework: 2.5` has no
 * defensible reading, and "typo changes nothing" is the discipline every sibling clamp
 * follows. Out-of-range integers are clamped, not rejected.
 */
function clampRangedInt(value: unknown, key: NumericKey): number {
  const range = NUMERIC_RANGES[key];
  const fallback = DEFAULT_GOVERNANCE_CONFIG[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function pickProfile(value: unknown): ProfileId {
  return typeof value === 'string' && (PROFILE_IDS as readonly string[]).includes(value)
    ? (value as ProfileId)
    : DEFAULT_GOVERNANCE_CONFIG.profile;
}

/**
 * THE single gate for every governance-config read AND write, mirroring
 * `clampTeamConfig` for the reason that one records: hardening only the read path
 * leaves a bad value on disk that the read path then rewrites on every launch, which
 * presents to the user as "my setting won't stick". Unknown keys are dropped.
 */
export function clampGovernanceConfig(raw: unknown): GovernanceConfig {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Partial<
    Record<keyof GovernanceConfig, unknown>
  >;
  const defaults = DEFAULT_GOVERNANCE_CONFIG;
  return {
    enabled: pickBool(src.enabled, defaults.enabled),
    shiftTab: pickBool(src.shiftTab, defaults.shiftTab),
    panel: pickBool(src.panel, defaults.panel),
    profile: pickProfile(src.profile),
    maxWorkPackages: clampRangedInt(src.maxWorkPackages, 'maxWorkPackages'),
    maxPhases: clampRangedInt(src.maxPhases, 'maxPhases'),
    maxRework: clampRangedInt(src.maxRework, 'maxRework'),
    maxFixCycles: clampRangedInt(src.maxFixCycles, 'maxFixCycles'),
    minAskRounds: clampRangedInt(src.minAskRounds, 'minAskRounds'),
    budgetTokens: clampRangedInt(src.budgetTokens, 'budgetTokens'),
    confirmCharter: pickBool(src.confirmCharter, defaults.confirmCharter),
  };
}

// ---------------------------------------------------------------------------
// Environment kill switch + availability (config-level part)
// ---------------------------------------------------------------------------

/** The spellings of "off" the kill switch accepts, matching the other ARAGON_* switches. */
const ENV_OFF_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'off', 'no']);

/**
 * `ARAGON_GOVERNANCE=0` is a KILL switch, not a toggle: it can only disable. Any other
 * value (including `1`) is ignored, so an environment can never switch a feature ON that
 * the user's config or a `--no-governance` flag turned off.
 *
 * Takes the env as a parameter so tests and `doctor` do not touch `process.env`.
 */
export function isGovernanceEnvDisabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = env.ARAGON_GOVERNANCE?.trim().toLowerCase();
  return value !== undefined && ENV_OFF_VALUES.has(value);
}

/**
 * The config-level reasons governance can be unavailable. A SUBSET of the
 * `GovernanceUnavailableReason` vocabulary in `governance/copy.ts` (the controller adds
 * `no_api_key`, `headless`, `restart_required` at runtime); the codes are spelled
 * identically so the integration can unify the two without renaming anything.
 */
export type GovernanceConfigUnavailableReason = 'disabled_config' | 'disabled_env' | 'team_off';

export type GovernanceConfigAvailability =
  | { ok: true }
  | { ok: false; reason: GovernanceConfigUnavailableReason };

/**
 * Config-only availability, in precedence order: the environment kill switch first (it is
 * the strongest), then the config key, then the team dependency. Pure: no I/O.
 */
export function describeGovernanceConfigAvailability(
  config: { governance?: Pick<GovernanceConfig, 'enabled'>; team: { enabled: boolean } },
  env: Readonly<Record<string, string | undefined>> = process.env,
): GovernanceConfigAvailability {
  if (isGovernanceEnvDisabled(env)) return { ok: false, reason: 'disabled_env' };
  if (config.governance?.enabled === false) return { ok: false, reason: 'disabled_config' };
  if (!config.team.enabled) return { ok: false, reason: 'team_off' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Launch resolution (load.ts calls these; kept here so load.ts barely grows)
// ---------------------------------------------------------------------------

/**
 * Merge the `governance` section across the layers (defaults > file > env > flag).
 *
 * The environment and `--no-governance` layers can ONLY switch `enabled` off (they are kill
 * switches), and they are applied last so nothing in the file can outvote them. The flag is a
 * launch-only override: it is resolved here into the in-memory config and never reaches the
 * store, which is what "not persisted" means.
 */
export function resolveGovernanceConfig(
  layers: { file?: unknown; env?: unknown; disableForLaunch?: boolean },
): GovernanceConfig {
  return clampGovernanceConfig({
    ...DEFAULT_GOVERNANCE_CONFIG,
    ...(isPlainObject(layers.file) ? layers.file : {}),
    ...(isPlainObject(layers.env) ? layers.env : {}),
    ...(layers.disableForLaunch === true ? { enabled: false } : {}),
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface InitialPostureInput {
  /** `--govern`. */
  govern?: boolean;
  /** `--plan-govern`. Wins over `govern` if a programmatic caller passes both. */
  planGovern?: boolean;
  /** The already-resolved `--plan` / `planModeDefault` result (unchanged by governance). */
  startInPlanMode: boolean;
  governance: Pick<GovernanceConfig, 'enabled'>;
  teamEnabled: boolean;
}

export interface InitialPostureResolution {
  posture: Posture;
  /** Set when a governance posture was requested but could not be honoured. */
  degradedReason?: GovernanceConfigUnavailableReason;
}

/**
 * The posture the session starts in. Governance flags win over `--plan` / `planModeDefault`
 * (a user who asked for a governed run did not ask for a plain one); when governance is
 * unavailable at the CONFIG level the request degrades to the classic posture the same launch
 * would have had, and the reason is returned so the caller can say so instead of silently
 * dropping the flag. Without a governance flag this is exactly `startInPlanMode ? 'plan' :
 * 'build'`, so `--plan` behaviour is untouched.
 */
export function resolveInitialPosture(
  input: InitialPostureInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): InitialPostureResolution {
  const classic: Posture = input.startInPlanMode ? 'plan' : 'build';
  const requested: Posture | null = input.planGovern === true
    ? 'plan_govern'
    : input.govern === true ? 'govern' : null;
  if (requested === null) return { posture: classic };
  const availability = describeGovernanceConfigAvailability(
    { governance: input.governance, team: { enabled: input.teamEnabled } },
    env,
  );
  return availability.ok
    ? { posture: requested }
    : { posture: classic, degradedReason: availability.reason };
}
