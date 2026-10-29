/**
 * A tiny in-window event bus between the composer's parts (slash menu -> status-row popovers).
 *
 * Why not the UI store: it is shared state owned elsewhere, and "open the model popover" is a
 * one-shot UI intent, not state anybody needs to read back.
 */

export type ComposerIntent = 'open-model' | 'open-plus' | 'insert-at' | 'restore-text';

type Listener = (payload?: string) => void;

const listeners = new Map<ComposerIntent, Set<Listener>>();

export function onComposerIntent(intent: ComposerIntent, listener: Listener): () => void {
  const set = listeners.get(intent) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(intent, set);
  return () => { set.delete(listener); };
}

export function emitComposerIntent(intent: ComposerIntent, payload?: string): void {
  for (const listener of [...(listeners.get(intent) ?? [])]) listener(payload);
}
