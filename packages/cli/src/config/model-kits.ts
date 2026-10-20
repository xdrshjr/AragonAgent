/**
 * Agent model kits: a named preset that pins the THREE model roles
 * (main / fast / subagent) to profiles that already live in the library
 * (agent-model-kits D-1 / D-2).
 *
 * ASCII ONLY - `src/config/**` is inside `glyphs.test.ts::inScope`.
 *
 * A KIT STORES REFERENCES, NEVER COPIES (D-1): every slot is a profile id, so
 * editing the profile changes the meaning of every kit that names it, which is
 * exactly the promise a "preset" makes. That is also why deleting a profile has
 * to delete the kits that reference it (D-9) instead of leaving a preset nobody
 * can repair from the UI.
 *
 * EVERY CROSS-LAYER IMPORT HERE IS `import type` (RV-P2-5): `schema.ts` names
 * `model-profiles.ts` through an inline `import('./model-profiles.js')` type
 * query, so `model-profiles -> model-kits -> schema` is already a TYPE cycle. A
 * value import (`DEFAULT_FAST_CONFIG`, `clampTeamConfig`) would turn it into a
 * runtime cycle, and vitest surfaces that as an empty module at import time.
 */

import { randomUUID } from 'node:crypto';
import type { CliConfig, FastConfig, TeamConfig } from './schema.js';
import type { ModelProfile, ModelProfilesConfig, ProfileValidationIssue }
  from './model-profiles.js';
// TYPE-ONLY: `KitApplyResult.code` is defined as the save-result code set plus
// the two kit codes, so the union cannot drift from what the chain produces.
import type { ModelSettingsSaveResult } from './model-profile-store.js';

export type KitSlot = 'main' | 'fast' | 'subagent';

/**
 * The session kit's runtime shape (D-5): the kit plus the slots it still owns.
 *
 * `held` is the ONLY mutable part. It shrinks when a save explicitly decides a
 * slot (§4.3 / D-6), so "the user changed subagent, so subagent is theirs now"
 * needs no second bookkeeping structure.
 */
export interface SessionKitState {
  id: string;
  held: KitSlot[];
}

/**
 * The kit's subagent slot.
 *
 * `model` is typed with `TeamConfig['model']` rather than by importing
 * `team/model.ts`: `team/model.ts` already imports `config/`, so the reverse
 * edge would be a cycle. `import type` keeps even this one erased.
 */
export interface AgentKitSubagent {
  model: TeamConfig['model'];
  /** Non-null IF AND ONLY IF `model === 'profile'` (I-2, guaranteed by normalize). */
  modelProfileId: string | null;
}

export interface AgentKit {
  id: string;
  /** 1..48 code points, no control characters. Names MAY repeat (§6.6). */
  name: string;
  /** Required (D-8). A dangling reference is NOT a validation error - see I-8. */
  mainProfileId: string;
  /** `null` = this kit turns the fast tier OFF for its session (D-8). */
  fastProfileId: string | null;
  subagent: AgentKitSubagent;
}

export const KIT_LIMITS = {
  /**
   * Structural ceiling. The EFFECTIVE ceiling is lower and implicit: every kit
   * references at least one profile, so 200 entries cap the reachable kits
   * (RV-P2-7) - recorded, not cross-validated, because the two numbers answer
   * different questions.
   */
  maxKits: 50,
  nameMaxChars: 48,
  maxSlots: 3,
} as const;

/**
 * STRUCTURAL ONLY (RV-P1-1). Reference existence is a RESOLUTION-time concern,
 * exactly as it is for `team.modelProfileId` (`schema.ts` clampTeamConfig):
 * `createModelProfileState` blanks the whole settings page when validation
 * fails, so promoting "a hand-edited file left one dangling id" into "the page
 * and `/team model` are both dead" is a wildly disproportionate blast radius.
 *
 * `duplicate_name` is deliberately NOT a code: two kits may share a name
 * (§6.6), and `/kit use` disambiguates with an `#id` prefix.
 */
export interface KitIssue {
  path: string;
  code: 'invalid' | 'duplicate_id';
  message: string;
}

/** One resolved slot; `null` on the slot itself means the entry is gone. */
export interface KitConnection {
  provider: string;
  model: string;
  baseUrl: string | null;
  name: string;
}

export interface KitSlotConnections {
  /** `null` = the referenced entry is gone; render `Profile missing`, never throw. */
  main: KitConnection | null;
  fast: KitConnection | null;
  subagent: {
    /**
     * The SLOT MODE (`main` / `fast` / `profile`). Named `mode` rather than
     * `model` because the resolved connection below carries a model ID of its
     * own, and two `model` keys in one object literal is a TypeScript error
     * (recorded as an implementation-time fix in the spec's issues section).
     */
    mode: TeamConfig['model'];
    provider: string | null;
    model: string | null;
    baseUrl: string | null;
    name: string | null;
  };
}

