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
import { applyHeldToLive, carrySessionKit } from '../config/kit-resolution.js';
import { findKit, type KitSlot, type SessionKitState } from '../config/model-kits.js';
import { registerProfileSecrets } from '../logging/secret-registry.js';
import { getLogger } from '../logging/logger.js';

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
    // SEEDED FROM THE LIVE CONFIG (RV-P0-2). Without this line `draft.sessionKit`
    // is always `undefined`, the `undefined` case below means "release", and any
    // save made from the settings screen would silently drop a session kit the
    // user just applied - the exact opposite of "this session only".
    sessionKit: live.sessionKit ? structuredClone(live.sessionKit) : undefined,
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

/**
 * The slots THIS transaction explicitly decided, and that therefore leave the
 * session kit (§4.3 / D-6).
 *
 * Released BY SLOT, never wholesale: a user who only retargeted the subagent
 * must not lose the main and fast choices the kit made for this session, and a
 * user who retargeted main must not have it silently ignored. Per-slot is the
 * only rule shaped like the data (three independent slots).
 */
export function releasedSlots(draft: ModelSettingsDraft): KitSlot[] {
  const held = draft.sessionKit?.held ?? [];
  if (!held.length) return [];
  // THE APPLY ITSELF RELEASES NOTHING (`kit-apply.ts` sets this marker). Without
  // it the apply's own writes - `activateRoles`, `patch.team`, the re-bound
  // library - read as "the user decided every slot", and the save would drop the
  // three slots it was just handed.
  if (draft.sessionKitFresh) return [];
  const kit = findKit(draft.profiles ?? draft.baseline.modelProfiles, draft.sessionKit?.id);
  if (!kit) return [...held];
  const released = new Set<KitSlot>();
  for (const role of ['main', 'fast'] as const) {
    if (draft.activateRoles.includes(role) || connectionChanged(draft, role)
      || hasConnectionPatch(draft.patch, role)) released.add(role);
  }
  if (draft.patch.team !== undefined) released.add('subagent');
  return [...released].filter((slot) => held.includes(slot));
}

/** The session kit as it stands AFTER this transaction's explicit decisions. */
function narrowedSessionKit(draft: ModelSettingsDraft): SessionKitState | null {
  const current = draft.sessionKit;
  if (!current) return null;
  const released = releasedSlots(draft);
  const held = current.held.filter((slot) => !released.includes(slot));
  return held.length ? { id: current.id, held } : null;
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
  // 'team' joined the loop with the subagent-model picker (D-5): its rows
  // write `draft.patch.team`, and `mergePersistedConfig` clamps the candidate
  // through `clampTeamConfig` on the same per-key merge `/team` uses, so the
  // live view and the file can never disagree about which model children run.
  for (const section of ['apiKeys', 'fast', 'compaction', 'log', 'team'] as const) {
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
  const projection = projectModelProfiles(candidate);
  // `projected` keeps its name and every existing use (`projected.provider`
  // etc.); the FULL projection is retained because `mainOwnsContextWindow`
  // lives on it, not on `.file` (profile-context-window §6.4).
  const projected = projection.file;
  if (draft.profiles !== undefined || candidate.modelProfiles !== undefined) {
    next.modelProfiles = structuredClone(projected.modelProfiles);
  }
  // THE WINDOW VALUE AND ITS ORIGIN RECOMPUTE IN THE SAME BATCH (P0-1): the
  // meter's `getWindowOverride()` reads `this.config.contextWindow`, so a save
  // that only recomputed the origin would leave a freshly edited profile
  // window invisible until the next launch. env is a STARTUP-layer fact and no
  // save may displace it (AC-4 / AC-14c); an explicit root-row edit takes the
  // candidate value; a bound Main profile owns the denominator (value or null,
  // tradeoff B); unbinding falls back to the legacy top-level key.
  next.contextWindow = live.contextWindowOrigin === 'env'
    ? live.contextWindow
    : 'contextWindow' in patch ? candidate.contextWindow
      : projection.mainOwnsContextWindow ? projected.contextWindow ?? null
        : candidate.contextWindow;
  // ORIGIN OBEYS THE IFF CONTRACT (§6.1): value null means AUTO, so origin
  // MUST reset to undefined - this unified formula is what removes the stale
  // 'profile' a per-branch expression would leave behind on unbind-to-null.
  next.contextWindowOrigin = next.contextWindow === null ? undefined
    : live.contextWindowOrigin === 'env' ? 'env'
      : 'contextWindow' in patch ? 'config'
        : projection.mainOwnsContextWindow ? 'profile' : 'config';
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
      // I-13 (RV-P1-7): `projectModelProfiles` projects fast ONLY when the
      // library binds one. With `fastId: null` the projection's `fast` is just the
      // file's untouched section (`projected` starts as `{...file}`), so copying it
      // here would resurrect the disk's fast endpoint underneath a kit that
      // deliberately turned the tier off - the live config would then say "off"
      // while naming a model nobody chose.
      if (projected.modelProfiles?.fastId) {
        next.fast = { ...next.fast, provider: projected.fast!.provider,
          model: projected.fast!.model, baseUrl: projected.fast!.baseUrl };
      }
    }
  }
  if (next.apiKeyOverride && !next.apiKeyOverrideTarget
    && (next.modelProfiles?.mainId || next.modelProfiles?.fastId)) {
    next.apiKeyOverrideTarget = { provider: live.provider, baseUrl: live.baseUrl ?? null };
  }
  next.modelProfileState = resolveModelProfileState(next);
  return next;
}

