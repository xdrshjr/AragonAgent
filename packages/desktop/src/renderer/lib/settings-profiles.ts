/**
 * Model-profile editing as pure functions over the engine's own `model-profiles` helpers
 * (ids, validation and normalisation are never hand-rolled here).
 *
 * THE KEY PROBLEM: the renderer only ever sees MASKED profiles, yet `config:patch` replaces
 * `modelProfiles` as one whole section and the engine rejects an entry without its `apiKey`.
 * So a save must carry the stored keys of the entries it did not touch. `loadFullLibrary`
 * fetches them through the audited, one-off `config:reveal-key` channel and fails CLOSED:
 * if any present key cannot be read, nothing is saved (sending `null` would erase it).
 * The keys live only in a local variable for the duration of one save.
 */

import {
  createModelProfile, duplicateModelProfile, emptyModelProfiles, isValidEndpointUrl,
  kitNamesForProfile, normalizeModelProfiles, removeModelProfile, validateModelProfiles,
  type ModelProfile, type ModelProfilesConfig, type ModelRole,
} from '@aragon-agent/tui/model/config/model-profiles';
import {
  createAgentKit, duplicateAgentKit, KIT_LIMITS, validateKits,
} from '@aragon-agent/tui/model/config/model-kits';
import { parseContextWindowInput } from '@aragon-agent/tui/model/config/schema';
import { ipc } from '../api.js';
import type { ConfigViewDto } from '../../shared/config-view.js';

export type ProfileField = 'name' | 'provider' | 'model' | 'baseUrl' | 'apiKey' | 'contextWindow';
export type ProfileFieldError = 'required' | 'invalid';

export interface ProfileForm {
  name: string;
  provider: string;
  model: string;
  baseUrl: string;
  /** Empty means "keep the stored key" when editing, "no key" when adding. */
  apiKey: string;
  /** `auto` or a number. */
  contextWindow: string;
}

export type FormErrors = Partial<Record<ProfileField | 'general', ProfileFieldError>>;

export type ApplyResult =
  | { ok: true; library: ModelProfilesConfig; id: string }
  | { ok: false; errors: FormErrors };

export type LibraryLoad =
  | { ok: true; library: ModelProfilesConfig }
  | { ok: false; reason: 'key_unavailable'; profile: string };

export function emptyProfileForm(provider = 'anthropic'): ProfileForm {
  return { name: '', provider, model: '', baseUrl: '', apiKey: '', contextWindow: 'auto' };
}

type ProfileLike = Pick<ModelProfile, 'name' | 'provider' | 'model' | 'baseUrl' | 'contextWindow'>;

export function formFromProfile(entry: ProfileLike): ProfileForm {
  return {
    name: entry.name,
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl ?? '',
    apiKey: '',
    contextWindow: entry.contextWindow === null ? 'auto' : String(entry.contextWindow),
  };
}

/** Field-level checks, so each message lands on the field that owns it. */
export function checkProfileForm(form: ProfileForm): FormErrors {
  const errors: FormErrors = {};
  if (form.model.trim() === '') errors.model = 'required';
  if (form.provider.trim() === '') errors.provider = 'required';
  if (form.baseUrl.trim() !== '' && !isValidEndpointUrl(form.baseUrl)) errors.baseUrl = 'invalid';
  if (parseContextWindowInput(form.contextWindow).kind === 'invalid') errors.contextWindow = 'invalid';
  return errors;
}

function parseWindow(raw: string): number | null {
  const parsed = parseContextWindowInput(raw);
  return parsed.kind === 'value' ? parsed.value : null;
}

/** Add (`id === null`) or replace one profile and return the validated, normalised library. */
export function applyProfile(
  library: ModelProfilesConfig,
  id: string | null,
  form: ProfileForm,
): ApplyResult {
  const errors = checkProfileForm(form);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const typedKey = form.apiKey.trim();
  const stored = id === null ? undefined : library.entries.find((entry) => entry.id === id);
  if (id !== null && !stored) return { ok: false, errors: { general: 'invalid' } };
  try {
    const fields = {
      name: form.name.trim(), provider: form.provider.trim(), model: form.model.trim(),
      baseUrl: form.baseUrl.trim() || null, contextWindow: parseWindow(form.contextWindow),
    };
    const entry = stored
      ? { ...stored, ...fields, apiKey: typedKey || stored.apiKey }
      : createModelProfile({ ...fields, apiKey: typedKey || null });
    const entries = stored
      ? library.entries.map((candidate) => (candidate.id === stored.id ? entry : candidate))
      : [...library.entries, entry];
    return { ok: true, library: normalizeModelProfiles({ ...library, entries }), id: entry.id };
  } catch {
    return { ok: false, errors: { general: 'invalid' } };
  }
}

