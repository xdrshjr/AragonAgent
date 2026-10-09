import type { ModelRef } from '@aragon-agent/core';
import { loadConfig } from '../config/load.js';
import { DEFAULT_CONFIG, type CliConfig, type PersistedConfig } from '../config/schema.js';
import { mergePersistedConfig } from '../config/store.js';
import {
  adaptLegacyConnectionPatch, assertLegacyFastTarget, commitModelSettings, readModelSettingsDisk,
  type ModelSettingsDraft, type ModelSettingsPatch, type ModelSettingsSaveResult,
} from '../config/model-profile-store.js';
import { projectModelProfiles, resolveModelProfileState }
  from '../config/model-profile-resolution.js';
import { validateModelProfiles, type ModelRole } from '../config/model-profiles.js';
import { registerProfileSecrets } from '../logging/secret-registry.js';

/** Fully prepared live state; applying it performs no input parsing or disk access. */
export interface ModelSettingsSnapshot {
  config: CliConfig;
  model: ModelRef;
  systemPrompt: string;
}

/** Narrow controller port keeps persistence independent from the agent implementation. */
export interface ModelSettingsController {
  getConfig(): CliConfig;
  getSettingsRevision(): number;
  isModelSettingsBusy(): boolean;
  isFastRegistered(): boolean;
  prepareModelSettingsSnapshot(config: CliConfig): ModelSettingsSnapshot;
  applyModelSettingsSnapshot(snapshot: ModelSettingsSnapshot): void;
  applyModelSettingsEffects(): void;
  blockModelSettingsRequests(): void;
}

/** Capture both baselines when the editor opens, without migrating or writing anything. */
export function createModelSettingsDraft(
  live: CliConfig, liveRevision: number,
): ModelSettingsDraft {
  const disk = readModelSettingsDisk();
  return {
    diskRevision: disk.revision, liveRevision,
    baseline: structuredClone(disk.config ?? DEFAULT_CONFIG),
    liveBaseline: structuredClone(live),
    profiles: disk.config?.modelProfiles
      ? structuredClone(disk.config.modelProfiles) : undefined,
    activateRoles: [], patch: {},
    ...(!disk.ok ? { readError: 'Cannot read config. Repair it with aragon config edit.' } : {}),
  };
}

/** Map stable failure codes to safe UI text; never include parser or SDK error messages. */
export function modelSettingsResultMessage(result: ModelSettingsSaveResult): string {
  if (result.status === 'saved_apply_failed') {
    return result.persisted
      ? 'Saved, but this session could not apply all settings. Restart required.'
      : 'Could not apply the reloaded settings completely. Restart required.';
  }
  if (result.status === 'restart_required') {
    return 'Saved. Fast tier requires a restart; check its model and credentials.';
  }
  const messages: Record<string, string> = {
    busy: 'Wait for the run, team, review, or compaction to finish before saving.',
    conflict: 'Settings changed elsewhere. Reload before saving.',
    read_failed: 'Cannot read config. Repair it with aragon config edit.',
    write_failed: 'Could not write config. Your draft is preserved.',
    invalid: 'Invalid model settings. Check the highlighted field or aragon config edit.',
    profile_key_required: 'This profile has a dedicated key. Edit or copy it in /settings.',
    legacy_conversion_unsupported: 'This endpoint needs a profile. Edit it in /settings.',
  };
  return result.ok ? 'Settings saved.' : messages[result.code ?? 'invalid']!;
}

function rejected(code: ModelSettingsSaveResult['code']): ModelSettingsSaveResult {
  return { ok: false, persisted: false, status: 'rejected', code };
}

function connectionChanged(draft: ModelSettingsDraft, role: ModelRole): boolean {
  if (draft.profiles === undefined) return false;
  const before = draft.baseline.modelProfiles;
  const after = draft.profiles;
  if ((before?.[`${role}Id`] ?? null) !== (after?.[`${role}Id`] ?? null)) return true;
  const id = after?.[`${role}Id`];
  if (!id) return false;
  const a = before?.entries.find((entry) => entry.id === id);
  const b = after?.entries.find((entry) => entry.id === id);
  return (['provider', 'model', 'baseUrl', 'apiKey'] as const)
    .some((key) => a?.[key] !== b?.[key]);
}

function hasConnectionPatch(patch: ModelSettingsPatch, role: ModelRole): boolean {
  const section = role === 'main' ? patch : patch.fast;
  return !!section && ['provider', 'model', 'baseUrl'].some((key) => key in section);
}

