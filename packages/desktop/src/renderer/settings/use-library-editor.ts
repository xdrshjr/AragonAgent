/**
 * Saves a change to the model-profile library (profiles, role bindings, kits).
 *
 * `config:patch` replaces `modelProfiles` as one section and needs every stored key, so each
 * commit first loads the full library (see `settings-profiles.ts`), applies the pure mutation,
 * lets the engine's own validator veto the result, and only then writes - one compare-and-swap
 * patch. A `conflict` is left to `ConfigConflictDialog`.
 */

import type { ModelProfilesConfig } from '@aragon-agent/tui/model/config/model-profiles';
import { useCallback, useState } from 'react';
import { isLibraryValid, loadFullLibrary } from '../lib/settings-profiles.js';
import { useConfig } from '../store/config-store.js';

export type LibraryFailure =
  | { kind: 'key_unavailable'; profile: string }
  | { kind: 'invalid' }
  | { kind: 'save'; code: string };

export interface LibraryEditor {
  busy: boolean;
  failure: LibraryFailure | null;
  clearFailure(): void;
  /** Run a mutation; it may return null to say "nothing to save" (the caller shows why). */
  commit(mutate: (library: ModelProfilesConfig) => ModelProfilesConfig | null): Promise<boolean>;
}

export function useLibraryEditor(): LibraryEditor {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<LibraryFailure | null>(null);

  const commit = useCallback(async (mutate: (library: ModelProfilesConfig) => ModelProfilesConfig | null) => {
    setBusy(true);
    setFailure(null);
    try {
      const loaded = await loadFullLibrary(useConfig.getState().result?.view ?? null);
      if (!loaded.ok) {
        setFailure({ kind: 'key_unavailable', profile: loaded.profile });
        return false;
      }
      const next = mutate(loaded.library);
      if (next === null) return false;
      if (!isLibraryValid(next)) {
        setFailure({ kind: 'invalid' });
        return false;
      }
      const outcome = await useConfig.getState().patch({ modelProfiles: next });
      if (outcome.ok) return true;
      if (outcome.code !== 'conflict') setFailure({ kind: 'save', code: outcome.code });
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, failure, clearFailure: () => setFailure(null), commit };
}
