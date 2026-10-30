/** A message that was sent but is not in the transcript yet: grey while sending, red-edged if it failed. */

import { memo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import { emitComposerIntent } from '../composer/composer-bus.js';
import { sessionStore, type PendingSend } from '../store/session-store.js';
import { Button } from '../ui/primitives.js';

/** What the strip needs from a draft attachment; read defensively, the draft type lives elsewhere. */
interface PendingAttachmentView { key: string; name: string; kind: string; thumb?: string; failed: boolean }

function pendingAttachments(send: PendingSend): PendingAttachmentView[] {
  const raw = (send as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index): PendingAttachmentView[] => {
    if (typeof item !== 'object' || item === null) return [];
    const draft = item as Record<string, unknown>;
    const name = typeof draft.name === 'string' ? draft.name : '';
    const thumb = typeof draft.thumb === 'string' && draft.thumb.startsWith('data:image/') ? draft.thumb
      : typeof draft.previewUrl === 'string' && draft.previewUrl.startsWith('data:image/') ? draft.previewUrl : undefined;
    return [{
      key: typeof draft.ref === 'string' ? draft.ref : String(index), name,
      kind: typeof draft.kind === 'string' ? draft.kind : 'file',
      ...(thumb ? { thumb } : {}), failed: draft.status === 'error',
    }];
  });
}

export const PendingSendRow = memo(function PendingSendRow({ sessionId, send }: { sessionId: string; send: PendingSend }) {
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  const failed = send.state === 'failed';
  const attachments = pendingAttachments(send);

  const retry = async (): Promise<void> => {
    setRetrying(true);
    await sessionStore.retrySend(sessionId, send.localId);
    setRetrying(false);
  };
  const edit = (): void => {
    const text = sessionStore.takePendingSend(sessionId, send.localId);
    if (text !== null) emitComposerIntent('restore-text', text);
  };

  return (
    <div className="msg msg-user" data-pending={failed ? 'failed' : 'sending'} aria-busy={!failed}>
      <div className="bubble selectable">{send.text}</div>
      {attachments.length > 0 ? (
        <div className="att-strip att-strip-pending" role="group" aria-label={t('chat.att.strip')}>
          {attachments.map((item) => (
            <span key={item.key} className="att-thumb att-thumb-static" data-failed={item.failed ? 'true' : undefined} title={item.name}>
              {item.thumb ? <img src={item.thumb} alt={item.name} draggable={false} /> : <span className="att-pill-name">{item.name}</span>}
            </span>
          ))}
        </div>
      ) : null}
      <div className="queue-mark">
        {failed ? (
          <>
            <span role="alert">
              {t('chat.send.failed')} {send.error ? describeFailure(t, { ok: false, code: send.error.code as never, message: send.error.message }) : ''}
            </span>
            <Button size="sm" disabled={retrying} onClick={() => void retry()}>{t('chat.send.retry')}</Button>
            <Button size="sm" onClick={edit}>{t('chat.send.edit')}</Button>
          </>
        ) : <span role="status">{t('chat.send.sending')}</span>}
      </div>
    </div>
  );
});
