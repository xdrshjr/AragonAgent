/** A message that was sent but is not in the transcript yet: grey while sending, red-edged if it failed. */

import { memo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import { emitComposerIntent } from '../composer/composer-bus.js';
import { sessionStore, type PendingSend } from '../store/session-store.js';
import { Button } from '../ui/primitives.js';

export const PendingSendRow = memo(function PendingSendRow({ sessionId, send }: { sessionId: string; send: PendingSend }) {
  const t = useT();
  const [retrying, setRetrying] = useState(false);
  const failed = send.state === 'failed';

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
