/**
 * A tiny in-window event bus between the composer's parts (slash menu -> status-row popovers).
 *
 * Why not the UI store: it is shared state owned elsewhere, and "open the model popover" is a
 * one-shot UI intent, not state anybody needs to read back.
 */

export type ComposerIntent = 'open-model' | 'open-plus' | 'insert-at' | 'restore-text' | 'add-files' | 'paste-clipboard-image';

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

// ---- "attach these files to this session's message" ----------------------------------------------
// `File` objects cannot ride the string-payload intents above, and the viewer that wants to re-attach a
// picture (a lightbox) is not the composer that owns the tray. The composer of the named session
// listens; a session with no composer mounted simply ignores it.

type FilesListener = (sessionId: string, files: readonly File[]) => void;
const fileListeners = new Set<FilesListener>();

export function onAttachFilesRequest(listener: FilesListener): () => void {
  fileListeners.add(listener);
  return () => { fileListeners.delete(listener); };
}

export function requestAttachFiles(sessionId: string, files: readonly File[]): void {
  for (const listener of [...fileListeners]) listener(sessionId, files);
}
