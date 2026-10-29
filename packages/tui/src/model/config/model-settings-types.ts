/**
 * The model-settings TRANSACTION types, split out of `model-profile-store.ts`
 * (tui-package-split S2).
 *
 * ASCII ONLY - `src/config/**` is inside `glyphs.test.ts::inScope`.
 *
 * TYPES ONLY, NO RUNTIME CODE. The terminal-UI view models (settings screen, model-kit
 * resolution, team fan-out and governance settings) need the SHAPE of a settings patch,
 * a draft and a save result, but the store that owns them also reads and writes the config
 * file. Keeping the shapes here lets those view models live in a package that has no
 * filesystem persistence, while `model-profile-store.ts` re-exports every name so existing
 * importers and tests are untouched. Symbols with I/O semantics (`ConfigReadError`,
 * `ModelSettingsDisk`, `ModelProfileConfigError`) deliberately stay in the store.
 *
 * `SessionKitState` comes from `model-kits`, which in turn imports `ModelSettingsSaveResult`
 * from here: a pure type cycle, which TypeScript permits because it is erased at compile time.
 */

import type { SessionKitState } from './model-kits.js';
import type { ModelProfilesConfig, ModelRole, ProfileValidationIssue } from './model-profiles.js';
import type { CliConfig, CompactionConfig, FastConfig, GovernanceConfig, LogConfig,
  PersistedConfig, TeamConfig } from './schema.js';

// 'team' joins the Omit list because the patch carries a PARTIAL section (V-6):
// `Partial<TeamConfig>` is not assignable to the full `TeamConfig` the persisted
// shape demands, so redeclaring the section without excluding it fails the
// interface-extension compatibility rule outright.
export interface ModelSettingsPatch extends Partial<
  Omit<PersistedConfig, 'modelProfiles' | 'fast' | 'compaction' | 'log' | 'team' | 'governance'>
> {
  fast?: Partial<FastConfig>;
  compaction?: Partial<CompactionConfig>;
  log?: Partial<LogConfig>;
  /** The subagent-model picker writes here (subagent-model D-5/I-5): draft-only until Save. */
  team?: Partial<TeamConfig>;
  /** Governance writers (`config set`, `/gov budget`) send single keys; the store clamps. */
  governance?: Partial<GovernanceConfig>;
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
  /**
   * The session kit this transaction carries (agent-model-kits RV-P0-2 / §4.3).
   *
   * THREE-STATE, and every state is reachable: `undefined` = "this draft does
   * not speak about kits" (a legacy caller, `/model`, `config set`);
   * an object = "the session kit is still in effect and these slots are still
   * its"; `null` = "this transaction explicitly RELEASES the session kit"
   * (`Current setup`, `/kit use current`, or a save that decided all three
   * slots). `createModelSettingsDraft` seeds it from the LIVE config, without
   * which the object state would be unreachable and any save made from the
   * settings screen would silently release the kit.
   */
  sessionKit?: SessionKitState | null;
  /**
   * Set ONLY by `applySessionKit` (agent-model-kits §4.2 exit B).
   *
   * IT MEANS "THIS DRAFT IS THE KIT BEING APPLIED". The release rule
   * (`releasedSlots`) reads `activateRoles` / `patch.team` / binding changes as
   * "the user decided that slot", and an apply writes all three of those by
   * definition - so without this marker every apply would immediately release the
   * slots it just installed. The marker is per-transaction state, never persisted,
   * and a save from the settings screen never sets it.
   */
  sessionKitFresh?: boolean;
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
