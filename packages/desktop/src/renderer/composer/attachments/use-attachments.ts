/**
 * The composer's view of its attachments (spec 5.4): the items, and the verbs on them.
 * State lives in `attachment-draft-store`; this hook binds it to a session, supplies the real
 * browser dependencies to `ingest`, and turns store events into toasts.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { ipc } from '../../api.js';
import { clearActionToasts, pushActionToast } from '../../chat/action-toast-store.js';
import { pushToast } from '../../chat/hooks.js';
import { useT } from '../../i18n/index.js';
import { emitComposerIntent } from '../composer-bus.js';
import {
  clearAttachmentDrafts,
  clearRemovedBuffer,
  getAttachmentDrafts,
  hydrateAttachments,
  removeAttachmentDraft,
  removeAttachmentDrafts,
  restoreAttachmentDrafts,
  restoreRemovedDraft,
  subscribeAttachments,
  type AttachmentDraft,
} from './attachment-draft-store.js';
import { getImageDeps } from './image-pipeline.js';
import { forgetFailedSource, ingestFiles, retryImage, type IngestDeps, type IngestOrigin } from './ingest.js';

export type Blocking = 'processing' | 'error' | null;

/** The hint that `@image1` works is shown once per install, however many sessions there are. */
const REFERENCE_HINT_ID = 'attachments.reference';

export interface AttachmentsApi {
  items: readonly AttachmentDraft[];
  add(files: readonly File[], origin: IngestOrigin): Promise<void>;
  /**
   * Ask the main process for the picture on the OS clipboard (for sources the page's own paste event
   * cannot see). `explicit` = the user chose it from a menu, so an empty clipboard deserves a
   * word; from a paste it stays silent (they may simply have pasted nothing).
   */
  pasteFromClipboardImage(options?: { explicit?: boolean }): Promise<void>;
  /** Remove one; a ready attachment can be brought back from the "Undo" toast. */
  remove(ref: string): void;
  /** Remove several as one step with a single "Undo". */
  removeMany(refs: readonly string[]): void;
  retry(ref: string): void;
  /** Insert `@ref ` at the caret. */
  reference(ref: string): void;
  clear(): void;
  restore(items: readonly AttachmentDraft[]): void;
  blocking: Blocking;
  /** Ready images (they would be sent as pictures unless the mode says path). */
  readyImages: number;
  readyCount: number;
}

export function blockingOf(items: readonly AttachmentDraft[]): Blocking {
  if (items.some((item) => item.status === 'processing')) return 'processing';
  if (items.some((item) => item.status === 'error')) return 'error';
  return null;
}

