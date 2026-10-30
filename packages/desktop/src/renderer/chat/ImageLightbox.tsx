/**
 * Full-size view of a message's images. The thumbnail on the entry shows immediately; the
 * original is fetched from the host on demand (`attachment.read`) and swapped in when it
 * arrives. If the host no longer has it, the enlarged thumbnail stays with a plain note.
 *
 * The renderer never names a path: save and reveal go through the main process by attachment id.
 */

import { ChevronLeft, ChevronRight, Copy, FolderOpen, Maximize2, Minimize2, Paperclip, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { dataUrlFor } from '../lib/attachment-text.js';
import { requestAttachFiles } from '../composer/composer-bus.js';
import { sessionStore } from '../store/session-store.js';
import { selectAttachmentsEnabled, useUi } from '../store/ui-store.js';
import { Dialog } from '../ui/overlay.js';
import { IconButton, Skeleton } from '../ui/primitives.js';
import { pushToast } from './hooks.js';
import type { AttachmentReadValue } from '../../shared/attachments.js';

type Original =
  | { state: 'loading' }
  | { state: 'ready'; src: string; mediaType: string; bytes: ArrayBuffer }
  | { state: 'missing' };

function useOriginal(sessionId: string, attachment: AttachmentMeta | undefined): Original {
  const [original, setOriginal] = useState<Original>({ state: 'loading' });
  const id = attachment?.id;
  useEffect(() => {
    if (!id) return undefined;
    let cancelled = false;
    setOriginal({ state: 'loading' });
    void sessionStore.command(sessionId, { c: 'attachment.read', id }).then((result) => {
      if (cancelled) return;
      const value = result.ok ? (result.value as AttachmentReadValue | undefined) : undefined;
      const src = value?.bytes ? dataUrlFor(value.mediaType, value.bytes) : null;
      setOriginal(src && value?.mediaType && value.bytes
        ? { state: 'ready', src, mediaType: value.mediaType, bytes: value.bytes }
        : { state: 'missing' });
    });
    return () => { cancelled = true; };
  }, [sessionId, id]);
  return original;
}

/** A clipboard accepts PNG reliably; anything else is drawn to a canvas first. */
async function toPngBlob(src: string, mediaType: string): Promise<Blob> {
  if (mediaType === 'image/png') return (await fetch(src)).blob();
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('decode'));
    image.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  canvas.getContext('2d')?.drawImage(image, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode'))), 'image/png');
  });
}

export function ImageLightbox(props: {
  sessionId: string;
  images: readonly AttachmentMeta[];
  /** Index into `images`, or null when closed. */
  index: number | null;
  onIndexChange(index: number): void;
  onClose(): void;
}) {
  const t = useT();
  const { images, index, sessionId } = props;
  const current = index !== null ? images[index] : undefined;
  const original = useOriginal(sessionId, current);
  const [actual, setActual] = useState(false);
  const attachmentsEnabled = useUi(selectAttachmentsEnabled);

  useEffect(() => { setActual(false); }, [current?.id]);

  const go = (delta: number): void => {
    if (index === null || images.length < 2) return;
    props.onIndexChange((index + delta + images.length) % images.length);
  };

  useEffect(() => {
    if (!current) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); go(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); go(1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  if (!current) return null;

  const shown = original.state === 'ready' ? original.src : current.thumb ?? null;
  const ready = original.state === 'ready';
  const copy = async (): Promise<void> => {
    if (original.state !== 'ready') { pushToast(sessionId, 'warn', t('chat.lightbox.copyFailed')); return; }
    try {
      const blob = await toPngBlob(original.src, original.mediaType);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      pushToast(sessionId, 'info', t('chat.lightbox.copied'));
    } catch {
      pushToast(sessionId, 'warn', t('chat.lightbox.copyFailed'));
    }
  };
  const save = async (): Promise<void> => {
    const result = await ipc('native:save-attachment', {
      sessionId, attachmentId: current.id, suggestedName: current.name,
    });
    if (!result.ok) pushToast(sessionId, 'warn', t('chat.lightbox.saveFailed'));
    else if (result.value.path) pushToast(sessionId, 'info', t('chat.lightbox.saved'));
  };
  /** Put this picture into the message being written, as a NEW attachment (same limits as any other). */
  const attachAgain = (): void => {
    if (original.state !== 'ready') return;
    requestAttachFiles(sessionId, [new File([original.bytes], current.name, { type: original.mediaType })]);
    pushToast(sessionId, 'info', t('chat.lightbox.attachedAgain'));
  };
  const reveal = async (): Promise<void> => {
    const result = await ipc('native:reveal-attachment', { sessionId, attachmentId: current.id });
    if (!result.ok || !result.value.opened) pushToast(sessionId, 'warn', t('chat.lightbox.revealFailed'));
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) props.onClose(); }} title={current.name} size="lg">
      <div className="lightbox">
        <div className="lightbox-bar">
          <IconButton size="sm" label={t('chat.lightbox.prev')} disabled={images.length < 2} onClick={() => go(-1)}>
            <ChevronLeft size={16} strokeWidth={1.5} />
          </IconButton>
          <span className="lightbox-count" aria-live="polite">
            {t('chat.lightbox.counter', { n: (index ?? 0) + 1, total: images.length })}
          </span>
          <IconButton size="sm" label={t('chat.lightbox.next')} disabled={images.length < 2} onClick={() => go(1)}>
            <ChevronRight size={16} strokeWidth={1.5} />
          </IconButton>
          <span className="lightbox-spacer" />
          <IconButton size="sm" label={t(actual ? 'chat.lightbox.fit' : 'chat.lightbox.actual')}
            disabled={!ready} onClick={() => setActual((value) => !value)}>
            {actual ? <Minimize2 size={16} strokeWidth={1.5} /> : <Maximize2 size={16} strokeWidth={1.5} />}
          </IconButton>
          <IconButton size="sm" label={t('chat.lightbox.copy')} disabled={!ready} onClick={() => void copy()}>
            <Copy size={16} strokeWidth={1.5} />
          </IconButton>
          {attachmentsEnabled ? (
            <IconButton size="sm" label={t('chat.lightbox.attachAgain')} disabled={!ready} onClick={attachAgain}>
              <Paperclip size={16} strokeWidth={1.5} />
            </IconButton>
          ) : null}
          <IconButton size="sm" label={t('chat.lightbox.save')} disabled={!ready} onClick={() => void save()}>
            <Save size={16} strokeWidth={1.5} />
          </IconButton>
          <IconButton size="sm" label={t('chat.lightbox.reveal')} disabled={!ready} onClick={() => void reveal()}>
            <FolderOpen size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
        <div className="lightbox-stage" data-actual={actual ? 'true' : undefined}>
          {shown
            ? <img className="lightbox-img" src={shown} alt={current.name} data-original={ready ? 'true' : 'false'} />
            : null}
          {original.state === 'loading'
            ? <div className="lightbox-loading"><Skeleton width="60%" height={10} /><span className="sr-only">{t('chat.lightbox.loading')}</span></div>
            : null}
        </div>
        {original.state === 'missing' ? <p className="lightbox-note" role="status">{t('chat.lightbox.missing')}</p> : null}
      </div>
    </Dialog>
  );
}

