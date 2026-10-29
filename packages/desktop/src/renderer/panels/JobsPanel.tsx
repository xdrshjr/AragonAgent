/**
 * Inspector > Jobs: background commands and long tasks, with a log tail and a Stop button.
 *
 * Jobs are read from the transcript's service entries (see `latestJobs`); the log is fetched
 * with `service.read-log` and a cursor, so reopening or refreshing only appends what is new.
 * Output is plain text in a `<pre>`: a job's output is untrusted and never becomes markup.
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { isJobLive, latestJobs, type JobEntry } from '../lib/panels-jobs.js';
import { formatDuration } from '../lib/time.js';
import { useSession } from '../store/session-store.js';
import { Badge, Button, StatusDot, type DotKind } from '../ui/primitives.js';
import { PanelEmpty, PanelError, usePanelCommand, type PanelCommand } from './PanelBits.js';

/** The tail is bounded: an hour of chatty output must not become an hour of DOM. */
const MAX_LOG_ROWS = 500;
const POLL_MS = 2000;

interface LogPage { rows: string[]; cursor: number }

function isLogPage(value: unknown): value is LogPage {
  return typeof value === 'object' && value !== null && Array.isArray((value as LogPage).rows)
    && typeof (value as LogPage).cursor === 'number';
}

const STATUS_DOT: Record<JobEntry['status'], DotKind> = {
  starting: 'ready', ready: 'ready', running: 'running', exited: 'idle', failed: 'error', stopped: 'locked',
};

function JobLog({ job, sessionId }: { job: JobEntry; sessionId: string }) {
  const t = useT();
  // Its own command channel: a poll every 2 s must not flicker the Stop button or erase its error.
  const command = usePanelCommand(sessionId);
  const [rows, setRows] = useState<string[]>([]);
  const cursor = useRef<number | undefined>(undefined);
  const live = isJobLive(job);
  const { run } = command;

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const result = await run({ c: 'service.read-log', id: job.serviceId, ...(cursor.current === undefined ? {} : { since: cursor.current }) });
      if (cancelled || !result.ok || !isLogPage(result.value)) return;
      const { cursor: next, rows: fresh } = result.value;
      cursor.current = next;
      if (fresh.length > 0) setRows((held) => [...held, ...fresh].slice(-MAX_LOG_ROWS));
    };
    void load();
    if (!live) return () => { cancelled = true; };
    const timer = setInterval(() => void load(), POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [job.serviceId, live, run]);

  return <pre className="job-log selectable" tabIndex={0} aria-label={t('workspace.jobs.log', { id: job.serviceId })}>{rows.length === 0 ? t('workspace.jobs.noOutput') : rows.join('\n')}</pre>;
}

function JobRow({ job, sessionId, command }: { job: JobEntry; sessionId: string; command: PanelCommand }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const live = isJobLive(job);
  const label = t(`workspace.jobs.status.${job.status}` as const);
  const ended = job.endedAt ?? Date.now();
  return (
    <li className="job-row">
      <div className="job-head">
        <StatusDot kind={STATUS_DOT[job.status]} label={label} />
        <strong className="job-id">{job.serviceId}</strong>
        <Badge>{label}</Badge>
        {job.stalled ? <Badge tone="warning">{t('workspace.jobs.stalled')}</Badge> : null}
        <span className="job-time">{formatDuration(ended - job.startedAt)}</span>
      </div>
      <code className="job-cmd selectable" title={job.command}>{job.command}</code>
      {job.url ? <p className="job-meta selectable">{job.url}</p> : null}
      {job.progress ? <p className="job-meta selectable">{job.progress}</p> : null}
      {job.exitCode !== null && !live ? <p className="job-meta">{t('workspace.jobs.exit', { code: job.exitCode })}</p> : null}
      <div className="panel-actions">
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {open ? t('workspace.jobs.hideLog') : t('workspace.jobs.showLog')}
        </Button>
        {live ? <Button size="sm" variant="danger" disabled={command.busy} onClick={() => void command.run({ c: 'service.stop', id: job.serviceId })}>{t('workspace.jobs.stop')}</Button> : null}
      </div>
      {open ? <JobLog job={job} sessionId={sessionId} /> : null}
    </li>
  );
}

export function JobsPanel({ sessionId }: { sessionId: string }) {
  const t = useT();
  const entries = useSession(sessionId, (mirror) => mirror?.view?.entries);
  const deferred = useDeferredValue(entries);
  const jobs = useMemo(() => (deferred ? latestJobs(deferred) : []), [deferred]);
  const command = usePanelCommand(sessionId);
  if (jobs.length === 0) return <PanelEmpty title={t('workspace.jobs.emptyTitle')} body={t('workspace.jobs.emptyBody')} />;
  return (
    <div className="panel">
      <ul className="job-list">{jobs.map((job) => <JobRow key={job.serviceId} job={job} sessionId={sessionId} command={command} />)}</ul>
      <PanelError message={command.error} />
    </div>
  );
}