export function copyProfile(library: ModelProfilesConfig, id: string): ModelProfilesConfig | null {
  const source = library.entries.find((entry) => entry.id === id);
  if (!source) return null;
  try {
    return normalizeModelProfiles({ ...library, entries: [...library.entries, duplicateModelProfile(source)] });
  } catch {
    return null;
  }
}

export type RemoveResult =
  | { ok: true; library: ModelProfilesConfig }
  | { ok: false; reason: 'bound' | 'kits'; kits: string[] };

export function deleteProfile(library: ModelProfilesConfig, id: string): RemoveResult {
  if (library.mainId === id || library.fastId === id) return { ok: false, reason: 'bound', kits: [] };
  const kits = kitNamesForProfile(library, id);
  if (kits.length > 0) return { ok: false, reason: 'kits', kits };
  return { ok: true, library: removeModelProfile(library, id) };
}

export function bindRole(library: ModelProfilesConfig, role: ModelRole, id: string | null): ModelProfilesConfig {
  return { ...library, [role === 'main' ? 'mainId' : 'fastId']: id };
}

/** True when the library the engine would receive is acceptable to the engine. */
export function isLibraryValid(library: ModelProfilesConfig): boolean {
  return validateModelProfiles(library).length === 0;
}

/**
 * The stored library WITH its keys, rebuilt from the masked view. Fails closed when a key that
 * exists on disk cannot be read back.
 */
export async function loadFullLibrary(view: ConfigViewDto | null): Promise<LibraryLoad> {
  const masked = view?.modelProfiles;
  if (!masked) return { ok: true, library: emptyModelProfiles() };
  const entries: ModelProfile[] = [];
  for (const { key, ...entry } of masked.entries) {
    if (!key.present) {
      entries.push({ ...entry, apiKey: null });
      continue;
    }
    const revealed = await ipc('config:reveal-key', { provider: entry.provider, profileId: entry.id });
    if (!revealed.ok || !revealed.value.key) return { ok: false, reason: 'key_unavailable', profile: entry.name };
    entries.push({ ...entry, apiKey: revealed.value.key });
  }
  return { ok: true, library: { ...masked, entries } };
}

export interface KitDraft {
  name: string;
  mainProfileId: string;
  /** Empty means "no fast model in this kit". */
  fastProfileId: string;
}

export type KitResult = { ok: true; library: ModelProfilesConfig } | { ok: false; reason: 'name' | 'main' | 'invalid' | 'limit' };

export function addKit(library: ModelProfilesConfig, draft: KitDraft): KitResult {
  const name = draft.name.trim();
  const kits = library.kits ?? [];
  if (name === '' || [...name].length > KIT_LIMITS.nameMaxChars) return { ok: false, reason: 'name' };
  if (!library.entries.some((entry) => entry.id === draft.mainProfileId)) return { ok: false, reason: 'main' };
  if (kits.length >= KIT_LIMITS.maxKits) return { ok: false, reason: 'limit' };
  const kit = createAgentKit({
    name,
    mainProfileId: draft.mainProfileId,
    fastProfileId: draft.fastProfileId === '' ? null : draft.fastProfileId,
    subagent: { model: 'main', modelProfileId: null },
  });
  const next = { ...library, kits: [...kits, kit] };
  return validateKits(next.kits).length === 0 ? { ok: true, library: next } : { ok: false, reason: 'invalid' };
}

export function copyKit(library: ModelProfilesConfig, id: string): ModelProfilesConfig | null {
  const kits = library.kits ?? [];
  const source = kits.find((kit) => kit.id === id);
  return source ? { ...library, kits: [...kits, duplicateAgentKit(source, kits)] } : null;
}

export function removeKit(library: ModelProfilesConfig, id: string): ModelProfilesConfig {
  return {
    ...library,
    kits: (library.kits ?? []).filter((kit) => kit.id !== id),
    defaultKitId: library.defaultKitId === id ? null : library.defaultKitId ?? null,
  };
}

/** The masked library shaped like a real one, with every key blanked: for CHECKS only, never saved. */
export function maskedLibrary(view: ConfigViewDto | null): ModelProfilesConfig {
  const masked = view?.modelProfiles;
  if (!masked) return emptyModelProfiles();
  return { ...masked, entries: masked.entries.map(({ key: _key, ...entry }) => ({ ...entry, apiKey: null })) };
}
