/** `compaction` entries: a divider-style event that expands to the reason and details. */

import { ChevronRight } from 'lucide-react';
import { memo, useState } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { formatSeconds, formatTokenCount } from '../lib/chat-format.js';
import { modeLabel, phaseLabel, reasonLabel, triggerLabel } from '../lib/engine-labels.js';

type CompactionEntry = Extract<Entry, { kind: 'compaction' }>;

export const CompactionRow = memo(function CompactionRow({ entry }: { entry: CompactionEntry }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const reclaimed = Math.max(0, entry.tokensBefore - entry.tokensAfter);
  const reason = entry.reason ? reasonLabel(entry.reason) : null;
  let title: string;
  if (entry.live) title = t('chat.compaction.live', { phase: entry.phase ? phaseLabel(t, entry.phase) : '' });
  else if (entry.applied) title = t('chat.compaction.done', { n: formatTokenCount(reclaimed) });
  else title = t('chat.compaction.skipped');
  return (
    <div className="compaction" data-applied={entry.applied ? 'true' : undefined}>
      <button type="button" className="compaction-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="rule" aria-hidden="true" />
        <ChevronRight size={14} strokeWidth={1.5} className="chev" aria-hidden="true" />
        <span>{title}</span>
        <span className="rule" aria-hidden="true" />
      </button>
      {open ? (
        <div className="compaction-body selectable">
          {reason ? <p>{reason.text}{reason.action ? ` (${reason.action})` : ''}</p> : null}
          <dl>
            <dt>{t('engine.compaction.label.trigger')}</dt>
            <dd>{triggerLabel(t, entry.trigger)}</dd>
            <dt>{t('engine.compaction.label.mode')}</dt>
            <dd>{modeLabel(t, entry.mode)}</dd>
            <dt>{t('chat.compaction.tokens')}</dt>
            <dd>{formatTokenCount(entry.tokensBefore)} {'→'} {formatTokenCount(entry.tokensAfter)}</dd>
            <dt>{t('chat.compaction.messages')}</dt>
            <dd>{entry.messagesBefore} {'→'} {entry.messagesAfter}</dd>
            <dt>{t('chat.compaction.model')}</dt>
            <dd>{entry.model}</dd>
            {entry.durationMs !== undefined ? <><dt>{t('chat.compaction.duration')}</dt><dd>{formatSeconds(entry.durationMs)}</dd></> : null}
          </dl>
          {entry.summary ? <pre className="compaction-summary">{entry.summary}</pre> : null}
        </div>
      ) : null}
    </div>
  );
});
