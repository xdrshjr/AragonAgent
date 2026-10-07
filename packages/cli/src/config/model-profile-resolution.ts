import { DEFAULT_CONFIG, type CliConfig, type PersistedConfig } from './schema.js';
import { emptyModelProfileState, normalizeModelProfiles, validateModelProfiles,
  type ModelProfilesConfig, type ModelProfilesRuntime, type ModelRole,
  type ProfileValidationIssue } from './model-profiles.js';

export interface ProfileProjection {
  file: Partial<PersistedConfig>;
  state: ModelProfilesRuntime;
  issues: ProfileValidationIssue[];
}
export interface RoleKeyInput { config: CliConfig; role: ModelRole; providerId: string }

/** Compare configured endpoint spelling strictly, with null and undefined equivalent. */
export function normalizeProfileBaseUrl(value: string | null | undefined): string | null {
  return value?.trim() || null;
}
/** Project a valid library onto a copy without rewriting legacy preferences. */
export function projectModelProfiles(file: Partial<PersistedConfig>): ProfileProjection {
  const issues = validateModelProfiles(file.modelProfiles);
  const state = emptyModelProfileState(issues.length > 0);
  const projected = { ...file };
  if (issues.length || !file.modelProfiles) return { file: projected, state, issues };
  const library = normalizeModelProfiles(file.modelProfiles);
  projected.modelProfiles = library;
  for (const role of ['main', 'fast'] as const) {
    const entry = library.entries.find((profile) => profile.id === library[`${role}Id`]);
    if (!entry) continue;
    state[role] = { selectedId: entry.id, appliedId: entry.id,
      overriddenFields: [], invalid: false };
    const connection = { provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl };
    if (role === 'main') Object.assign(projected, connection);
    else projected.fast = { ...DEFAULT_CONFIG.fast, ...file.fast, ...connection,
      baseUrl: entry.baseUrl ?? '' };
  }
  return { file: projected, state, issues };
}
/** Derive binding status from current connections, including session/model overrides. */
export function resolveModelProfileState(
  config: CliConfig, profiles = config.modelProfiles, invalid = false,
): ModelProfilesRuntime {
  const issues = validateModelProfiles(profiles);
  const state = emptyModelProfileState(invalid || issues.length > 0);
  if (issues.length || !profiles) return state;
  for (const role of ['main', 'fast'] as const) {
    const entry = profiles.entries.find((profile) => profile.id === profiles[`${role}Id`]);
    if (!entry) continue;
    const connection = role === 'main' ? config : config.fast;
    const changed = (['provider', 'model', 'baseUrl'] as const).filter((field) =>
      field === 'baseUrl'
        ? normalizeProfileBaseUrl(connection[field]) !== normalizeProfileBaseUrl(entry[field])
        : connection[field] !== entry[field]);
    state[role] = { selectedId: entry.id,
      appliedId: changed.some((field) => field !== 'model') ? null : entry.id,
      overriddenFields: changed, invalid: false };
  }
  return state;
}
/** Resolve only credentials scoped to the requested role and actual connection target. */
export function resolveModelRoleKey(input: RoleKeyInput): string | undefined {
  const { config, role, providerId } = input;
  const shared = config.apiKeys[providerId] || undefined;
  const profiles = validateModelProfiles(config.modelProfiles).length
    ? undefined : config.modelProfiles;
  const profileMode = profiles && (profiles.mainId !== null || profiles.fastId !== null);
  if (!profileMode) {
    const target = config.apiKeyOverrideTarget;
    if (target) {
      return role === 'main' && providerId === config.provider
        && target.provider === config.provider
        && normalizeProfileBaseUrl(target.baseUrl) === normalizeProfileBaseUrl(config.baseUrl)
        ? config.apiKeyOverride || shared : shared;
    }
    return config.apiKeyOverride && providerId === config.provider
      ? config.apiKeyOverride : shared;
  }
  const actualProvider = role === 'main'
    ? config.provider : config.fast.provider || config.provider;
  if (providerId !== actualProvider) return shared;
  const target = config.apiKeyOverrideTarget;
  if (role === 'main' && config.apiKeyOverride && target?.provider === config.provider
    && normalizeProfileBaseUrl(target.baseUrl) === normalizeProfileBaseUrl(config.baseUrl)) {
    return config.apiKeyOverride;
  }
  const state = resolveModelProfileState(config)[role];
  const entry = profiles.entries.find((profile) => profile.id === state.appliedId);
  return entry?.apiKey || shared;
}
