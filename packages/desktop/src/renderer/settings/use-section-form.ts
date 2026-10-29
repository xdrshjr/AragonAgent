/**
 * The state machine behind one settings form: draft edits (held in `settings-drafts`), the
 * engine-checked resolution of those edits, and Save.
 *
 * Save is a compare-and-swap through `useConfig().patch`. A `conflict` is NOT handled here:
 * the store records it and `ConfigConflictDialog` offers the three-way choice, so no page can
 * quietly retry over the top of another writer.
 */

import { useCallback, useMemo, useState } from 'react';
import { readBase, pruneEdits, resolveSection, type AdjustedField, type SectionResolution } from '../lib/settings-draft.js';
import { NO_EDITS, useDrafts } from '../lib/settings-drafts.js';
import type { FieldSpec, RawEdits, SectionSpec } from '../lib/settings-fields.js';
import { useConfig } from '../store/config-store.js';
import type { ConfigViewDto } from '../../shared/config-view.js';

export type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; adjusted: AdjustedField[] }
  | { kind: 'failed'; code: string };

export interface SectionForm {
  view: ConfigViewDto | null;
  base: Record<string, unknown>;
  edits: RawEdits;
  resolution: SectionResolution;
  saveState: SaveState;
  /** Dangerous switches this save would turn off (the page confirms first). */
  dangers: FieldSpec[];
  canSave: boolean;
  setField(key: string, raw: boolean | string): void;
  revert(): void;
  save(): Promise<void>;
}

export function dangersIn(section: SectionSpec, resolution: SectionResolution): FieldSpec[] {
  const body = section.configKey ? (resolution.patch?.[section.configKey] as Record<string, unknown> | undefined) : resolution.patch;
  if (!body) return [];
  return section.fields.filter((field) => field.kind === 'bool' && field.danger && body[field.key] === false);
}

export function useSectionForm(section: SectionSpec): SectionForm {
  const result = useConfig((state) => state.result);
  const view = result?.view ?? null;
  const revision = result?.revision ?? '';
  const edits = useDrafts((state) => state.drafts[section.id]?.edits) ?? NO_EDITS;
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });

  const base = useMemo(() => readBase(section, view), [section, view]);
  const resolution = useMemo(() => resolveSection(section, view, edits), [section, view, edits]);
  const dangers = useMemo(() => dangersIn(section, resolution), [section, resolution]);

  const setField = useCallback((key: string, raw: boolean | string) => {
    const next = pruneEdits(section, view, { ...edits, [key]: raw });
    useDrafts.getState().setEdits(section.id, revision, next);
    setSaveState((current) => (current.kind === 'idle' ? current : { kind: 'idle' }));
  }, [section, view, edits, revision]);

  const revert = useCallback(() => {
    useDrafts.getState().discard(section.id);
    setSaveState({ kind: 'idle' });
  }, [section.id]);

  const save = useCallback(async () => {
    if (!resolution.patch || Object.keys(resolution.errors).length > 0) return;
    setSaveState({ kind: 'saving' });
    const outcome = await useConfig.getState().patch(resolution.patch);
    if (outcome.ok) {
      useDrafts.getState().discard(section.id);
      setSaveState({ kind: 'saved', adjusted: resolution.adjusted });
    } else {
      setSaveState(outcome.code === 'conflict' ? { kind: 'idle' } : { kind: 'failed', code: outcome.code });
    }
  }, [resolution, section.id]);

  const canSave = resolution.patch !== null && Object.keys(resolution.errors).length === 0 && saveState.kind !== 'saving';
  return { view, base, edits, resolution, saveState, dangers, canSave, setField, revert, save };
}