/** What the composer's "Preview" shows: the picture exactly as it will be sent (already shrunk). */
export interface DraftPreview {
  name: string;
  bytes: ArrayBuffer;
  mediaType: string;
  width?: number;
  height?: number;
}

/**
 * The same viewer for a picture that is still in the tray. It needs no host round trip - the
 * bytes are in memory - and, like the entry variant, builds a `data:` URL: the page's CSP allows
 * `data:` for images and NOT `blob:`, so an object URL would render as a silent blank.
 * There is nothing to save or reveal yet (it is not an attachment of any message), so those two
 * buttons are simply absent.
 */
export function DraftLightbox(props: { sessionId: string; draft: DraftPreview | null; onClose(): void }) {
  const t = useT();
  const { draft, sessionId } = props;
  const src = useMemo(() => (draft ? dataUrlFor(draft.mediaType, draft.bytes) : null), [draft]);
  const [actual, setActual] = useState(false);
  useEffect(() => { setActual(false); }, [draft]);
  if (!draft) return null;

  const copy = async (): Promise<void> => {
    if (!src) { pushToast(sessionId, 'warn', t('chat.lightbox.copyFailed')); return; }
    try {
      const blob = await toPngBlob(src, draft.mediaType);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      pushToast(sessionId, 'info', t('chat.lightbox.copied'));
    } catch {
      pushToast(sessionId, 'warn', t('chat.lightbox.copyFailed'));
    }
  };
  const dims = draft.width && draft.height ? `${draft.width}×${draft.height}` : '';

  return (
    <Dialog open onOpenChange={(next) => { if (!next) props.onClose(); }} title={draft.name} size="lg">
      <div className="lightbox" data-variant="draft">
        <div className="lightbox-bar">
          <span className="lightbox-count">{dims}</span>
          <span className="lightbox-spacer" />
          <IconButton size="sm" label={t(actual ? 'chat.lightbox.fit' : 'chat.lightbox.actual')}
            disabled={!src} onClick={() => setActual((value) => !value)}>
            {actual ? <Minimize2 size={16} strokeWidth={1.5} /> : <Maximize2 size={16} strokeWidth={1.5} />}
          </IconButton>
          <IconButton size="sm" label={t('chat.lightbox.copy')} disabled={!src} onClick={() => void copy()}>
            <Copy size={16} strokeWidth={1.5} />
          </IconButton>
        </div>
        <div className="lightbox-stage" data-actual={actual ? 'true' : undefined}>
          {src ? <img className="lightbox-img" src={src} alt={draft.name} data-original="true" /> : null}
        </div>
        {!src ? <p className="lightbox-note" role="status">{t('chat.lightbox.missing')}</p> : null}
      </div>
    </Dialog>
  );
}
