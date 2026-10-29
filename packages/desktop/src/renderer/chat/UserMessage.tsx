/** `user` and `queued` entries: the right-aligned bubble, the invocation badge, the queue marker. */

import { X } from 'lucide-react';
import { memo, useState } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import { emitComposerIntent } from '../composer/composer-bus.js';
import { sessionStore } from '../store/session-store.js';
import { Badge, IconButton } from '../ui/primitives.js';
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

export const UserMessage = memo(function UserMessage(props: {
  sessionId: string; entry: UserEntry; queueNumber: number;
}) {
  const t = useT();
  const { entry, sessionId } = props;
  const [withdrawing, setWithdrawing] = useState(false);
  const queued = entry.kind === 'queued';

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
      <div className="bubble selectable">{entry.text}</div>
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
