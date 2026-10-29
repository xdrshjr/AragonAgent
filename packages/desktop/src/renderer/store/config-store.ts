/**
 * The configuration as the settings pages and chips see it.
 *
 * Every write is a compare-and-swap against the file's content `revision`: `patch()` sends the
 * revision the user's edit was based on, and a terminal that saved in between turns the write
 * into a `conflict` that is SURFACED (`conflict` state), never retried over the top. A damaged
 * `config.json` leaves `broken` set and every write refuses until it parses again.
 */

import { create } from 'zustand';
import { ipc, onBroadcast } from '../api.js';
import {
  describeActiveModel,
  hasUsableMainModel,
  type ConfigViewDto,
  type ConfigViewResultDto,
} from '../../shared/config-view.js';

export type StartupKind = 'unknown' | 'onboarding' | 'ready' | 'broken';

export interface ConfigConflict {
  /** The patch the user tried to save. */
  patch: Record<string, unknown>;
  /** The revision now on disk. */
  latestRevision: string;
}

export interface ConfigState {
  result: ConfigViewResultDto | null;
  loading: boolean;
  startup: StartupKind;
  /** One-line summary shown once as "configuration recognised". */
  recognised: { model: string; profiles: number } | null;
  conflict: ConfigConflict | null;
  /** The disk changed under an open editor; the page decides whether to reload or keep edits. */
  staleOnDisk: boolean;

  refresh(): Promise<void>;
  patch(patch: Record<string, unknown>): Promise<{ ok: true } | { ok: false; code: string }>;
  resolveConflict(choice: 'reload' | 'overwrite'): Promise<void>;
  dismissStale(): void;
  view(): ConfigViewDto | null;
}

function classify(result: ConfigViewResultDto): StartupKind {
  if (!result.ok) return 'broken';
  return hasUsableMainModel(result.view) ? 'ready' : 'onboarding';
}

export const useConfig = create<ConfigState>((set, get) => ({
  result: null,
  loading: false,
  startup: 'unknown',
  recognised: null,
  conflict: null,
  staleOnDisk: false,

  view: () => get().result?.view ?? null,

  async refresh() {
    set({ loading: true });
    const response = await ipc('config:get');
    if (!response.ok) {
      set({ loading: false });
      return;
    }
    const result = response.value;
    const first = get().startup === 'unknown';
    const startup = classify(result);
    set({
      result, loading: false, startup, staleOnDisk: false,
      ...(first && startup === 'ready' && result.view
        ? { recognised: { model: describeActiveModel(result.view), profiles: result.view.modelProfiles?.entries.length ?? 0 } }
        : {}),
    });
  },

  async patch(patch) {
    const base = get().result;
    if (!base || !base.ok) return { ok: false, code: 'read_failed' };
    const response = await ipc('config:patch', { baseRevision: base.revision, patch });
    if (!response.ok) return { ok: false, code: response.code };
    const outcome = response.value;
    if (!outcome.ok) {
      if (outcome.code === 'conflict') set({ conflict: { patch, latestRevision: outcome.revision } });
      return { ok: false, code: outcome.code };
    }
    await get().refresh();
    return { ok: true };
  },

  async resolveConflict(choice) {
    const conflict = get().conflict;
    set({ conflict: null });
    await get().refresh();
    if (choice === 'overwrite' && conflict) {
      // "Overwrite" means: apply MY patch on top of what is there now. It is still a CAS, now
      // against the fresh revision, so it cannot clobber a third writer either.
      await get().patch(conflict.patch);
    }
  },

  dismissStale: () => set({ staleOnDisk: false }),
}));

/** Subscribe to disk changes made by another process; returns the unsubscribe. */
export function watchConfigChanges(onChanged?: () => void): () => void {
  return onBroadcast('config:changed', () => {
    const state = useConfig.getState();
    if (state.result?.view) useConfig.setState({ staleOnDisk: true });
    void state.refresh().then(() => onChanged?.());
  });
}
