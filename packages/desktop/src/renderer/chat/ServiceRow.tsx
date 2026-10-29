/** `service` entries: a background job row with its status, a log tail, and a Stop button. */

import { memo, useState } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { isTerminalStatus } from '@aragon-agent/tui/model/proc/types';
import { useT } from '../i18n/index.js';
import { clip } from '../lib/chat-format.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore } from '../store/session-store.js';
import { Button, StatusDot, type DotKind } from '../ui/primitives.js';
import { AnsiOutput } from './tools/AnsiOutput.js';
import { pushToast } from './hooks.js';

type ServiceEntry = Extract<Entry, { kind: 'service' }>;

const TAIL_ROWS = 4;

function dotFor(entry: ServiceEntry): DotKind {
  switch (entry.status) {
    case 'starting': return 'waiting';
    case 'ready': return 'ready';
    case 'running': return 'running';
    case 'failed': return 'error';
    case 'exited': return entry.exitCode === 0 ? 'idle' : 'error';
    case 'stopped': return 'idle';
  }
}

export const ServiceRow = memo(function ServiceRow({ sessionId, entry }: { sessionId: string; entry: ServiceEntry }) {
  const t = useT();
  const [stopping, setStopping] = useState(false);
  const terminal = isTerminalStatus(entry.status);
  const statusLabel = t(`chat.service.status.${entry.status}` as const);

  const stop = async (): Promise<void> => {
    setStopping(true);
    const result = await sessionStore.command(sessionId, { c: 'service.stop', id: entry.serviceId });
    setStopping(false);
    if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
  };

  return (
    <div className="service" data-terminal={terminal ? 'true' : undefined}>
      <div className="service-line">
        <StatusDot kind={dotFor(entry)} label={statusLabel} />
        <span className="service-id">{entry.serviceId}</span>
        <code className="service-command" title={entry.command}>{clip(entry.command, 90)}</code>
        <span className="service-status">{statusLabel}{entry.port ? ` · :${entry.port}` : ''}</span>
        {entry.pid !== undefined ? <span className="service-pid" title={t('chat.service.pid')}>pid {entry.pid}</span> : null}
        {!terminal ? (
          <Button size="sm" disabled={stopping} onClick={() => void stop()}>{t('chat.service.stop')}</Button>
        ) : null}
      </div>
      {entry.progress ? <div className="service-progress">{entry.progress}</div> : null}
      {entry.rows.length > 0 ? <AnsiOutput rows={entry.rows} tail={TAIL_ROWS} label={t('chat.service.log')} /> : null}
    </div>
  );
});
