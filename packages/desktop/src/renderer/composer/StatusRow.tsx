/** The row under the input box: [+], MODE, MODEL, CONTEXT, COST, and the Send/Queue + Stop buttons. */

import { ArrowUp, Square } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { Button } from '../ui/primitives.js';
import { ContextGauge, CostBadge } from './ContextGauge.js';
import { ModeChip } from './ModeChip.js';
import { ModelChip } from './ModelChip.js';
import { PlusMenu } from './PlusMenu.js';

export function StatusRow(props: {
  sessionId: string;
  running: boolean;
  canSend: boolean;
  /** Why Send is unavailable even though there is content (attachments still processing / failed). */
  blockedReason?: string | null;
  sending: boolean;
  enterToSend: boolean;
  onSend(): void;
  onStop(): void;
}) {
  const t = useT();
  const sendHint = props.enterToSend ? t('chat.send.hintEnter') : t('chat.send.hintCtrlEnter');
  return (
    <div className="status-row">
      <PlusMenu sessionId={props.sessionId} />
      <ModeChip sessionId={props.sessionId} />
      <ModelChip sessionId={props.sessionId} />
      <span className="status-spacer" />
      <ContextGauge sessionId={props.sessionId} />
      <CostBadge sessionId={props.sessionId} />
      {props.running ? (
        <Button variant="danger" size="sm" onClick={props.onStop} title={t('chat.stop.hint')}>
          <Square size={12} strokeWidth={1.5} aria-hidden="true" /> {t('chat.stop')}
        </Button>
      ) : null}
      <Button variant="primary" size="sm" aria-disabled={!props.canSend || props.sending}
        title={props.blockedReason ?? sendHint}
        onClick={() => { if (props.canSend && !props.sending) props.onSend(); }}>
        <ArrowUp size={14} strokeWidth={1.5} aria-hidden="true" /> {props.running ? t('chat.queue') : t('chat.send')}
      </Button>
    </div>
  );
}