/**
 * A consequence of applying a kit that the user MUST be told about (§4.2).
 *
 * Not one of these is a failure: applying a kit is allowed to turn the fast tier
 * on (which is real money - `DEFAULT_FAST_CONFIG.review` is `true`), to leave a
 * profile without a usable key, or to name a tier this kit just switched off.
 * The rule is the one every other subsystem in this package follows: no silent
 * decisions, especially about spend.
 */
export type KitNote =
  | 'fast_tier_enabled' | 'fast_review_enabled' | 'fast_tier_off' | 'restart_required'
  | 'main_key_missing' | 'subagent_key_missing' | 'subagent_fast_unavailable';

/**
 * What a session-kit action did, or why it did nothing.
 *
 * THE CODE SET IS THE SAVE SET PLUS TWO (RV-P1-3): every code the reused
 * prepare/commit chain can produce is spelled here, so `kitApplyMessage` has no
 * gap to fall through. A missing message would be rendered by a non-null
 * assertion as the literal string `undefined`.
 */
export interface KitApplyResult {
  ok: boolean;
  code?: ModelSettingsSaveResult['code'] | 'kit_missing' | 'kit_references_missing_profile';
  /** `clearSessionKit` only: the session is back on the config file. */
  released?: boolean;
  notes: KitNote[];
  /** Set when `kit_references_missing_profile` refused the apply (I-8). */
  issues?: ProfileValidationIssue[];
}

export interface KitsNormalization {
  kits: AgentKit[];
  /** Self-healed: a pointer at a kit that did not survive becomes `null`. */
  defaultKitId: string | null;
  /** Forward migration marker (D-3). Never anything but 1. */
  kitsVersion: 1;
  /** Entries thrown away because they were structurally unsalvageable. */
  dropped: number;
}

export const SUBAGENT_MODES = ['main', 'fast', 'profile'] as const;

/** The one mapping from a kit to a persisted-config patch (§4.2). */
export interface KitCandidate {
  modelProfiles: ModelProfilesConfig;
  team: Partial<TeamConfig>;
  fast: Partial<FastConfig>;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Non-empty, control-free text of at most `max` code points. */
function validText(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || CONTROL.test(value)) return false;
  const points = [...value.trim()].length;
  return points > 0 && points <= max;
}

function invalidKit(path: string, message: string): KitIssue {
  return { path, code: 'invalid', message };
}

function validateKitSubagent(value: unknown, path: string): KitIssue[] {
  if (!isRecord(value)) return [invalidKit(`${path}.subagent`, 'Subagent must be an object.')];
  const issues: KitIssue[] = [];
  if (!(SUBAGENT_MODES as readonly unknown[]).includes(value.model)) {
    issues.push(invalidKit(`${path}.subagent.model`,
      'Subagent model must be main, fast or profile.'));
  }
  const id = value.modelProfileId;
  if (id !== null && !validText(id, 128)) {
    issues.push(invalidKit(`${path}.subagent.modelProfileId`,
      'Subagent profile must be empty or 1-128 safe characters.'));
  }
  return issues;
}

function validateKit(value: unknown, index: number): KitIssue[] {
  const path = `modelProfiles.kits[${index}]`;
  if (!isRecord(value)) return [invalidKit(path, 'Kit must be an object.')];
  const issues: KitIssue[] = [];
  if (!validText(value.id, 128)) {
    issues.push(invalidKit(`${path}.id`, 'Kit ID must have 1-128 safe characters.'));
  }
  if (!validText(value.name, KIT_LIMITS.nameMaxChars)) {
    issues.push(invalidKit(`${path}.name`,
      `Kit name must have 1-${KIT_LIMITS.nameMaxChars} safe characters.`));
  }
  if (!validText(value.mainProfileId, 128)) {
    issues.push(invalidKit(`${path}.mainProfileId`, 'Choose a main profile for this kit.'));
  }
  const fast = value.fastProfileId;
  if (fast !== null && !validText(fast, 128)) {
    issues.push(invalidKit(`${path}.fastProfileId`,
      'Fast profile must be a profile or off.'));
  }
  issues.push(...validateKitSubagent(value.subagent, path));
  return issues;
}

/**
 * Validate the `kits` array STRUCTURALLY (RV-P1-1).
 *
 * Returns `[]` for `undefined`/`null`/`[]` so a library written by a pre-KIT
 * build keeps validating - the whole point of D-3's additive migration.
 */
