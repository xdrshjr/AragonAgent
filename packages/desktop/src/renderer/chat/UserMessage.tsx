/** `user` and `queued` entries: the right-aligned bubble, the invocation badge, the queue marker. */

import { FileText, Folder, Image as ImageIcon, X } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import type { AttachmentMeta } from '@aragon-agent/tui/model/agent/attachment-meta';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { splitMentions } from '../lib/attachment-text.js';
import { describeFailure } from '../lib/chat-results.js';
import { emitComposerIntent } from '../composer/composer-bus.js';
import { sessionStore } from '../store/session-store.js';
import { Badge, IconButton } from '../ui/primitives.js';
import { AttachmentStrip } from './AttachmentStrip.js';
import { ImageLightbox } from './ImageLightbox.js';
import { pushToast } from './hooks.js';

type UserEntry = Extract<Entry, { kind: 'user' | 'queued' }>;

function InvocationBadge({ entry }: { entry: UserEntry }) {
  const card = entry.invocation;
  if (!card) return null;
  const label = card.name ? `${card.variant} · ${card.name}` : card.variant;
  return (
    <div className="invocation">
      <Badge tone="info">{label}</Badge>
      {card.facts.map((fact) => <Badge key={fact}>{fact}</Badge>)}
    </div>
  );
}

/** The bubble text with `@imageN` mentions turned into pills; the entry's own text is untouched. */
function BubbleText(props: {
  text: string; attachments: readonly AttachmentMeta[] | undefined; onPick(attachment: AttachmentMeta): void;
}) {
  const t = useT();
  const segments = useMemo(() => splitMentions(props.text, props.attachments), [props.text, props.attachments]);
  if (segments.length === 1 && segments[0]?.kind === 'text') return <>{props.text}</>;
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'text') return segment.text;
        const { attachment } = segment;
        const Icon = attachment.kind === 'image' ? ImageIcon : attachment.kind === 'folder' ? Folder : FileText;
        return (
          <button key={index} type="button" className="att-pill" title={attachment.name}
            aria-label={t('chat.att.open', { name: attachment.name })}
            onClick={() => props.onPick(attachment)}>
            <Icon size={12} strokeWidth={1.5} aria-hidden="true" />@{segment.ref}
            {attachment.thumb ? <span className="att-pill-pop" aria-hidden="true"><img src={attachment.thumb} alt="" /></span> : null}
          </button>
        );
      })}
    </>
  );
}

export const UserMessage = memo(function UserMessage(props: {
  sessionId: string; entry: UserEntry; queueNumber: number;
}) {
  const t = useT();
  const { entry, sessionId } = props;
  const [withdrawing, setWithdrawing] = useState(false);
  const [lightbox, setLightbox] = useState<number | null>(null);
  // Radix returns focus to a Dialog.Trigger only, and this dialog is opened from several places
  // (thumbnail, mention pill), so the opener is remembered here and refocused on close.
  const opener = useRef<HTMLElement | null>(null);
  const openLightbox = (index: number): void => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLightbox(index);
  };
  const closeLightbox = (): void => {
    setLightbox(null);
    const target = opener.current;
    setTimeout(() => { if (target?.isConnected) target.focus(); }, 0);
  };
  const queued = entry.kind === 'queued';
  const attachments = entry.attachments;
  const images = useMemo(() => (attachments ?? []).filter((a) => a.kind === 'image'), [attachments]);

  const reveal = (attachment: AttachmentMeta): void => {
    void ipc('native:reveal-attachment', { sessionId, attachmentId: attachment.id }).then((result) => {
      if (!result.ok || !result.value.opened) pushToast(sessionId, 'info', t('chat.att.unavailable'));
    });
  };
  const pick = (attachment: AttachmentMeta): void => {
    if (attachment.kind === 'image') openLightbox(Math.max(0, images.findIndex((a) => a.id === attachment.id)));
    else reveal(attachment);
  };

  const withdraw = async (): Promise<void> => {
    if (entry.kind !== 'queued' || !entry.queueId) return;
    setWithdrawing(true);
    const result = await sessionStore.command(sessionId, { c: 'queue.cancel', queueId: entry.queueId });
    setWithdrawing(false);
    if (result.ok) {
      const text = (result.value as { text?: string } | undefined)?.text;
      if (text) emitComposerIntent('restore-text', text);
      return;
    }
    // Losing the race with the engine is a normal outcome, not an error: neutral toast, no red.
    const neutral = result.code === 'already_delivered' || result.code === 'not_found';
    pushToast(sessionId, neutral ? 'info' : 'warn', describeFailure(t, result));
  };

  return (
    <div className="msg msg-user" data-queued={queued ? 'true' : undefined}>
      <InvocationBadge entry={entry} />
      <div className="bubble selectable"><BubbleText text={entry.text} attachments={attachments} onPick={pick} /></div>
      {attachments && attachments.length > 0 ? (
        <AttachmentStrip attachments={attachments} onOpenImage={openLightbox} onRevealFile={reveal} />
      ) : null}
      {images.length > 0 ? (
        <ImageLightbox sessionId={sessionId} images={images} index={lightbox}
          onIndexChange={setLightbox} onClose={closeLightbox} />
      ) : null}
      {queued ? (
        <div className="queue-mark">
          <span>{t('chat.queued', { n: props.queueNumber })}</span>
          {entry.kind === 'queued' && entry.queueId ? (
            <IconButton size="sm" label={t('chat.queued.withdraw')} disabled={withdrawing} onClick={() => void withdraw()}>
              <X size={14} strokeWidth={1.5} />
            </IconButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
