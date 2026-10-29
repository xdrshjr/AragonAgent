/**
 * Inspector > Governance: the live governed run (pipeline, roster, health, alerts), the pause
 * controls, and past runs with their reports.
 *
 * Pause is cooperative: it stops at the next clean stage boundary and kills nothing, which the
 * panel says. When governance is unavailable (switched off, no team) the host's own reason is
 * shown rather than an empty panel.
 */

import { useEffect, useState } from 'react';
import type { GovernanceSnapshot, RunStatus } from '@aragon-agent/tui/model/governance/types';
import { useT } from '../i18n/index.js';
import { compactTokens } from '../lib/time.js';
import { useSession } from '../store/session-store.js';
import { Badge, Button } from '../ui/primitives.js';
import { PanelBlock, PanelEmpty, PanelError, usePanelCommand, type PanelCommand } from './PanelBits.js';

interface RunRow {
  runId: string;
  goal: string;
  status: RunStatus;
  updatedAt: number;
}

function parseRuns(value: unknown): RunRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is RunRow => typeof row === 'object' && row !== null
    && typeof (row as RunRow).runId === 'string' && typeof (row as RunRow).goal === 'string');
}

type ReportState = { kind: 'idle' } | { kind: 'text'; text: string } | { kind: 'none'; reason: 'missing' | 'bad_id' | 'no_run' | 'failed' };

function parseReport(value: unknown): ReportState {
  const reply = value as { kind?: string; text?: unknown } | null;
  if (reply?.kind === 'ok' && typeof reply.text === 'string') return { kind: 'text', text: reply.text };
  if (reply?.kind === 'missing' || reply?.kind === 'bad_id' || reply?.kind === 'no_run') return { kind: 'none', reason: reply.kind };
  return { kind: 'none', reason: 'failed' };
}

function LiveRun({ run, command }: { run: GovernanceSnapshot; command: PanelCommand }) {
  const t = useT();
  const pausing = run.pauseRequested === true;
  return (
    <PanelBlock title={t('workspace.gov.liveRun')} aside={<Badge tone={run.status === 'executing' ? 'brand' : 'warning'}>{t(`workspace.gov.status.${run.status}` as const)}</Badge>}>
      <p className="gov-goal selectable">{run.goal}</p>
      <p className="panel-note">
        {t('workspace.gov.phase', { phase: run.phase, count: run.phaseCount })}
        {run.stage ? ` · ${t(`workspace.gov.stage.${run.stage}` as const)}` : ''}
        {run.health !== null ? ` · ${t('workspace.gov.health', { n: run.health })}` : ''}
      </p>
      <ol className="gov-pipeline" aria-label={t('workspace.gov.pipeline')}>
        {run.pipeline.map((step) => (
          <li key={step.key} data-state={step.state}>
            {t(`workspace.gov.stage.${step.key}` as const)} <span className="gov-step-state">{t(`workspace.gov.step.${step.state}` as const)}</span>
          </li>
        ))}
      </ol>
      <table className="gov-roster">
        <thead><tr><th scope="col">{t('workspace.gov.agent')}</th><th scope="col">{t('workspace.gov.state')}</th><th scope="col">{t('workspace.gov.score')}</th></tr></thead>
        <tbody>
          {run.roster.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="selectable">{row.id}<span className="gov-role"> {row.role}</span></th>
              <td>{t(`workspace.gov.agentState.${row.state}` as const)}</td>
              <td>{row.confirmed ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {run.alerts.map((alert, index) => <p key={index} className="panel-error selectable" role="status">{alert}</p>)}
      {run.reworkNote ? <p className="panel-note selectable">{run.reworkNote}</p> : null}
      {run.budgetTokens > 0 ? (
        <p className="panel-note">{t('workspace.gov.budget', { used: compactTokens(run.usage.inputTokens + run.usage.outputTokens), budget: compactTokens(run.budgetTokens) })}</p>
      ) : null}
      <div className="panel-actions">
        {pausing ? (
          <Button size="sm" disabled={command.busy} onClick={() => void command.run({ c: 'gov.cancel-pause' })}>{t('workspace.gov.cancelPause')}</Button>
        ) : (
          <Button size="sm" disabled={command.busy || run.status !== 'executing'} onClick={() => void command.run({ c: 'gov.pause' })}>{t('workspace.gov.pause')}</Button>
        )}
      </div>
      <p className="panel-note">{pausing ? t('workspace.gov.pauseRequested') : t('workspace.gov.pauseNote')}</p>
    </PanelBlock>
  );
}

function PastRuns({ sessionId }: { sessionId: string }) {
  const t = useT();
  const command = usePanelCommand(sessionId);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [report, setReport] = useState<ReportState>({ kind: 'idle' });
  const { run } = command;

  useEffect(() => {
    let cancelled = false;
    void run({ c: 'gov.runs' }).then((result) => { if (!cancelled && result.ok) setRuns(parseRuns(result.value)); });
    return () => { cancelled = true; };
  }, [run]);

  const open = async (runId: string): Promise<void> => {
    const result = await run({ c: 'gov.report', runId });
    setReport(result.ok ? parseReport(result.value) : { kind: 'idle' });
  };

  return (
    <PanelBlock title={t('workspace.gov.runs')}>
      {runs === null ? <p className="panel-note" role="status">{t('common.loading')}</p> : runs.length === 0 ? <p className="panel-note">{t('workspace.gov.noRuns')}</p> : (
        <ul className="gov-runs">
          {runs.map((row) => (
            <li key={row.runId} className="gov-run">
              <div className="gov-run-main">
                <strong className="selectable">{row.runId}</strong>
                <Badge>{t(`workspace.gov.status.${row.status}` as const)}</Badge>
                <span className="gov-goal selectable">{row.goal}</span>
              </div>
              <Button size="sm" variant="ghost" disabled={command.busy} onClick={() => void open(row.runId)}>{t('workspace.gov.report')}</Button>
            </li>
          ))}
        </ul>
      )}
      <PanelError message={command.error} />
      {report.kind === 'text' ? <pre className="gov-report selectable" tabIndex={0}>{report.text}</pre> : null}
      {report.kind === 'none' ? <p className="panel-note">{t(`workspace.gov.reportNone.${report.reason}` as const)}</p> : null}
    </PanelBlock>
  );
}

export function GovernancePanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const governance = useSession(sessionId, (mirror) => mirror?.view?.governance ?? null);
  const unavailable = useSession(sessionId, (mirror) => mirror?.meta?.governanceUnavailable ?? null);
  const command = usePanelCommand(sessionId);
  return (
    <div className="panel">
      {governance ? <LiveRun run={governance} command={command} /> : (
        <PanelEmpty title={t('workspace.gov.emptyTitle')} body={unavailable ?? t('workspace.gov.emptyBody')} />
      )}
      <PanelError message={command.error} />
      <PastRuns sessionId={sessionId} />
    </div>
  );
}