export function validateKits(value: unknown): KitIssue[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    return [invalidKit('modelProfiles.kits', 'Kits must be an array.')];
  }
  if (value.length > KIT_LIMITS.maxKits) {
    return [invalidKit('modelProfiles.kits',
      `Use at most ${KIT_LIMITS.maxKits} kits; delete unused kits to add more.`)];
  }
  const issues = value.flatMap(validateKit);
  const ids = new Set<string>();
  value.forEach((kit: unknown, index: number) => {
    if (!isRecord(kit) || typeof kit.id !== 'string') return;
    if (ids.has(kit.id)) {
      issues.push({ path: `modelProfiles.kits[${index}].id`, code: 'duplicate_id',
        message: 'Kit IDs must be unique.' });
    }
    ids.add(kit.id);
  });
  return issues;
}

function normalizeSubagent(value: unknown): AgentKitSubagent {
  const source = isRecord(value) ? value : {};
  const model = (SUBAGENT_MODES as readonly unknown[]).includes(source.model)
    ? source.model as TeamConfig['model'] : 'main';
  // I-2: the id exists exactly when the mode names a profile. A hand-edited
  // `{model:'fast', modelProfileId:'x'}` therefore heals instead of lingering
  // as a reference nothing reads.
  const id = model === 'profile' && validText(source.modelProfileId, 128)
    ? (source.modelProfileId as string).trim() : null;
  return { model, modelProfileId: id };
}

/** One entry into a safe `AgentKit`, or `null` when it cannot be salvaged. */
function normalizeKit(value: unknown): AgentKit | null {
  if (!isRecord(value)) return null;
  if (!validText(value.id, 128) || !validText(value.name, KIT_LIMITS.nameMaxChars)
    || !validText(value.mainProfileId, 128)) return null;
  const fast = value.fastProfileId;
  if (fast !== null && fast !== undefined && !validText(fast, 128)) return null;
  return {
    id: (value.id as string).trim(),
    name: (value.name as string).trim(),
    mainProfileId: (value.mainProfileId as string).trim(),
    fastProfileId: validText(fast, 128) ? (fast as string).trim() : null,
    subagent: normalizeSubagent(value.subagent),
  };
}

/**
 * White-list normalization of `kits` + `defaultKitId` (F-3 / R-2).
 *
 * TOTAL: no input throws. `normalizeModelProfiles` calls this on whatever the
 * file holds, and a throw there would take the whole library - including the
 * user's credentials - down with one malformed kit.
 *
 * `defaultKitRef` is a SEPARATE argument because `defaultKitId` is a sibling of
 * `kits` in the library, not a member of the array; keeping it here is what
 * lets the pointer self-heal against the kits that actually survived.
 */
export function normalizeKits(kitsValue: unknown, defaultKitRef?: unknown): KitsNormalization {
  const kits: AgentKit[] = [];
  let dropped = 0;
  if (Array.isArray(kitsValue)) {
    const seen = new Set<string>();
    for (const raw of kitsValue.slice(0, KIT_LIMITS.maxKits)) {
      const kit = normalizeKit(raw);
      if (!kit || seen.has(kit.id)) { dropped += 1; continue; }
      seen.add(kit.id);
      kits.push(kit);
    }
    dropped += Math.max(0, kitsValue.length - KIT_LIMITS.maxKits);
  } else if (kitsValue !== undefined && kitsValue !== null) dropped += 1;
  const defaultKitId = typeof defaultKitRef === 'string'
    && kits.some((kit) => kit.id === defaultKitRef) ? defaultKitRef : null;
  return { kits, defaultKitId, kitsVersion: 1, dropped };
}

/** Create a kit with a stable UUID, normalized like `createModelProfile`. */
export function createAgentKit(input: Omit<AgentKit, 'id'>): AgentKit {
  const draft = { ...input, id: randomUUID() };
  return normalizeKit(draft) ?? { ...draft, subagent: normalizeSubagent(draft.subagent) };
}

/** Copy a kit under a free ` (copy)` name - the manager's `Duplicate` action. */
export function duplicateAgentKit(kit: AgentKit, existing: readonly AgentKit[]): AgentKit {
  const taken = new Set(existing.map((other) => other.name));
  const suffix = [...kit.name].slice(0, KIT_LIMITS.nameMaxChars - 8).join('').trimEnd();
  let name = `${suffix} (copy)`;
  for (let copy = 2; taken.has(name); copy += 1) name = `${suffix} (copy ${copy})`;
  return { ...kit, id: randomUUID(), name: [...name].slice(0, KIT_LIMITS.nameMaxChars).join('') };
}

/**
 * Every kit a reference text may mean.
 *
 * ONE parser for `ctrl+K`, `/kit use` and the settings manager, so "what did I
 * just type" has a single answer. `ref` is an exact id, an `#id` prefix, or an
 * exact name; an ambiguous reference returns more than one hit and the caller
 * reports it rather than silently taking the first (§4.9).
 */