/** The validate-and-prepare half of a save; it performs no disk write. */
interface PreparedModelSettings {
  /** THE ONLY candidate that may reach `commitModelSettings` (I-14). */
  diskCandidate: PersistedConfig;
  /** The same candidate with the still-held slots re-applied; live-side only. */
  liveCandidateInput: PersistedConfig;
  snapshot: ModelSettingsSnapshot;
}

/**
 * Build both candidates and the snapshot.
 *
 * TWO CANDIDATES, NAMED DIFFERENTLY ON PURPOSE (RV-P0-1 / I-14). `diskCandidate`
 * is the commit side and never learns about a held slot; `liveCandidateInput`
 * is what the session sees and is never committed. Collapsing them into one
 * variable is the defect this split exists to prevent: one unrelated save would
 * then write the session's kit into the user's permanent defaults, and nothing
 * visible would change.
 */
function prepareModelSettings(input: {
  draft: ModelSettingsDraft;
  controller: ModelSettingsController;
  current: PersistedConfig;
}): { prepared?: PreparedModelSettings; failure?: ModelSettingsSaveResult } {
  const { draft, controller, current } = input;
  const issues = validateModelProfiles(draft.profiles ?? current.modelProfiles);
  if (issues.length) return { failure: { ...rejected('invalid'), issues } };
  try {
    const profilesChanged = draft.activateRoles.length > 0
      || JSON.stringify(draft.profiles) !== JSON.stringify(draft.baseline.modelProfiles);
    const implicitLegacy = draft.profiles === undefined || !profilesChanged;
    const patch = adaptLegacyConnectionPatch({ current, patch: implicitLegacy
      ? draft.patch : { ...draft.patch, modelProfiles: draft.profiles } });
    const diskCandidate = mergePersistedConfig(current, patch);
    registerProfileSecrets(diskCandidate);
    const sessionKit = narrowedSessionKit(draft);
    const applied = applyHeldToLive(diskCandidate, sessionKit);
    if (applied.dropped.length) {
      getLogger().warn('agent', 'session_kit_slots_dropped', { slots: applied.dropped });
    }
    const next = liveCandidate(controller.getConfig(), applied.candidate, draft);
    next.sessionKit = sessionKit ?? undefined;
    // Disk preferences cannot reveal startup/session gateways retained by the live main role.
    if (implicitLegacy && current.modelProfiles?.fastId && hasConnectionPatch(draft.patch, 'fast')) {
      assertLegacyFastTarget(next.fast, next);
    }
    const snapshot = controller.prepareModelSettingsSnapshot(next);
    return { prepared: { diskCandidate, liveCandidateInput: applied.candidate, snapshot } };
  } catch (error) {
    const code = (error as { code?: ModelSettingsSaveResult['code'] }).code ?? 'invalid';
    return { failure: rejected(code) };
  }
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
  const prepared = prepareModelSettings({ draft, controller,
    current: disk.config ?? structuredClone(DEFAULT_CONFIG) });
  if (!prepared.prepared) return prepared.failure!;
  const commit = commitModelSettings({ candidate: prepared.prepared.diskCandidate,
    diskRevision: draft.diskRevision });
  if (!commit.ok) return rejected(commit.code ?? 'write_failed');
  return applyPreparedSnapshot(controller, prepared.prepared.snapshot, true);
}

/**
 * The SAME prepare chain, without the commit: a session kit (§4.2 exit B).
 *
 * NO `diskRevision` GATE: nothing is written, so a save that landed elsewhere is
 * not this operation's business. It still refuses while work is in flight
 * (`busy`) and still refuses a draft whose disk could not be read, so "nothing
 * changed" is guaranteed for every other failure too (I-10).
 */
export function previewModelSettings(
  draft: ModelSettingsDraft, controller: ModelSettingsController,
): ModelSettingsSaveResult {
  if (controller.isModelSettingsBusy()) return rejected('busy');
  if (draft.readError) return rejected('read_failed');
  const disk = readModelSettingsDisk();
  if (!disk.ok) return rejected('read_failed');
  const prepared = prepareModelSettings({ draft, controller,
    current: disk.config ?? structuredClone(DEFAULT_CONFIG) });
  if (!prepared.prepared) return prepared.failure!;
  return applyPreparedSnapshot(controller, prepared.prepared.snapshot, false);
}

/**
 * Apply a prepared snapshot.
 *
 * `persisted` HAS NO DEFAULT (RV-P1-4): the one attribute that distinguishes
 * "the file now says this" from "only this process says this" is not something
 * a call site should be able to forget.
 */
export function applyPreparedSnapshot(
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
    // THE SESSION KIT SURVIVES A RELOAD (D-6): the three connections it holds
    // must come from the kit, not from the file we just re-read, and the
    // projection has to be recomputed so the live config stays equivalent to
    // what its own bindings say (I-3).
    const carried = carrySessionKit({ resolved, previous: live });
    const after = readModelSettingsDisk();
    if (!after.ok) return rejected('read_failed');
    if (after.revision !== disk.revision) return rejected('conflict');
    if (carried.modelProfileState?.main.invalid) return rejected('invalid');
    return applyPreparedSnapshot(controller,
      controller.prepareModelSettingsSnapshot(carried), false);
  } catch {
    return rejected('invalid');
  }
}
