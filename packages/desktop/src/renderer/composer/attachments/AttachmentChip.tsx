/**
 * One attachment in the tray: thumbnail or icon, name, size, state, and the verbs on it.
 *
 * The chip is a focus group (`tabIndex=0`): Delete / Backspace on it removes it and the tray
 * moves focus to the neighbour. State is never carried by colour alone - processing and failure
 * each have a word and an icon.
 */

import { AlertCircle, AtSign, Eye, File as FileIcon, Folder, Image as ImageIcon, Loader2, RotateCw, X } from 'lucide-react';
import { memo, type KeyboardEvent } from 'react';
import { formatBytes } from '../../../shared/attachments.js';
import { useT, type Translate } from '../../i18n/index.js';
import { IconButton } from '../../ui/primitives.js';
import type { AttachmentDraft, DraftError } from './attachment-draft-store.js';
import { isPathOnlyImageFormat } from './image-formats.js';

export function errorText(t: Translate, error: DraftError | undefined): string {
  switch (error) {
    case 'too_large': return t('chat.attach.err.tooLarge');
    case 'bad_type': return t('chat.attach.err.badType');
    case 'path_missing': return t('chat.attach.err.pathMissing');
    case 'decode_failed':
    default: return t('chat.attach.err.decode');
  }
}

function Thumb({ item }: { item: AttachmentDraft }) {
  if (item.kind === 'image' && item.previewUrl) {
    const alt = item.width && item.height ? `${item.name}, ${item.width}×${item.height}` : item.name;
    return <img className="att-thumb" src={item.previewUrl} alt={alt} draggable={false} />;
  }
  const Icon = item.kind === 'folder' ? Folder : item.kind === 'image' ? ImageIcon : FileIcon;
  return <span className="att-thumb att-thumb-icon" aria-hidden="true"><Icon size={18} strokeWidth={1.5} /></span>;
}

export const AttachmentChip = memo(function AttachmentChip(props: {
  item: AttachmentDraft;
  onReference(ref: string): void;
  onRemove(ref: string): void;
  onRetry(ref: string): void;
  /** Open the picture as it will be sent; the opener is the button that was clicked. */
  onPreview(localId: string, opener: HTMLElement): void;
  onKeyRemove(ref: string, element: HTMLElement): void;
}) {
  const t = useT();
  const { item } = props;
  const dims = item.width && item.height ? ` ${item.width}x${item.height}` : '';
  const label = t('chat.attach.chipLabel', { ref: item.ref, name: item.name }) + dims;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return; // a button inside keeps its own keys
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      props.onKeyRemove(item.ref, event.currentTarget);
    }
  };
  return (
    <div className="att-chip" role="listitem" tabIndex={0} aria-label={label} data-status={item.status}
      data-kind={item.kind} onKeyDown={onKeyDown}>
      <Thumb item={item} />
      <div className="att-meta">
        <span className="att-name" title={item.path ?? item.name}>{item.name}</span>
        <span className="att-sub">
          <code className="att-ref">{item.ref}</code>
          {item.status === 'processing' ? (
            <span className="att-state" role="status"><Loader2 size={12} className="att-spin" aria-hidden="true" /> {t('chat.attach.processing')}</span>
          ) : null}
          {item.status === 'error' ? (
            <span className="att-state att-error" role="alert"><AlertCircle size={12} aria-hidden="true" /> {errorText(t, item.error)}</span>
          ) : null}
          {item.status === 'ready' && item.size > 0 ? <span>{formatBytes(item.size)}</span> : null}
          {item.kind === 'file' && isPathOnlyImageFormat(item.name)
            ? <span className="att-pathonly" title={t('chat.attach.pathOnlyFormat')}>{t('chat.attach.pathOnlyFormat')}</span> : null}
          {item.firstFrameOnly ? <span title={t('chat.attach.firstFrame')}>{t('chat.attach.firstFrameShort')}</span> : null}
        </span>
      </div>
      <div className="att-actions">
        {item.status === 'error' && item.kind === 'image' ? (
          <IconButton size="sm" label={t('chat.attach.retry', { name: item.name })} onClick={() => props.onRetry(item.ref)}>
            <RotateCw size={14} strokeWidth={1.5} />
          </IconButton>
        ) : null}
        {item.status === 'ready' && item.kind === 'image' && item.bytes ? (
          <IconButton size="sm" label={t('chat.attach.preview', { name: item.name })}
            onClick={(event) => props.onPreview(item.localId, event.currentTarget)}>
            <Eye size={14} strokeWidth={1.5} />
          </IconButton>
        ) : null}
        {item.status === 'ready' ? (
          <IconButton size="sm" label={t('chat.attach.reference', { ref: item.ref })} onClick={() => props.onReference(item.ref)}>
            <AtSign size={14} strokeWidth={1.5} />
          </IconButton>
        ) : null}
        <IconButton size="sm" label={t('chat.attach.remove', { name: item.name })} onClick={() => props.onRemove(item.ref)}>
          <X size={14} strokeWidth={1.5} />
        </IconButton>
      </div>
    </div>
  );
});