export function kitMatches(
  library: ModelProfilesConfig | undefined, ref: string | null | undefined,
): AgentKit[] {
  if (!library || !ref) return [];
  const kits = library.kits ?? [];
  const text = ref.trim();
  if (!text) return [];
  const exact = kits.find((kit) => kit.id === text);
  if (exact) return [exact];
  if (text.startsWith('#')) {
    const prefix = text.slice(1).trim().toLowerCase();
    return prefix ? kits.filter((kit) => kit.id.toLowerCase().startsWith(prefix)) : [];
  }
  return kits.filter((kit) => kit.name === text);
}

/** Resolve one kit, or `undefined` when the reference is missing or ambiguous. */
export function findKit(
  library: ModelProfilesConfig | undefined, ref: string | null | undefined,
): AgentKit | undefined {
  const hits = kitMatches(library, ref);
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * THE ONE mapping from a kit to a persisted-config patch (§4.2).
 *
 * Both consumption paths - "set as default" (writes the result) and `ctrl+K`
 * (never writes it) - call this, so a default kit and a session kit produce
 * structurally identical configurations. There is no second interpretation.
 *
 * `defaultKitId` is only touched when the caller PASSES it (it is
 * `undefined` for a session kit), which is what keeps `ctrl+K` from moving the
 * persisted pointer.
 */
export function kitCandidate(input: {
  library: ModelProfilesConfig;
  kit: AgentKit;
  defaultKitId?: string | null;
}): KitCandidate {
  const { library, kit } = input;
  const profileId = kit.subagent.model === 'profile' ? kit.subagent.modelProfileId : null;
  return {
    modelProfiles: {
      ...library,
      mainId: kit.mainProfileId,
      fastId: kit.fastProfileId,
      ...(input.defaultKitId !== undefined ? { defaultKitId: input.defaultKitId } : {}),
    },
    team: { model: kit.subagent.model, modelProfileId: profileId },
    // D-8: `fastProfileId: null` means OFF, not "leave it alone".
    fast: { enabled: kit.fastProfileId !== null },
  };
}

function connectionOf(entry: ModelProfile | undefined): KitConnection | null {
  if (!entry) return null;
  return { provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl,
    name: entry.name };
}

/**
 * Dereference the three slots for every surface that prints them (picker,
 * management page, `/kit list`).
 *
 * A MISSING ENTRY RETURNS `null` INSTEAD OF THROWING (RV-P1-1 / I-8): the UI
 * renders `Profile missing`, the library stays readable, and only APPLYING the
 * kit is refused, with a stable code.
 */
export function kitSlotConnections(
  library: ModelProfilesConfig | undefined, kit: AgentKit,
): KitSlotConnections {
  const entries = library?.entries ?? [];
  const find = (id: string | null): ModelProfile | undefined =>
    id ? entries.find((entry) => entry.id === id) : undefined;
  const main = find(kit.mainProfileId);
  const fast = find(kit.fastProfileId);
  const subProfile = kit.subagent.model === 'profile'
    ? find(kit.subagent.modelProfileId) : undefined;
  const target = kit.subagent.model === 'main' ? main
    : kit.subagent.model === 'fast' ? fast : subProfile;
  return {
    main: connectionOf(main),
    fast: connectionOf(fast),
    subagent: {
      mode: kit.subagent.model,
      provider: target?.provider ?? null,
      model: target?.model ?? null,
      baseUrl: target?.baseUrl ?? null,
      name: target?.name ?? null,
    },
  };
}

/**
 * Pre-fill the first kit from what this machine already runs (§4.10 / D-13).
 *
 * `mainProfileId` comes from the caller because CREATING a profile is UI work:
 * `createCustomProfile` lives in `ui/overlays/model-profile-state.ts`, and a
 * `config/` module importing `ui/` would invert the dependency direction this
 * package keeps everywhere else. The caller creates (or reuses) the entry and
 * hands its id in; when it is absent the kit is still built, because a
 * half-filled editor is a better first form than an empty one.
 */
export function createKitFromCurrent(input: {
  config: CliConfig;
  mainProfileId?: string | null;
  name?: string;
}): AgentKit {
  const { config } = input;
  const library = config.modelProfiles;
  const fastId = config.fast?.enabled === true ? library?.fastId ?? null : null;
  // THE SUBAGENT PROFILE IS CARRIED, NOT BLANKED (I-2): a machine whose subagent
  // already runs a specific profile would otherwise be prefilled with mode
  // `profile` and no id, which `resolveSubagentModel` can only degrade to main -
  // the prefill would silently change the answer it exists to record.
  const subagentModel = config.team?.model ?? 'main';
  const subagentProfileId = subagentModel === 'profile'
    ? config.team?.modelProfileId ?? null : null;
  return createAgentKit({
    name: input.name ?? 'My setup',
    mainProfileId: input.mainProfileId ?? library?.mainId ?? '',
    fastProfileId: fastId,
    subagent: { model: subagentModel, modelProfileId: subagentProfileId },
  });
}
