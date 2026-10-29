/**
 * Unsaved settings edits, per section, kept outside the pages so they survive navigating
 * between settings pages and so one banner can say "the file changed under your edits".
 *
 * Each draft remembers the config revision it was started against. `config-store` refreshes
 * itself the moment another process writes (it does not wait for the page), so "stale" is
 * decided HERE by comparing that remembered revision with the current one - never by the
 * store's own `staleOnDisk` flag, which `refresh()` clears again in the same tick.
 */

import { create } from 'zustand';
import type { RawEdits } from './settings-fields.js';

export interface SectionDraft {
  baseRevision: string;
  edits: RawEdits;
}

export const NO_EDITS: RawEdits = Object.freeze({}) as RawEdits;

interface DraftsState {
  drafts: Record<string, SectionDraft>;
  /** Replace a section's edits (an empty object removes the draft). */
  setEdits(section: string, revision: string, edits: RawEdits): void;
  /** Keep the edits but treat them as based on `revision` (the "keep my edits" choice). */
  rebase(section: string, revision: string): void;
  discard(section: string): void;
  discardAll(): void;
}

export const useDrafts = create<DraftsState>((set) => ({
  drafts: {},
  setEdits(section, revision, edits) {
    set((state) => {
      const drafts = { ...state.drafts };
      if (Object.keys(edits).length === 0) delete drafts[section];
      else drafts[section] = { baseRevision: state.drafts[section]?.baseRevision ?? revision, edits };
      return { drafts };
    });
  },
  rebase(section, revision) {
    set((state) => {
      const draft = state.drafts[section];
      return draft ? { drafts: { ...state.drafts, [section]: { ...draft, baseRevision: revision } } } : state;
    });
  },
  discard(section) {
    set((state) => {
      if (!(section in state.drafts)) return state;
      const drafts = { ...state.drafts };
      delete drafts[section];
      return { drafts };
    });
  },
  discardAll: () => set({ drafts: {} }),
}));

/** Sections whose draft was started against an older revision than `current`. */
export function staleSections(drafts: Record<string, SectionDraft>, current: string | undefined): string[] {
  if (!current) return [];
  return Object.entries(drafts).filter(([, draft]) => draft.baseRevision !== current).map(([id]) => id);
}
