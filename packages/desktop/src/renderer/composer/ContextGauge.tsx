/** The CONTEXT ring and the COST badge. Unknown is shown as unknown, never as zero. */

import { useT } from '../i18n/index.js';
import { pushToast } from '../chat/hooks.js';
import { contextPercent, formatCostBadge, formatTokenCount } from '../lib/chat-format.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore, useSession } from '../store/session-store.js';
import { Button } from '../ui/primitives.js';
import { Popover } from '../ui/overlay.js';

const RADIUS = 6;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function Ring({ percent }: { percent: number | null }) {
  const offset = CIRCUMFERENCE * (1 - (percent ?? 0) / 100);
  const level = percent === null ? 'unknown' : percent >= 95 ? 'danger' : percent >= 80 ? 'warn' : 'ok';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" className="ring" data-level={level} aria-hidden="true">
      <circle cx="8" cy="8" r={RADIUS} className="ring-track" fill="none" strokeWidth="2" />
      {percent !== null ? (
        <circle cx="8" cy="8" r={RADIUS} className="ring-fill" fill="none" strokeWidth="2" strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE} strokeDashoffset={offset} transform="rotate(-90 8 8)" />
      ) : null}
    </svg>
  );
}

export function ContextGauge({ sessionId }: { sessionId: string }) {
  const t = useT();
  const pct = useSession(sessionId, (mirror) => mirror?.view?.context.pct) ?? 0;
  const known = useSession(sessionId, (mirror) => mirror?.view?.context.windowKnown) === true;
  const occupied = useSession(sessionId, (mirror) => mirror?.view?.context.occupied) ?? 0;
  const windowTokens = useSession(sessionId, (mirror) => mirror?.view?.context.window) ?? 0;
  const estimated = (useSession(sessionId, (mirror) => mirror?.view?.context.deltaTokens) ?? 0) > 0;
  const percent = contextPercent({ pct, windowKnown: known });

  const compact = async (): Promise<void> => {
    const result = await sessionStore.command(sessionId, { c: 'compact' });
    if (!result.ok) pushToast(sessionId, 'warn', describeFailure(t, result));
  };

  return (
    <Popover side="top" align="end"
      trigger={(
        <button type="button" className="status-chip" data-kind="context" aria-label={t('chat.context.label')}>
          <Ring percent={percent} />
          <span>{percent === null ? '?' : `${percent}%`}</span>
        </button>
      )}>
      <div className="model-pop">
        <div className="pop-title">{t('chat.context.title')}</div>
        <dl className="pop-facts">
          <dt>{t('chat.context.used')}</dt>
          <dd>{formatTokenCount(occupied)}{estimated ? ` (${t('chat.context.estimated')})` : ''}</dd>
          <dt>{t('chat.context.window')}</dt>
          <dd>{known ? formatTokenCount(windowTokens) : t('chat.context.windowUnknown')}</dd>
        </dl>
        {!known ? <p className="hint">{t('chat.context.unknownHint')}</p> : null}
        <Button size="sm" onClick={() => void compact()}>{t('chat.context.compact')}</Button>
      </div>
    </Popover>
  );
}

export function CostBadge({ sessionId }: { sessionId: string }) {
  const t = useT();
  const cost = useSession(sessionId, (mirror) => mirror?.view?.usageTotal.costUsd) ?? 0;
  const input = useSession(sessionId, (mirror) => mirror?.view?.usageTotal.inputTokens) ?? 0;
  const output = useSession(sessionId, (mirror) => mirror?.view?.usageTotal.outputTokens) ?? 0;
  const text = formatCostBadge(cost);
  const detail = t('chat.cost.detail', { input: formatTokenCount(input), output: formatTokenCount(output) });
  return (
    <span className="status-chip static" data-kind="cost" title={text === '–' ? `${t('chat.cost.unknown')} ${detail}` : detail}>
      <span className="chip-label">{t('chat.cost.label')}</span>
      <span>{text}</span>
      {text === '–' ? <span className="sr-only">{t('chat.cost.unknown')}</span> : null}
    </span>
  );
}
