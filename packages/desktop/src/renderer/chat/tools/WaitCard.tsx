/** The live view of a running `job_wait`: what it waits for, how far along, how long. */

import type { WaitView } from '@aragon-agent/tui/model/proc/wait-view';
import { useT } from '../../i18n/index.js';
import { formatSeconds } from '../../lib/chat-format.js';
import { useNow } from '../hooks.js';

export function WaitCard({ view }: { view: WaitView }) {
  const t = useT();
  const now = useNow(true);
  const elapsed = Math.max(0, now - view.waitStartedAt);
  const fraction = view.progress?.fraction ?? null;
  return (
    <div className="wait-card">
      <div className="wait-line">
        <strong>{view.jobLabel}</strong>
        {view.command ? <code className="wait-command">{view.command}</code> : null}
        <span className="wait-status">{t(`chat.service.status.${view.status}` as const)}</span>
      </div>
      {fraction !== null ? (
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)} aria-label={view.progress?.text ?? t('chat.wait.progress')}>
          <div className="progress-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
        </div>
      ) : null}
      {view.progress ? <div className="wait-row">{view.progress.text}</div> : null}
      {view.lastRow ? <div className="wait-row wait-last">{view.lastRow}</div> : null}
      <div className="wait-row">
        {t('chat.wait.elapsed', { elapsed: formatSeconds(elapsed), total: formatSeconds(view.upToMs) })}
        {view.stalled ? <span className="wait-stalled"> {t('chat.wait.stalled', { s: view.stallSeconds })}</span> : null}
      </div>
    </div>
  );
}
