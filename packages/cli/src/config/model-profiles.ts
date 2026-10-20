import { randomUUID } from 'node:crypto';
import { ADAPTER_PROVIDERS, clampContextWindow, isAutoToken } from './schema.js';
import { normalizeKits, validateKits, type AgentKit } from './model-kits.js';

export type ModelRole = 'main' | 'fast';
export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  /** The context window of this model+endpoint; null = AUTO (profile-context-window 5.1). */
  contextWindow: number | null;
}
export interface ModelProfilesConfig {
  version: 1;
  entries: ModelProfile[];
  mainId: string | null;
  fastId: string | null;
  /**
   * Agent model kits (agent-model-kits D-2). OPTIONAL because a file written by
   * a pre-KIT build simply has no such key; `emptyModelProfiles` still fills it
   * in, so every library this build CREATES is explicit.
   */
  kits?: AgentKit[];
  /** The `Set default` pointer (D-13); a dangling value normalizes to null. */
  defaultKitId?: string | null;
  /** Forward migration marker (D-3). Always 1; never a functional decision. */
  kitsVersion?: 1;
}
export interface ProfileBindingState {
  selectedId: string | null;
  appliedId: string | null;
  overriddenFields: Array<'provider' | 'model' | 'baseUrl'>;
  invalid: boolean;
}
export interface ModelProfilesRuntime {
  main: ProfileBindingState;
  fast: ProfileBindingState;
}
export interface ProfileValidationIssue {
  path: string;
  code: 'invalid' | 'duplicate_id' | 'missing_reference' | 'unsupported_version';
  message: string;
}
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Return a fresh empty library without initiating a disk migration. */
export function emptyModelProfiles(): ModelProfilesConfig {
  return { version: 1, entries: [], mainId: null, fastId: null, kits: [],
    defaultKitId: null, kitsVersion: 1 };
}
/** Return independently mutable role state. */
export function emptyModelProfileState(invalid = false): ModelProfilesRuntime {
  const binding = (): ProfileBindingState => ({ selectedId: null, appliedId: null,
    overriddenFields: [], invalid });
  return { main: binding(), fast: binding() };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validText(value: unknown, max: number, allowEmpty = false): value is string {
  return typeof value === 'string' && !CONTROL.test(value)
    && (allowEmpty || value.trim().length > 0) && [...value.trim()].length <= max;
}
function validUrl(value: unknown): boolean {
  if (value === null || (typeof value === 'string' && !value.trim())) return true;
  if (typeof value !== 'string' || CONTROL.test(value)) return false;
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
      && !url.username && !url.password && !value.includes('?') && !value.includes('#');
  } catch { return false; }
}
/**
 * The endpoint rule published as a predicate (model-profile-connection-test §5 row 10).
 *
 * The probe's `invalid_base_url` guard has to use THE SAME ruler as validation, or a
 * URL the editor accepts can still be refused by the test (and the reverse). A second
 * copy of these four clauses is one edit away from disagreeing with the config layer.
 */
export function isValidEndpointUrl(value: string | null | undefined): boolean {
  return validUrl(value);
}
function validateEntry(value: unknown, index: number): ProfileValidationIssue[] {
  const path = `modelProfiles.entries[${index}]`;
  const invalid = (field: string, message: string): ProfileValidationIssue => ({
    path: field ? `${path}.${field}` : path, code: 'invalid', message,
  });
  if (!isRecord(value)) return [invalid('', 'Profile must be an object.')];
  const issues: ProfileValidationIssue[] = [];
  if (!validText(value.id, 128)) issues.push(invalid('id', 'ID must have 1-128 safe characters.'));
  if (!validText(value.name, 80, true)) {
    issues.push(invalid('name', 'Name must have at most 80 safe characters.'));
  }
  if (!(ADAPTER_PROVIDERS as readonly unknown[]).includes(value.provider)) {
    issues.push(invalid('provider', 'Select a supported provider.'));
  }
  if (!validText(value.model, 256)) {
    issues.push(invalid('model', 'Model must have 1-256 safe characters.'));
  }
  if (!validUrl(value.baseUrl)) {
    issues.push(invalid('baseUrl', 'Use an HTTP(S) URL without credentials, query or fragment.'));
  }
  if (value.apiKey !== null && !validText(value.apiKey, 8192)) {
    issues.push(invalid('apiKey', 'Enter a nonempty key up to 8192 safe characters.'));
  }
  return issues;
}
/**
 * Validate untrusted input; diagnostics never include supplied values.
 *
 * THE KIT SECTION IS STRUCTURAL ONLY (agent-model-kits RV-P1-1). `mainId` /
 * `fastId` above are `missing_reference` because a dangling ROLE BINDING leaves
 * the whole library unreadable (there is no "nothing bound" recovery path once
 * a bound id is gone), while a dangling KIT SLOT degrades at resolution time
 * into `Profile missing` and a refused apply - the same discipline
 * `team.modelProfileId` already follows (`schema.ts` clampTeamConfig).
 */