function liveCandidate(
  live: CliConfig, candidate: PersistedConfig, draft: ModelSettingsDraft,
): CliConfig {
  const patch = draft.patch;
  const normalizedPatch: Record<string, unknown> = {};
  for (const key of Object.keys(patch) as Array<keyof ModelSettingsPatch>) {
    normalizedPatch[key] = candidate[key];
  }
  const next = { ...live, ...normalizedPatch } as CliConfig;
  for (const section of ['apiKeys', 'fast', 'compaction', 'log'] as const) {
    const normalized: Record<string, unknown> = { ...live[section] };
    for (const key of Object.keys(patch[section] ?? {})) {
      normalized[key] = (candidate[section] as unknown as Record<string, unknown>)[key];
    }
    Object.assign(next, { [section]: normalized });
  }
  if (patch.apiKeys && Object.hasOwn(patch.apiKeys, live.provider)) {
    next.apiKeyOverride = undefined;
    next.apiKeyOverrideTarget = undefined;
  }
  // These fields have intentionally different disk and runtime representations.
  if ('maxTokens' in patch) next.maxTokens = candidate.maxTokens ?? undefined;
  if ('baseUrl' in patch) next.baseUrl = candidate.baseUrl ?? undefined;
  const projected = projectModelProfiles(candidate).file;
  if (draft.profiles !== undefined || candidate.modelProfiles !== undefined) {
    next.modelProfiles = structuredClone(projected.modelProfiles);
  }
  next.liveToolOutput = live.liveToolOutput;
  for (const role of ['main', 'fast'] as const) {
    if (!draft.activateRoles.includes(role) && !connectionChanged(draft, role)
      && !hasConnectionPatch(patch, role)) continue;
    if (role === 'main') {
      next.provider = projected.provider!;
      next.model = projected.model!;
      next.baseUrl = projected.baseUrl ?? undefined;
      next.apiKeyOverride = undefined;
      next.apiKeyOverrideTarget = undefined;
    } else {
      next.fast = { ...next.fast, provider: projected.fast!.provider,
        model: projected.fast!.model, baseUrl: projected.fast!.baseUrl };
    }
  }
  if (next.apiKeyOverride && !next.apiKeyOverrideTarget
    && (next.modelProfiles?.mainId || next.modelProfiles?.fastId)) {
    next.apiKeyOverrideTarget = { provider: live.provider, baseUrl: live.baseUrl ?? null };
  }
  next.modelProfileState = resolveModelProfileState(next);
  return next;
}

/** Validate and prepare everything before the one synchronous, atomic disk commit. */
export function saveModelSettings(input: {
  draft: ModelSettingsDraft; controller: ModelSettingsController;
}): ModelSettingsSaveResult {
  const { draft, controller } = input;
  if (controller.isModelSettingsBusy()) return rejected('busy');
  if (draft.liveRevision !== controller.getSettingsRevision()) return rejected('conflict');
  const disk = readModelSettingsDisk();
  if (!disk.ok || draft.readError) return rejected('read_failed');
  if (disk.revision !== draft.diskRevision) return rejected('conflict');
  const issues = validateModelProfiles(draft.profiles ?? disk.config?.modelProfiles);
  if (issues.length) return { ...rejected('invalid'), issues };
  let snapshot: ModelSettingsSnapshot;
  let candidate: PersistedConfig;
  try {
    const current = disk.config ?? structuredClone(DEFAULT_CONFIG);
    const profilesChanged = draft.activateRoles.length > 0
      || JSON.stringify(draft.profiles) !== JSON.stringify(draft.baseline.modelProfiles);
    const implicitLegacy = draft.profiles === undefined || !profilesChanged;
    const patch = adaptLegacyConnectionPatch({ current, patch: implicitLegacy
      ? draft.patch : { ...draft.patch, modelProfiles: draft.profiles } });
    candidate = mergePersistedConfig(current, patch);
    registerProfileSecrets(candidate);
    const next = liveCandidate(controller.getConfig(), candidate, draft);
    // Disk preferences cannot reveal startup/session gateways retained by the live main role.
    if (implicitLegacy && current.modelProfiles?.fastId && hasConnectionPatch(draft.patch, 'fast')) {
      assertLegacyFastTarget(next.fast, next);
    }
    snapshot = controller.prepareModelSettingsSnapshot(next);
  } catch (error) {
    const code = (error as { code?: ModelSettingsSaveResult['code'] }).code ?? 'invalid';
    return rejected(code);
  }
  const commit = commitModelSettings({ candidate, diskRevision: draft.diskRevision });
  if (!commit.ok) return rejected(commit.code ?? 'write_failed');
  return applyPreparedSnapshot(controller, snapshot, true);
}

function applyPreparedSnapshot(
  controller: ModelSettingsController, snapshot: ModelSettingsSnapshot, persisted: boolean,
): ModelSettingsSaveResult {
  try {
    controller.applyModelSettingsSnapshot(snapshot);
  } catch {
    controller.blockModelSettingsRequests();
    return { ok: false, persisted, status: 'saved_apply_failed', code: 'apply_failed', restartRequired: true };
  }
  try {
    controller.applyModelSettingsEffects();
  } catch {
    return { ok: false, persisted, status: 'saved_apply_failed', code: 'apply_failed', restartRequired: true };
  }
  const restartRequired = snapshot.config.fast.enabled && !controller.isFastRegistered();
  return { ok: true, persisted, status: restartRequired ? 'restart_required' : 'applied',
    restartRequired };
}

/** Reload the complete model snapshot; invalid disk content never replaces a live session. */
export function reloadModelSettings(controller: ModelSettingsController): ModelSettingsSaveResult {
  if (controller.isModelSettingsBusy()) return rejected('busy');
  const disk = readModelSettingsDisk();
  if (!disk.ok) return rejected('read_failed');
  if (validateModelProfiles(disk.config?.modelProfiles).length) return rejected('invalid');
  try {
    const live = controller.getConfig();
    const resolved = loadConfig({ cwd: live.cwd });
    resolved.liveToolOutput = live.liveToolOutput;
    // The mounted renderer owns these session preferences. Reloading model
    // settings must not re-detect the shell or discard a startup --no-color.
    resolved.color = live.color;
    if (live.colorLevel !== undefined) resolved.colorLevel = live.colorLevel;
    if (live.unicode !== undefined) resolved.unicode = live.unicode;
    resolved.reducedMotion ||= !live.color;
    const after = readModelSettingsDisk();
    if (!after.ok) return rejected('read_failed');
    if (after.revision !== disk.revision) return rejected('conflict');
    if (resolved.modelProfileState?.main.invalid) return rejected('invalid');
    return applyPreparedSnapshot(controller,
      controller.prepareModelSettingsSnapshot(resolved), false);
  } catch {
    return rejected('invalid');
  }
}
