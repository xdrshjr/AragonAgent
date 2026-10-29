/**
 * Inspector > Agents: the live team roster of the current dispatch. Each sub-agent shows its
 * phase as a word (queued / thinking / using a tool / done / failed ...), its work counters and
 * token use. The roster is ephemeral engine state: when no dispatch runs the panel says so.
 */

import { memo } from 'react';
import type { SubagentRun } from '@aragon-agent/tui/model/team/types';
import { useT } from '../i18n/index.js';
import { compactTokens, formatDuration } from '../lib/time.js';
import { useSession } from '../store/session-store.js';
import { Badge, StatusDot, type DotKind } from '../ui/primitives.js';
import { PanelBlock, PanelEmpty } from './PanelBits.js';

const PHASE_DOT: Record<SubagentRun['phase'], DotKind> = {
  queued: 'idle', starting: 'ready', thinking: 'running', tool: 'running', waiting: 'waiting',
  done: 'ready', failed: 'error', aborted: 'locked',
};

const RunRow = memo(function RunRow({ run, now }: { run: SubagentRun; now: number }) {
  const t = useT();
  const label = t(`workspace.agents.phase.${run.phase}` as const);
  const tokens = run.usage.inputTokens + run.usage.outputTokens;
  const elapsed = run.startedAt ? (run.endedAt ?? now) - run.startedAt : null;
  return (
    <li className="agent-row" data-phase={run.phase}>
      <div className="agent-head">
        <StatusDot kind={PHASE_DOT[run.phase]} label={label} />
        <strong className="agent-name selectable">{run.label}</strong>
        <Badge>{label}</Badge>
      </div>
      <p className="agent-desc selectable">{run.activity ?? run.description}</p>
      <p className="agent-stats">
        {t('workspace.agents.stats', { turns: run.turns, tools: run.toolCalls, tokens: compactTokens(tokens) })}
        {elapsed !== null ? ` · ${formatDuration(elapsed)}` : ''}
        {run.filesTouched.length > 0 ? ` · ${t('workspace.agents.files', { n: run.filesTouched.length })}` : ''}
      </p>
      {run.error ? <p className="panel-error selectable">{run.error}</p> : null}
      {run.summary ? <details><summary>{t('workspace.agents.summary')}</summary><p className="agent-summary selectable">{run.summary}</p></details> : null}
    </li>
  );
});

export function AgentsPanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const team = useSession(sessionId, (mirror) => mirror?.view?.team ?? null);
  if (!team || team.runs.length === 0) {
    return <PanelEmpty title={t('workspace.agents.emptyTitle')} body={t('workspace.agents.emptyBody')} />;
  }
  const now = Date.now();
  const finished = team.runs.filter((run) => run.phase === 'done' || run.phase === 'failed' || run.phase === 'aborted').length;
  return (
    <div className="panel">
      <PanelBlock title={t('workspace.agents.roster')}
        aside={t('workspace.agents.progress', { done: finished, total: team.requested || team.runs.length })}>
        <ul className="agent-list">
          {team.runs.map((run) => <RunRow key={run.label} run={run} now={now} />)}
        </ul>
        {team.messageCount > 0 ? <p className="panel-note">{t('workspace.agents.messages', { n: team.messageCount })}</p> : null}
      </PanelBlock>
    </div>
  );
}
