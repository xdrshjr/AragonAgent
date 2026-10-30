/**
 * The attachments under a user bubble: a fixed-height row of thumbnails (so the virtual list's
 * height estimate holds), then small pills for files and folders. Shows metadata only - the
 * thumbnails are the tiny data URLs stored on the entry, never the original bytes.
 */

import { FileText, Folder, ImageOff } from 'lucide-react';
import { memo } from 'react';
import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';
import { useT } from '../i18n/index.js';
import { formatBytes } from '../../shared/attachments.js';

const MAX_THUMBS = 4;
const MAX_PILLS = 4;

export const AttachmentStrip = memo(function AttachmentStrip(props: {
  attachments: readonly AttachmentMeta[];
  /** Open the lightbox on the Nth IMAGE of this message. */
  onOpenImage(imageIndex: number): void;
  onRevealFile(attachment: AttachmentMeta): void;
}) {
  const t = useT();
  const images = props.attachments.filter((a) => a.kind === 'image');
  const others = props.attachments.filter((a) => a.kind !== 'image');
  if (images.length === 0 && others.length === 0) return null;
  const shown = images.slice(0, MAX_THUMBS);
  const hiddenImages = images.length - shown.length;
  const pills = others.slice(0, MAX_PILLS);
  const hiddenPills = others.length - pills.length;

  return (
    <div className="att-strip" role="group" aria-label={t('chat.att.strip')}>
      {shown.length > 0 ? (
        <div className="att-thumbs">
          {shown.map((a, index) => {
            const last = index === shown.length - 1 && hiddenImages > 0;
            return (
              <button key={a.id} type="button" className="att-thumb" data-sent={a.sent}
                aria-label={t('chat.att.open', { name: a.name })} title={a.name}
                onClick={() => props.onOpenImage(index)}>
                {a.thumb
                  ? <img src={a.thumb} alt={a.name} draggable={false} />
                  : <span className="att-thumb-empty" aria-hidden="true"><ImageOff size={20} strokeWidth={1.5} /></span>}
                {a.sent === 'path' ? (
                  <span className="att-path-mark" title={t('chat.att.pathMark')} role="img"
                    aria-label={t('chat.att.pathMark')}>↗</span>
                ) : null}
                {last ? <span className="att-more" aria-hidden="true">{t('chat.att.more', { n: hiddenImages })}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {pills.length > 0 ? (
        <div className="att-pills">
          {pills.map((a) => (
            <button key={a.id} type="button" className="att-pill-file" title={a.name}
              aria-label={t(a.kind === 'folder' ? 'chat.att.folder' : 'chat.att.file', { name: a.name })}
              onClick={() => props.onRevealFile(a)}>
              {a.kind === 'folder' ? <Folder size={14} strokeWidth={1.5} aria-hidden="true" /> : <FileText size={14} strokeWidth={1.5} aria-hidden="true" />}
              <span className="att-pill-name">{a.name}</span>
              {a.kind === 'file' && a.size > 0 ? <span className="att-pill-size">{formatBytes(a.size)}</span> : null}
            </button>
          ))}
          {hiddenPills > 0 ? <span className="att-pill-more">{t('chat.att.more', { n: hiddenPills })}</span> : null}
        </div>
      ) : null}
    </div>
  );
});
