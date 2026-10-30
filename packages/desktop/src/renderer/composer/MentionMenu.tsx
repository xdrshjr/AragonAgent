/** The `@` menu: the attachments of this message first, then file paths from the host's bounded search. */

import { File as FileIcon, Folder, Image as ImageIcon } from 'lucide-react';
import { useT } from '../i18n/index.js';
import type { AttachmentDraft } from './attachments/attachment-draft-store.js';

export const MENTION_LISTBOX_ID = 'composer-mention-listbox';
export const mentionOptionId = (index: number): string => `composer-mention-option-${index}`;

export type MentionState =
  | { status: 'idle' | 'loading'; paths: string[]; truncated: boolean }
  | { status: 'ready'; paths: string[]; truncated: boolean }
  | { status: 'error'; paths: string[]; truncated: boolean; message: string };

export function MentionMenu(props: {
  state: MentionState;
  /** Attachments matching the query; their rows come first and use the first indexes. */
  attachments?: AttachmentDraft[];
  index: number;
  onHover(index: number): void;
  onPick(path: string): void;
  onPickAttachment?(ref: string): void;
}) {
  const t = useT();
  const { state } = props;
  const attachments = props.attachments ?? [];
  if (attachments.length === 0) {
    if (state.status === 'error') return <div className="popup" role="alert">{state.message}</div>;
    if (state.paths.length === 0) {
      return <div className="popup" role="status">{state.status === 'ready' ? t('chat.mention.none') : t('chat.mention.searching')}</div>;
    }
  }
  return (
    <div className="popup" role="listbox" id={MENTION_LISTBOX_ID} aria-label={t('chat.mention.label')}>
      {attachments.length > 0 ? <div className="popup-group" role="presentation">{t('chat.attach.mentionGroup')}</div> : null}
      {attachments.map((item, index) => {
        const Icon = item.kind === 'folder' ? Folder : item.kind === 'image' ? ImageIcon : FileIcon;
        return (
          <div key={item.localId} id={mentionOptionId(index)} role="option" aria-selected={index === props.index}
            className="popup-item" data-active={index === props.index ? 'true' : undefined}
            onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => props.onHover(index)}
            onClick={() => props.onPickAttachment?.(item.ref)}>
            {item.previewUrl ? <img className="att-mention-thumb" src={item.previewUrl} alt="" /> : <Icon size={14} strokeWidth={1.5} aria-hidden="true" />}
            <span className="popup-name">@{item.ref}</span>
            <span className="popup-hint">{item.name}</span>
          </div>
        );
      })}
      {attachments.length > 0 && state.paths.length > 0 ? <div className="popup-group" role="presentation">{t('chat.attach.mentionFiles')}</div> : null}
      {state.paths.map((path, offset) => {
        const index = attachments.length + offset;
        return (
          <div key={path} id={mentionOptionId(index)} role="option" aria-selected={index === props.index}
            className="popup-item" data-active={index === props.index ? 'true' : undefined}
            onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => props.onHover(index)}
            onClick={() => props.onPick(path)}>
            <span className="popup-name popup-path" title={path}>{path}</span>
          </div>
        );
      })}
      {state.truncated ? <div className="popup-foot" role="presentation">{t('chat.mention.truncated')}</div> : null}
    </div>
  );
}
