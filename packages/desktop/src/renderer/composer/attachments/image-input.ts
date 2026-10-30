/**
 * Can the model in this session read images? (spec 3.6, D-4)
 *
 * The host answers from its tables (`meta.imageInput`); the USER's own word, kept in
 * `desktop-state.json` as `imageInputOverrides["provider/model"]`, outranks them because the tables
 * go stale the day a model ships. The overrides are layered on here, AND forwarded to the host
 * (`image.override`) so that request-time projection of history images agrees with the banner.
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ipc } from '../../api.js';
import type { ImageInputView } from '../../../shared/attachments.js';
import { sessionStore, useSession } from '../../store/session-store.js';

export type OverrideValue = 'on' | 'off';
type Overrides = Record<string, OverrideValue>;

let overrides: Overrides = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const emit = (): void => { for (const listener of [...listeners]) listener(); };

function isOverrides(value: unknown): value is Overrides {
  return typeof value === 'object' && value !== null
    && Object.values(value).every((entry) => entry === 'on' || entry === 'off');
}

/** Read the table once per window. A failed read leaves it empty and tries again next time. */
export function loadImageOverrides(): Promise<void> {
  if (loaded) return Promise.resolve();
  loading ??= ipc('desktop-state:get').then((result) => {
    if (result.ok) {
      const stored = (result.value as { imageInputOverrides?: unknown }).imageInputOverrides;
      overrides = isOverrides(stored) ? { ...stored } : {};
      loaded = true;
      emit();
    }
  }).finally(() => { loading = null; });
  return loading;
}

export const overrideKey = (provider: string, model: string): string => `${provider}/${model}`;

/** Persist one row (null removes it). The table is replaced as a whole, which is what the patch expects. */
export async function writeImageOverride(key: string, value: OverrideValue | null): Promise<void> {
  const next: Overrides = { ...overrides };
  if (value === null) delete next[key]; else next[key] = value;
  overrides = next; // optimistic: the banner reacts at once
  emit();
  const result = await ipc('desktop-state:patch', { imageInputOverrides: next });
  if (result.ok && isOverrides((result.value as { imageInputOverrides?: unknown }).imageInputOverrides)) {
    overrides = { ...(result.value as { imageInputOverrides: Overrides }).imageInputOverrides };
    emit();
  }
}

/** Merge the user's override over what the host reported. Pure. */
export function effectiveImageInput(
  host: ImageInputView | undefined, table: Overrides, key: string,
): ImageInputView {
  const base: ImageInputView = host ?? { support: 'unknown', source: 'heuristic', tokenEstimate: 1600 };
  const user = table[key];
  if (user === 'on') return { ...base, support: 'yes', source: 'override' };
  if (user === 'off') return { ...base, support: 'no', source: 'override' };
  return base;
}

export interface ImageInputState extends ImageInputView {
  /** `provider/model` - the override key. */
  key: string;
  model: string;
  setOverride(value: OverrideValue | null): Promise<void>;
}

export function useImageInput(sessionId: string): ImageInputState {
  const meta = useSession(sessionId, (mirror) => mirror?.meta);
  const table = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => overrides, () => overrides,
  );
  useEffect(() => { void loadImageOverrides(); }, []);
  const key = overrideKey(meta?.provider ?? '', meta?.model ?? '');
  const attached = meta !== undefined;
  const stored = table[key] ?? null;
  // Tell the host what the user decided for the ACTIVE model (and clear it again when it is
  // removed or the model changes). Idempotent, so a re-run is harmless.
  useEffect(() => {
    if (!attached || key === '/') return;
    void sessionStore.command(sessionId, { c: 'image.override', key, value: stored });
  }, [sessionId, attached, key, stored]);
  const setOverride = useCallback((value: OverrideValue | null) => writeImageOverride(key, value), [key]);
  return { ...effectiveImageInput(meta?.imageInput, table, key), key, model: meta?.model ?? '', setOverride };
}

/** Every override the user has written down, for the settings list. Re-renders on change. */
export function useImageOverrideTable(): Readonly<Overrides> {
  const table = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => overrides, () => overrides,
  );
  useEffect(() => { void loadImageOverrides(); }, []);
  return table;
}

/**
 * The capability for a session's model, for UI that only needs to READ it (an error notice).
 * Unlike `useImageInput` this does not forward the override to the host: many rows can use it.
 */
export function useEffectiveImageSupport(sessionId: string): 'yes' | 'no' | 'unknown' {
  const meta = useSession(sessionId, (mirror) => mirror?.meta);
  const table = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => overrides, () => overrides,
  );
  useEffect(() => { void loadImageOverrides(); }, []);
  return effectiveImageInput(meta?.imageInput, table, overrideKey(meta?.provider ?? '', meta?.model ?? '')).support;
}

/** Test seam. */
export function resetImageOverrides(): void {
  overrides = {};
  loaded = false;
  loading = null;
  emit();
}