export function useAttachments(sessionId: string): AttachmentsApi {
  const t = useT();
  const items = useSyncExternalStore(
    subscribeAttachments, () => getAttachmentDrafts(sessionId), () => getAttachmentDrafts(sessionId),
  );

  const deps = useMemo<IngestDeps>(() => ({
    pathForFile: (file) => window.aragon?.pathForFile?.(file) ?? '',
    statPath: async (path) => {
      const result = await ipc('native:stat-path', { path });
      return result.ok ? result.value : null;
    },
    image: getImageDeps(),
    notify: (level, text) => pushToast(sessionId, level, text),
    t,
    now: () => new Date(),
  }), [sessionId, t]);

  // After a reload the references come back; lost images are reported once.
  useEffect(() => {
    const { lostImages } = hydrateAttachments(sessionId);
    if (lostImages > 0) pushToast(sessionId, 'warn', t('chat.attach.imagesLost', { n: lostImages }));
  }, [sessionId, t]);

  const add = useCallback(async (files: readonly File[], origin: IngestOrigin): Promise<void> => {
    const added = await ingestFiles(sessionId, files, origin, deps);
    if (origin === 'paste' && added.some((item) => item.kind === 'image')) {
      const first = added.find((item) => item.kind === 'image')!;
      void showReferenceHint(sessionId, first.ref, t);
    }
  }, [sessionId, deps, t]);

  // Leaving the session (or closing it) ends the undo window: the buffer is the one place picture
  // bytes outlive the tray, and a toast's closure holds them too.
  useEffect(() => () => { clearRemovedBuffer(sessionId); clearActionToasts(sessionId); }, [sessionId]);

  const undoRemoval = useCallback((removed: readonly AttachmentDraft[]): void => {
    let limited = false;
    const renamed: string[] = [];
    for (const draft of removed) {
      const result = restoreRemovedDraft(sessionId, draft.localId);
      if (!result.ok) { limited ||= result.reason === 'limit'; continue; }
      if (result.draft.ref !== result.originalRef) renamed.push(`${result.originalRef} → ${result.draft.ref}`);
    }
    if (limited) pushToast(sessionId, 'warn', t('chat.attach.restoreLimit'));
    if (renamed.length > 0) pushToast(sessionId, 'info', t('chat.attach.restoredRenamed', { changes: renamed.join(', ') }));
  }, [sessionId, t]);

  const offerUndo = useCallback((removed: readonly AttachmentDraft[]): void => {
    const restorable = removed.filter((item) => item.status === 'ready');
    if (restorable.length === 0) return;
    pushActionToast(sessionId, {
      level: 'info',
      text: restorable.length === 1
        ? t('chat.attach.removed', { name: restorable[0]!.name })
        : t('chat.attach.removedN', { n: restorable.length }),
      action: { label: t('chat.attach.undo'), onRun: () => undoRemoval(restorable) },
    });
  }, [sessionId, t, undoRemoval]);

  const clipboardRun = useRef<Promise<void> | null>(null);
  const pasteFromClipboardImage = useCallback((options?: { explicit?: boolean }): Promise<void> => {
    // One request at a time: a paste and a click landing together must not add the picture twice.
    if (clipboardRun.current) return clipboardRun.current;
    const run = (async (): Promise<void> => {
      const result = await ipc('native:read-clipboard-image');
      if (!result.ok) {
        if (result.code === 'too_large') pushToast(sessionId, 'warn', t('chat.attach.clipboardTooLarge'));
        else if (options?.explicit) pushToast(sessionId, 'warn', t('chat.attach.clipboardUnavailable'));
        return;
      }
      if (result.value === null) {
        if (options?.explicit) pushToast(sessionId, 'info', t('chat.attach.clipboardEmpty'));
        return;
      }
      // The same road as a pasted file, so every limit and the shrinking apply identically.
      const file = new File([result.value.bytes], 'image.png', { type: 'image/png' });
      await add([file], 'paste');
    })().finally(() => { clipboardRun.current = null; });
    clipboardRun.current = run;
    return run;
  }, [sessionId, t, add]);

  const remove = useCallback((ref: string): void => {
    const removed = removeAttachmentDraft(sessionId, ref);
    if (!removed) return;
    forgetFailedSource(removed.localId);
    offerUndo([removed]);
  }, [sessionId, offerUndo]);

  const removeMany = useCallback((refs: readonly string[]): void => {
    const removed = removeAttachmentDrafts(sessionId, refs);
    for (const draft of removed) forgetFailedSource(draft.localId);
    offerUndo(removed);
  }, [sessionId, offerUndo]);

  const retry = useCallback((ref: string): void => {
    const target = getAttachmentDrafts(sessionId).find((item) => item.ref === ref);
    if (target?.status === 'error' && target.kind === 'image') void retryImage(sessionId, target, deps);
  }, [sessionId, deps]);

  const reference = useCallback((ref: string): void => { emitComposerIntent('insert-at', `@${ref} `); }, []);
  const clear = useCallback((): void => clearAttachmentDrafts(sessionId), [sessionId]);
  const restore = useCallback((restored: readonly AttachmentDraft[]): void => restoreAttachmentDrafts(sessionId, restored), [sessionId]);

  const readyImages = items.filter((item) => item.kind === 'image' && item.status === 'ready').length;
  return {
    items, add, pasteFromClipboardImage, remove, removeMany, retry, reference, clear, restore,
    blocking: blockingOf(items), readyImages, readyCount: items.filter((item) => item.status === 'ready').length,
  };
}

async function showReferenceHint(
  sessionId: string, ref: string, t: ReturnType<typeof useT>,
): Promise<void> {
  const state = await ipc('desktop-state:get');
  if (!state.ok) return;
  const hints = state.value.dismissedHints ?? [];
  if (hints.includes(REFERENCE_HINT_ID)) return;
  pushToast(sessionId, 'info', t('chat.attach.refHint', { ref }));
  void ipc('desktop-state:patch', { dismissedHints: [...hints, REFERENCE_HINT_ID] });
}