export function validateModelProfiles(value: unknown): ProfileValidationIssue[] {
  if (value === undefined) return [];
  if (!isRecord(value)) return [{ path: 'modelProfiles', code: 'invalid',
    message: 'Model profiles must be an object. Repair with aragon config edit.' }];
  if (value.version !== 1) return [{ path: 'modelProfiles.version',
    code: 'unsupported_version', message: 'Unsupported model profiles version.' }];
  if (!Array.isArray(value.entries) || value.entries.length > 200) {
    return [{ path: 'modelProfiles.entries', code: 'invalid',
      message: 'Use an array with at most 200 profiles; remove unused profiles to add more.' }];
  }
  const issues = value.entries.flatMap(validateEntry);
  const ids = new Set<string>();
  value.entries.forEach((entry: unknown, index: number) => {
    if (!isRecord(entry) || typeof entry.id !== 'string') return;
    if (ids.has(entry.id)) issues.push({ path: `modelProfiles.entries[${index}].id`,
      code: 'duplicate_id', message: 'Profile IDs must be unique.' });
    ids.add(entry.id);
  });
  for (const field of ['mainId', 'fastId'] as const) {
    if (value[field] !== null && (typeof value[field] !== 'string' || !ids.has(value[field]))) {
      issues.push({ path: `modelProfiles.${field}`, code: 'missing_reference',
        message: 'Select an existing profile or Current custom.' });
    }
  }
  issues.push(...validateKits(value.kits));
  return issues;
}
/**
 * Disk-tolerance gate for a profile-level context window (profile-context-window 5.3).
 *
 * THE SAME TRI-STATE DISCIPLINE as store.ts normalizeContextWindow, kept out of
 * store.ts on purpose: this file already imports schema.js and store's sibling
 * model-profile-store.ts already imports this one, so placing it here avoids
 * widening the existing store <-> model-profile-store cycle. A garbage value on
 * a hand-edited file degrades to AUTO; it NEVER invalidates the whole library
 * (invariant 4 - one bad number must not drop the user's credentials).
 */
export function normalizeProfileContextWindow(value: unknown): number | null {
  if (value === undefined || value === null || isAutoToken(value)) return null;
  return clampContextWindow(value, null);
}
/**
 * Normalize a valid library into a safe field whitelist; throws a fixed error if invalid.
 *
 * THE THREE KIT KEYS ARE LISTED EXPLICITLY, NEVER `...spread` (R-2): this
 * literal IS the whitelist (F-3), so a key missing from it disappears at the
 * next write - a save that only touched `thinking` would silently delete every
 * kit the user owns. `normalizeKits` is TOTAL, so a hand-edited kit degrades
 * instead of taking the library (and the credentials in it) with it.
 */
export function normalizeModelProfiles(value: unknown): ModelProfilesConfig {
  if (validateModelProfiles(value).length) throw new Error('Invalid model profiles.');
  if (value === undefined) return emptyModelProfiles();
  const library = value as ModelProfilesConfig;
  const { kits, defaultKitId, kitsVersion } = normalizeKits(library.kits, library.defaultKitId);
  return { version: 1, mainId: library.mainId, fastId: library.fastId,
    entries: library.entries.map((entry) => ({ id: entry.id, name: entry.name.trim()
      || [...entry.model.trim()].slice(0, 80).join(''), provider: entry.provider,
    model: entry.model.trim(), baseUrl: entry.baseUrl?.trim() || null,
    apiKey: entry.apiKey?.trim() || null,
    contextWindow: normalizeProfileContextWindow(
      (entry as Partial<ModelProfile>).contextWindow) })),
    kits, defaultKitId, kitsVersion };
}
/** Create an entry with a stable UUID and a frozen default name. */
export function createModelProfile(input: Omit<ModelProfile, 'id'>): ModelProfile {
  const entry = { ...input, id: randomUUID() };
  return normalizeModelProfiles({ ...emptyModelProfiles(), entries: [entry] }).entries[0]!;
}
/** Duplicate the current draft entry, including its explicitly edited credential. */
export function duplicateModelProfile(entry: ModelProfile): ModelProfile {
  return { ...entry, id: randomUUID(), name: `${[...entry.name].slice(0, 73).join('')} (copy)` };
}
/** Ids of the kits whose three slots name `id`, for the reference message. */
export function kitNamesForProfile(library: ModelProfilesConfig, id: string): string[] {
  return (library.kits ?? []).filter((kit) => kit.mainProfileId === id
    || kit.fastProfileId === id
    || (kit.subagent.model === 'profile' && kit.subagent.modelProfileId === id))
    .map((kit) => kit.name);
}
/**
 * Remove an unused entry; binding references must be changed explicitly first.
 *
 * The message NAMES the kits that would be orphaned (D-9): a throw that only
 * says "still in use" sends the user hunting through three separate screens for
 * the reference it means, and the kits are the reference nobody thinks of.
 * (The UI never reaches this throw - it unbinds, and deletes the kits, inside
 * the draft first - so this is the library-level backstop, F-25.)
 */
export function removeModelProfile(library: ModelProfilesConfig, id: string): ModelProfilesConfig {
  if (library.mainId === id || library.fastId === id) throw new Error('Profile is still in use.');
  const kits = kitNamesForProfile(library, id);
  if (kits.length) {
    throw new Error(`Profile is used by kit ${kits.map((name) => `"${name}"`).join(', ')}.`);
  }
  return { ...library, entries: library.entries.filter((entry) => entry.id !== id) };
}
