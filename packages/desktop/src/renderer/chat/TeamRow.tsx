/** `team` entries: the sub-agent dispatch card (one row per child) and the governance settlement card. */

import { memo } from 'react';
import type { Entry } from '@aragon-agent/tui/model/agent/reducer';
import { useT } from '../i18n/index.js';
import { clip, formatSeconds, formatTokenCount } from '../lib/chat-format.js';
import { useUi } from '../store/ui-store.js';
import { StatusDot, type DotKind } from '../ui/primitives.js';

type TeamEntry = Extract<Entry, { kind: 'team' }>;
type GovernanceEntry = Extract<Entry, { kind: 'governance' }>;

const PHASE_DOT: Record<string, DotKind> = {
  queued: 'idle', starting: 'waiting', thinking: 'running', tool: 'running', waiting: 'waiting',
  done: 'ready', failed: 'error', aborted: 'idle',
};

export const TeamRow = memo(function TeamRow({ entry }: { entry: TeamEntry }) {
  const t = useT();
  const finished = entry.runs.filter((run) => run.phase === 'done').length;
  const open = (): void => useUi.getState().setInspectorTab('agents');
  return (
    <div className="team" data-active={entry.active ? 'true' : undefined}>
      <button type="button" className="team-head" onClick={open}>
        <strong>{t('chat.team.title', { n: entry.requested })}</strong>
        <span className="team-count">{t('chat.team.progress', { done: finished, total: entry.runs.length })}</span>
        {entry.aborted ? <span className="team-flag">{t('chat.team.aborted')}</span> : null}
        {entry.durationMs !== undefined ? <span className="team-time">{formatSeconds(entry.durationMs)}</span> : null}
      </button>
      <ul className="team-runs">
        {entry.runs.map((run, index) => (
          <li key={`${run.label}-${index}`} className="team-run">
            <StatusDot kind={PHASE_DOT[run.phase] ?? 'idle'} label={t(`chat.team.phase.${run.phase}` as const)} />
            <span className="team-label">{run.label}</span>
            <span className="team-desc">{clip(run.description, 80)}</span>
            <span className="team-phase">{t(`chat.team.phase.${run.phase}` as const)}</span>
            <span className="team-usage">{formatTokenCount(run.usage.inputTokens + run.usage.outputTokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

export const GovernanceRow = memo(function GovernanceRow({ entry }: { entry: GovernanceEntry }) {
  const t = useT();
  const { card } = entry;
  return (
    <div className="gov" data-tone={card.tone}>
      <button type="button" className="gov-head" onClick={() => useUi.getState().setInspectorTab('governance')}>
        <strong>{card.title}</strong>
        <span>{card.headline}</span>
      </button>
      {card.rows.length > 0 ? (
        <ul className="gov-rows">
          {card.rows.map((row) => (
            <li key={row.id}>
              <span>{row.role}</span>
              <span>{row.confirmed ?? t('common.none')}</span>
              <code>{row.deltaText}</code>
            </li>
          ))}
        </ul>
      ) : null}
      {card.notes.map((note, index) => <p key={index} className="gov-note">{note}</p>)}
    </div>
  );
});
