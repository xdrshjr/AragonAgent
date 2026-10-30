/** The strip of attachment chips above the text box, with the token note for pictures. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { estimateImageTokens } from '../../../shared/attachments.js';
import { DraftLightbox } from '../../chat/ImageLightbox.js';
import { useT } from '../../i18n/index.js';
import type { ImageMode } from '../../../shared/attachments.js';
import type { AttachmentDraft } from './attachment-draft-store.js';
import { AttachmentChip } from './AttachmentChip.js';

/** Roughly what the pictures cost the model; a note, not a bill (the host declares the cap). */
export function totalImageTokens(items: readonly AttachmentDraft[], cap: number): number {
  return items
    .filter((item) => item.kind === 'image' && item.status === 'ready')
    .reduce((sum, item) => sum + estimateImageTokens(item.width ?? 0, item.height ?? 0, cap), 0);
}

/**
 * A polite announcement when the tray changes, for people who cannot see it change. It lives
 * outside the "empty" early return below on purpose: a live region must already be in the page when
 * its text changes, and removing the last chip empties the tray (which is also when "0 attachments"
 * matters most to hear). Nothing is said for the first render, so a reload does not announce.
 */
function useTrayAnnouncement(items: readonly AttachmentDraft[]): string {
  const t = useT();
  const previous = useRef<readonly AttachmentDraft[] | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const before = previous.current;
    previous.current = items;
    if (before === null) return;
    const total = items.filter((item) => item.status !== 'error').length;
    const added = items.find((item) => !before.some((old) => old.localId === item.localId));
    if (added) setMessage(t('chat.attach.announceAdded', { name: added.name, total }));
    else if (items.length < before.length) setMessage(t('chat.attach.announceRemoved', { total }));
  }, [items, t]);
  return message;
}

export function AttachmentTray(props: {
  sessionId: string;
  items: readonly AttachmentDraft[];
  mode: ImageMode;
  tokenEstimate: number;
  onReference(ref: string): void;
  onRemove(ref: string): void;
  onRetry(ref: string): void;
  /** Where focus goes when the last chip is removed with the keyboard. */
  focusInput(): void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  // Radix returns focus to a Dialog.Trigger only; this one is opened from a chip button, so the
  // opener is remembered and refocused after close (same approach as the message lightbox).
  const opener = useRef<HTMLElement | null>(null);
  const previewed = previewId === null ? undefined : props.items.find((item) => item.localId === previewId);
  // Stable between renders: the viewer turns the bytes into a `data:` URL, which is not free.
  const draftPreview = useMemo(() => (previewed?.bytes && previewed.declaredMediaType ? {
    name: previewed.name, bytes: previewed.bytes, mediaType: previewed.declaredMediaType,
    ...(previewed.width ? { width: previewed.width } : {}), ...(previewed.height ? { height: previewed.height } : {}),
  } : null), [previewed?.localId, previewed?.bytes, previewed?.declaredMediaType]); // eslint-disable-line react-hooks/exhaustive-deps
  const announcement = useTrayAnnouncement(props.items);
  const live = <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>;
  if (props.items.length === 0) return live;
  const closePreview = (): void => {
    setPreviewId(null);
    const target = opener.current;
    setTimeout(() => { if (target?.isConnected) target.focus(); }, 0);
  };
  const openPreview = (localId: string, from: HTMLElement): void => {
    opener.current = from;
    setPreviewId(localId);
  };
  const images = props.items.filter((item) => item.kind === 'image' && item.status === 'ready');
  const tokens = props.mode === 'inline' ? totalImageTokens(props.items, props.tokenEstimate) : 0;

  const removeByKey = (ref: string, element: HTMLElement): void => {
    const chips = [...(listRef.current?.querySelectorAll<HTMLElement>('.att-chip') ?? [])];
    const at = chips.indexOf(element);
    const neighbour = chips[at + 1] ?? chips[at - 1];
    props.onRemove(ref);
    if (neighbour) neighbour.focus(); else props.focusInput();
  };

  return (
    <div className="att-tray">
      {live}
      <div ref={listRef} className="att-list" role="list" aria-label={t('chat.attach.trayLabel')}>
        {props.items.map((item) => (
          <AttachmentChip key={item.localId} item={item} onReference={props.onReference}
            onRemove={props.onRemove} onRetry={props.onRetry} onPreview={openPreview} onKeyRemove={removeByKey} />
        ))}
      </div>
      <DraftLightbox sessionId={props.sessionId} onClose={closePreview} draft={draftPreview} />
      {images.length > 0 && tokens > 0 ? (
        <div className="att-note" title={t('chat.attach.tokensTitle')}>
          {t('chat.attach.tokens', { n: images.length, tokens: tokens.toLocaleString() })}
        </div>
      ) : null}
    </div>
  );
}
