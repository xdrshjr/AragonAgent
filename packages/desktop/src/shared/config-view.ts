/**
 * The configuration as a renderer may see it: a masked projection of `PersistedConfig`.
 *
 * STRUCTURALLY IDENTICAL to `ConfigView` in `cli/src/host/settings.ts`. It is restated here
 * (not imported) because `shared/` may not depend on the cli package at run time; the main
 * process hands the host's object straight through and the compiler checks it fits.
 */

import type { PersistedConfig } from '@aragon-agent/tui/model/config/schema';
import type { ModelProfile, ModelProfilesConfig } from '@aragon-agent/tui/model/config/model-profiles';

export interface MaskedKey {
  present: boolean;
  /** Last four characters; never enough to reconstruct a key. */
  tail: string;
  source: 'file' | 'env' | 'none';
}

export interface MaskedProfile extends Omit<ModelProfile, 'apiKey'> {
  key: MaskedKey;
}

export interface ConfigViewDto extends Omit<PersistedConfig, 'apiKeys' | 'modelProfiles'> {
  apiKeys: Record<string, MaskedKey>;
  modelProfiles: (Omit<ModelProfilesConfig, 'entries'> & { entries: MaskedProfile[] }) | null;
}

export type ConfigReadError = 'invalid_json' | 'invalid_root' | 'read_failed';

export interface ConfigViewResultDto {
  ok: boolean;
  /** The compare-and-swap token: sha256 of the file bytes, or `missing` / `unreadable`. */
  revision: string;
  path: string;
  view: ConfigViewDto | null;
  error?: ConfigReadError;
  unknownKeys: string[];
  terminalOnlyKeys: string[];
}

export type ConfigPatchResultDto =
  | { ok: true; revision: string; changedKeys: string[] }
  | { ok: false; code: string; revision: string };

/**
 * Whether a config describes a usable main model: a profile bound to `main`, or a provider
 * with a key (file or environment). This is the "import state" test of spec 3.5.2 - a user
 * who configured the terminal must NOT be shown onboarding.
 */
export function hasUsableMainModel(view: ConfigViewDto | null): boolean {
  if (!view) return false;
  const profiles = view.modelProfiles;
  if (profiles?.mainId) {
    const main = profiles.entries.find((entry) => entry.id === profiles.mainId);
    if (main && main.key.present) return true;
  }
  return Boolean(view.apiKeys[view.provider]?.present);
}

/** A one-line description of the active model for the "configuration recognised" toast. */
export function describeActiveModel(view: ConfigViewDto): string {
  const profiles = view.modelProfiles;
  const main = profiles?.mainId ? profiles.entries.find((entry) => entry.id === profiles.mainId) : undefined;
  return main ? `${main.provider}:${main.model}` : `${view.provider}:${view.model}`;
}
