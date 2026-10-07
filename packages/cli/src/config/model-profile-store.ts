import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getConfigPath } from './app-paths.js';
import { normalizePersistedConfig, writeConfigFile } from './store.js';
import { registerProfileSecrets } from '../logging/secret-registry.js';
import { normalizeModelProfiles, validateModelProfiles, type ModelProfilesConfig,
  type ModelRole, type ProfileValidationIssue } from './model-profiles.js';
import { normalizeProfileBaseUrl, projectModelProfiles } from './model-profile-resolution.js';
import type { CliConfig, CompactionConfig, FastConfig, LogConfig, PersistedConfig }
  from './schema.js';

export interface ModelSettingsPatch extends Partial<
  Omit<PersistedConfig, 'modelProfiles' | 'fast' | 'compaction' | 'log'>
> {
  fast?: Partial<FastConfig>;
  compaction?: Partial<CompactionConfig>;
  log?: Partial<LogConfig>;
}
export interface ModelSettingsDraft {
  profiles?: ModelProfilesConfig;
  patch: ModelSettingsPatch;
  activateRoles: ModelRole[];
  diskRevision: string;
  liveRevision: number;
  baseline: PersistedConfig;
  liveBaseline: CliConfig;
  readError?: string;
}
export interface ModelSettingsSaveResult {
  ok: boolean;
  persisted: boolean;
  status: 'applied' | 'restart_required' | 'rejected' | 'saved_apply_failed';
  code?: 'invalid' | 'busy' | 'conflict' | 'read_failed' | 'write_failed'
    | 'profile_key_required' | 'legacy_conversion_unsupported' | 'apply_failed';
  issues?: ProfileValidationIssue[];
  restartRequired?: boolean;
}
export type ConfigReadError = 'invalid_json' | 'invalid_root' | 'read_failed';
export interface ModelSettingsDisk {
  ok: boolean;
  config: PersistedConfig;
  parsed: Partial<PersistedConfig> | null;
  raw: Buffer | null;
  revision: string;
  error?: ConfigReadError;
}
/** A stable, safe error for adapters; never includes caught exception messages. */
export class ModelProfileConfigError extends Error {
  constructor(readonly code: NonNullable<ModelSettingsSaveResult['code']>) {
    super(code === 'profile_key_required' || code === 'legacy_conversion_unsupported'
      ? `${code}: Use /settings to edit or copy this profile.`
      : `${code}: Check the configuration with aragon config edit.`);
    this.name = 'ModelProfileConfigError';
  }
}
/** Read and hash exactly the same bytes; a missing file has its own revision sentinel. */
export function readModelSettingsDisk(): ModelSettingsDisk {
  let raw: Buffer;
  try { raw = readFileSync(getConfigPath()); }
  catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { ok: missing, config: normalizePersistedConfig({}), parsed: null, raw: null,
      revision: missing ? 'missing' : 'unreadable',
      ...(missing ? {} : { error: 'read_failed' as const }) };
  }
  const revision = createHash('sha256').update(raw).digest('hex');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch { return failedRead(raw, revision, 'invalid_json'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failedRead(raw, revision, 'invalid_root');
  }
  registerProfileSecrets(parsed);
  return { ok: true, raw, revision, parsed: parsed as Partial<PersistedConfig>,
    config: normalizePersistedConfig(parsed as Partial<PersistedConfig>) };
}
function failedRead(raw: Buffer, revision: string, error: ConfigReadError): ModelSettingsDisk {
  return { ok: false, raw, revision, error, config: normalizePersistedConfig({}), parsed: null };
}
export interface ModelSettingsCommitInput { candidate: PersistedConfig; diskRevision: string }
export interface ModelSettingsStoreDependencies {
  read: () => ModelSettingsDisk;
  write: (candidate: PersistedConfig) => void;
}
/** Optimistically commit a prepared candidate using one atomic write; never applies live state. */
export function commitModelSettings(
  input: ModelSettingsCommitInput,
  dependencies: ModelSettingsStoreDependencies = {
    read: readModelSettingsDisk, write: writeConfigFile,
  },
): ModelSettingsSaveResult {
  const current = dependencies.read();
  if (!current.ok) return rejected('read_failed');
  if (current.revision !== input.diskRevision) return rejected('conflict');
  if (validateModelProfiles(current.config.modelProfiles).length) return rejected('invalid');
  registerProfileSecrets(input.candidate);
  const issues = validateModelProfiles(input.candidate.modelProfiles);
  if (issues.length) return { ...rejected('invalid'), issues };
  try { dependencies.write(input.candidate); }
  catch { return rejected('write_failed'); }
  return { ok: true, persisted: true, status: 'applied' };
}
function rejected(code: ModelSettingsSaveResult['code']): ModelSettingsSaveResult {
  return { ok: false, persisted: false, status: 'rejected', code };
}
export interface LegacyPatchInput {
  current: PersistedConfig;
  patch: ModelSettingsPatch & { modelProfiles?: ModelProfilesConfig };
}
function touchesConnection(patch: object | undefined): boolean {
  return Boolean(patch && ['provider', 'model', 'baseUrl'].some((key) =>
    Object.prototype.hasOwnProperty.call(patch, key)));
}
/** Adapt legacy edits without mutating a shared profile or moving its dedicated key. */
export function adaptLegacyConnectionPatch(input: LegacyPatchInput): LegacyPatchInput['patch'] {
  const { current, patch } = input;
  if (Object.prototype.hasOwnProperty.call(patch, 'modelProfiles')) {
    if (validateModelProfiles(current.modelProfiles).length
      || validateModelProfiles(patch.modelProfiles).length) {
      throw new ModelProfileConfigError('invalid');
    }
    let result = patch;
    for (const role of ['main', 'fast'] as const) {
      if (!patch.modelProfiles?.[`${role}Id`]) {
        result = adaptUnboundProviders(current, result, role);
      }
    }
    return result;
  }
  const roles = (['main', 'fast'] as const).filter((role) =>
    touchesConnection(role === 'main' ? patch : patch.fast));
  if (!roles.length) return patch;
  if (!current.modelProfiles) return adaptUnboundProviders(current, patch);
  if (validateModelProfiles(current.modelProfiles).length) {
    throw new ModelProfileConfigError('invalid');
  }
  const profiles = normalizeModelProfiles(current.modelProfiles);
  const result: LegacyPatchInput['patch'] = { ...patch, modelProfiles: profiles };
  for (const role of roles) adaptRole(current, result, role);
  return result;
}
function adaptUnboundProviders(
  current: PersistedConfig, patch: LegacyPatchInput['patch'], role?: ModelRole,
): LegacyPatchInput['patch'] {
  const result = { ...patch };
  if (role !== 'fast' && patch.provider !== undefined && patch.provider !== current.provider
    && !Object.prototype.hasOwnProperty.call(patch, 'baseUrl')) result.baseUrl = null;
  if (role !== 'main' && patch.fast?.provider !== undefined
    && patch.fast.provider !== current.fast.provider
    && !Object.prototype.hasOwnProperty.call(patch.fast, 'baseUrl')) {
    result.fast = { ...patch.fast, baseUrl: '' };
  }
  return result;
}
function adaptRole(
  current: PersistedConfig, patch: LegacyPatchInput['patch'], role: ModelRole,
): void {
  const profiles = patch.modelProfiles!;
  const entry = profiles.entries.find((profile) => profile.id === profiles[`${role}Id`]);
  if (!entry) {
    Object.assign(patch, adaptUnboundProviders(current, patch, role));
    return;
  }
  if (entry.apiKey) throw new ModelProfileConfigError('profile_key_required');
  const explicit = role === 'main' ? patch : patch.fast!;
  const provider = explicit.provider ?? entry.provider;
  const changedProvider = provider !== entry.provider;
  const baseUrl = Object.prototype.hasOwnProperty.call(explicit, 'baseUrl')
    ? explicit.baseUrl ?? null : changedProvider ? null : entry.baseUrl;
  const connection = { provider, model: explicit.model ?? entry.model, baseUrl };
  if (role === 'fast') {
    const main = projectModelProfiles(current).file;
    const mainProvider = patch.provider ?? main.provider ?? current.provider;
    const mainUrl = Object.prototype.hasOwnProperty.call(patch, 'baseUrl')
      ? patch.baseUrl : main.baseUrl;
    assertLegacyFastTarget(connection, { provider: mainProvider, baseUrl: mainUrl });
    patch.fast = { ...connection, ...patch.fast, baseUrl: baseUrl ?? '' };
  } else Object.assign(patch, connection);
  profiles[`${role}Id`] = null;
}

/** A detached default endpoint must not acquire a gateway through legacy inheritance. */
export function assertLegacyFastTarget(
  fast: { provider: string; baseUrl?: string | null },
  main: { provider: string; baseUrl?: string | null },
): void {
  if (!normalizeProfileBaseUrl(fast.baseUrl) && (fast.provider || main.provider) === main.provider
    && normalizeProfileBaseUrl(main.baseUrl)) {
    throw new ModelProfileConfigError('legacy_conversion_unsupported');
  }
}
