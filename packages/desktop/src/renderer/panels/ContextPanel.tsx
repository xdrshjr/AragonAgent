/**
 * Inspector > Context: how full the model's window is, what the session has spent, and the
 * compaction history with "Compact now". A window the engine could not identify is marked as an
 * estimate (`~`), never presented as a measurement; an unknown cost is not shown as free.
 */

import { memo, useDeferredValue, useMemo } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { compactTokens, formatCost } from '../lib/time.js';
import { useSession } from '../store/session-store.js';
import { Badge, Button } from '../ui/primitives.js';
import { PanelBlock, PanelError, usePanelCommand } from './PanelBits.js';

type CompactionEntry = Extract<Entry, { kind: 'compaction' }>;

function Ring({ pct, label }: { pct: number; label: string }) {
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width="68" height="68" viewBox="0 0 68 68" role="img" aria-label={label} className="ctx-ring">
      <circle cx="34" cy="34" r={radius} className="ctx-ring-track" fill="none" strokeWidth="6" />
      <circle cx="34" cy="34" r={radius} className="ctx-ring-fill" fill="none" strokeWidth="6" strokeLinecap="round"
        strokeDasharray={`${(Math.min(100, pct) / 100) * circumference} ${circumference}`} transform="rotate(-90 34 34)" />
    </svg>
  );
}

const HistoryRow = memo(function HistoryRow({ entry }: { entry: CompactionEntry }) {
  const t = useT();
  return (
    <li className="ctx-hist">
      <div className="ctx-hist-head">
        <strong>{t('workspace.context.compactionN', { n: entry.index })}</strong>
        <Badge tone={entry.applied ? 'brand' : 'warning'}>{entry.applied ? t('workspace.context.applied') : t('workspace.context.declined')}</Badge>
        {entry.live ? <Badge tone="info">{t('workspace.context.running')}</Badge> : null}
      </div>
      <p className="panel-note">
        {t('workspace.context.tokens', { before: compactTokens(entry.tokensBefore), after: compactTokens(entry.tokensAfter) })}
        {` · ${t('workspace.context.messages', { before: entry.messagesBefore, after: entry.messagesAfter })}`}
      </p>
      {entry.reason ? <p className="panel-note selectable">{entry.reason}</p> : null}
      {entry.summary ? <details><summary>{t('workspace.context.summary')}</summary><p className="ctx-summary selectable">{entry.summary}</p></details> : null}
    </li>
  );
});

export function ContextPanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const context = useSession(sessionId, (mirror) => mirror?.view?.context);
  const usage = useSession(sessionId, (mirror) => mirror?.view?.usageTotal);
  const snapshot = useSession(sessionId, (mirror) => mirror?.view?.compaction ?? null);
  const running = useSession(sessionId, (mirror) => mirror?.view?.status === 'running');
  const entries = useSession(sessionId, (mirror) => mirror?.view?.entries);
  const deferred = useDeferredValue(entries);
  const history = useMemo(() => (deferred ?? []).filter((entry): entry is CompactionEntry => entry.kind === 'compaction').reverse(), [deferred]);
  const command = usePanelCommand(sessionId);
  if (!context || !usage) return null;

  const approx = !context.windowKnown || context.deltaTokens > 0;
  const pctText = `${approx ? '~' : ''}${context.pct}%`;
  const canCompact = !running && !snapshot?.inFlight && snapshot !== null && !snapshot.selfDisabled;
  const blockedKey = running ? 'workspace.context.blockedRunning' : snapshot?.selfDisabled ? 'workspace.context.blockedDisabled' : null;

  return (
    <div className="panel">
      <PanelBlock title={t('workspace.context.window')}>
        <div className="ctx-gauge">
          <Ring pct={context.pct} label={t('workspace.context.ringLabel', { pct: pctText })} />
          <div>
            <p className="ctx-pct">{pctText}</p>
            <p className="panel-note">{t('workspace.context.occupied', { used: compactTokens(context.occupied), window: compactTokens(context.window) })}</p>
            {!context.windowKnown ? <p className="panel-note">{t('workspace.context.windowUnknown')}</p> : null}
            {context.windowOverridden ? <p className="panel-note">{t('workspace.context.windowOverridden')}</p> : null}
          </div>
        </div>
      </PanelBlock>

      <PanelBlock title={t('workspace.context.usage')}>
        <dl className="ctx-usage">
          <dt>{t('workspace.context.input')}</dt><dd>{compactTokens(usage.inputTokens)}</dd>
          <dt>{t('workspace.context.output')}</dt><dd>{compactTokens(usage.outputTokens)}</dd>
          <dt>{t('workspace.context.cache')}</dt><dd>{compactTokens(usage.cacheReadTokens + usage.cacheWriteTokens)}</dd>
          <dt>{t('workspace.context.cost')}</dt><dd>{snapshot?.pricingUnknown && usage.costUsd === 0 ? '—' : formatCost(usage.costUsd)}</dd>
        </dl>
      </PanelBlock>

      <PanelBlock title={t('workspace.context.compaction')}
        aside={snapshot ? t('workspace.context.reclaimed', { tokens: compactTokens(snapshot.tokensReclaimed) }) : undefined}>
        {snapshot === null ? <p className="panel-note">{t('workspace.context.compactionOff')}</p> : null}
        <div className="panel-actions">
          <Button size="sm" variant="primary" disabled={!canCompact || command.busy} onClick={() => void command.run({ c: 'compact' })}>
            {t('workspace.context.compactNow')}
          </Button>
          {snapshot?.inFlight ? <Button size="sm" onClick={() => void command.run({ c: 'compact.cancel' })}>{t('workspace.context.cancel')}</Button> : null}
        </div>
        {blockedKey ? <p className="panel-note">{t(blockedKey)}</p> : null}
        <PanelError message={command.error} />
        {history.length === 0 ? <p className="panel-note">{t('workspace.context.noHistory')}</p> : (
          <ul className="ctx-hist-list">{history.map((entry) => <HistoryRow key={entry.id} entry={entry} />)}</ul>
        )}
      </PanelBlock>
    </div>
  );
}
