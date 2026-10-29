/**
 * The session sidebar: every saved session, grouped by workspace.
 *
 * Status is a dot AND a label (never colour alone). A session another process holds is shown
 * with a lock and refuses to open for writing: the choices are to branch it or leave it, so
 * there is never a moment with two writers on one conversation. Rows are plain buttons - the
 * whole list is reachable by keyboard.
 */

import { GitBranch, Lock, PanelLeftClose, Pin, PinOff, Plus, Search, Trash2 } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { ipc } from '../api.js';
import { useT } from '../i18n/index.js';
import { TITLE_ROW_MAX, TITLE_TOOLTIP_MAX, displayTitle } from '../lib/session-title.js';
import { relativeTime } from '../lib/time.js';
import { branchSessionFrom, closeSession, openSession } from '../store/actions.js';
import { sessionStore, useSessionList } from '../store/session-store.js';
import { groupSessions, useSessionsList } from '../store/sessions-list-store.js';
import { useUi } from '../store/ui-store.js';
import type { SessionHostStatus, SessionRowDto } from '../../shared/ipc-contract.js';
import { Dialog } from '../ui/overlay.js';
import { Button, IconButton, Input, Skeleton, StatusDot, type DotKind } from '../ui/primitives.js';
import './layout.css';

export function dotFor(row: SessionRowDto, live: SessionHostStatus | undefined): { kind: DotKind; labelKey: 'shell.status.running' | 'shell.status.ready' | 'shell.status.parked' | 'shell.status.waiting' | 'shell.status.error' | 'shell.status.crashed' | 'shell.status.unresponsive' | 'shell.status.idle' | 'shell.status.locked' | 'shell.status.starting' } {
  if (row.liveElsewhere) return { kind: 'locked', labelKey: 'shell.status.locked' };
  switch (live ?? row.hostStatus) {
    case 'running': return { kind: 'running', labelKey: 'shell.status.running' };
    case 'waiting-approval': return { kind: 'waiting', labelKey: 'shell.status.waiting' };
    case 'ready': return { kind: 'ready', labelKey: 'shell.status.ready' };
    case 'starting': return { kind: 'ready', labelKey: 'shell.status.starting' };
    case 'parked': return { kind: 'parked', labelKey: 'shell.status.parked' };
    case 'crashed': return { kind: 'error', labelKey: 'shell.status.crashed' };
    case 'failed': return { kind: 'error', labelKey: 'shell.status.error' };
    case 'unresponsive': return { kind: 'error', labelKey: 'shell.status.unresponsive' };
    default: return { kind: 'idle', labelKey: 'shell.status.idle' };
  }
}

const Row = memo(function Row(props: {
  row: SessionRowDto;
  live: SessionHostStatus | undefined;
  active: boolean;
  now: number;
  onOpen(row: SessionRowDto): void;
  onPin(row: SessionRowDto): void;
  onBranch(row: SessionRowDto): void;
  onDelete(row: SessionRowDto): void;
}) {
  const t = useT();
  const { row } = props;
  const dot = dotFor(row, props.live);
  const fallback = t('shell.sidebar.untitled');
  const raw = row.unreadable ? t('shell.sidebar.unreadable') : row.title;
  const title = displayTitle(raw, fallback, TITLE_ROW_MAX);
  return (
    <li className="srow" data-active={props.active} data-pending={row.pending}>
      <button className="srow-main" onClick={() => props.onOpen(row)} aria-current={props.active ? 'true' : undefined}
        title={displayTitle(raw, fallback, TITLE_TOOLTIP_MAX)}>
        <StatusDot kind={dot.kind} label={t(dot.labelKey)} />
        <span className="srow-title">{row.pending ? <Skeleton width="70%" height={10} /> : title}</span>
        {row.liveElsewhere ? <Lock size={12} aria-label={t('shell.sidebar.inTerminal')} /> : null}
        {row.pinned ? <Pin size={11} aria-hidden="true" className="srow-pin" /> : null}
        <span className="srow-time">{relativeTime(row.updatedAt, props.now, t)}</span>
      </button>
      <span className="srow-actions">
        <IconButton size="sm" label={row.pinned ? t('shell.sidebar.unpin') : t('shell.sidebar.pin')} onClick={() => props.onPin(row)}>
          {row.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </IconButton>
        <IconButton size="sm" label={t('shell.sidebar.branch')} onClick={() => props.onBranch(row)}><GitBranch size={13} /></IconButton>
        <IconButton size="sm" label={t('shell.sidebar.delete')} onClick={() => props.onDelete(row)}><Trash2 size={13} /></IconButton>
      </span>
    </li>
  );
});

export function SessionSidebar(props: { onNewSession(): void }) {
  const t = useT();
  const rows = useSessionsList((state) => state.rows);
  const loaded = useSessionsList((state) => state.loaded);
  const statuses = useSessionsList((state) => state.statuses);
  const query = useSessionsList((state) => state.query);
  const setQuery = useSessionsList((state) => state.setQuery);
  const activeId = useUi((state) => state.activeSessionId);
  const mirrors = useSessionList();
  const [now, setNow] = useState(() => Date.now());
  const [confirmDelete, setConfirmDelete] = useState<SessionRowDto | null>(null);
  const [busyElsewhere, setBusyElsewhere] = useState<SessionRowDto | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const groups = useMemo(() => groupSessions(rows), [rows]);

  const open = async (row: SessionRowDto): Promise<void> => {
    if (sessionStore.get(row.id)) {
      useUi.getState().setActiveSession(row.id);
      return;
    }
    if (row.liveElsewhere) {
      setBusyElsewhere(row);
      return;
    }
    const outcome = await openSession({ id: row.id, cwd: row.cwd });
    if (!outcome.ok) {
      if (outcome.code === 'session_busy_elsewhere') setBusyElsewhere(row);
      else setOpenError(outcome.message);
    }
  };

  const branch = async (row: SessionRowDto): Promise<void> => {
    setBusyElsewhere(null);
    const outcome = await branchSessionFrom(row.id, row.cwd);
    if (!outcome.ok) setOpenError(outcome.message);
  };

  const pin = async (row: SessionRowDto): Promise<void> => {
    await ipc('sessions:pin', { id: row.id, pinned: !row.pinned });
    void useSessionsList.getState().refresh();
  };

  const remove = async (row: SessionRowDto): Promise<void> => {
    setConfirmDelete(null);
    if (sessionStore.get(row.id)) await closeSession(row.id);
    await ipc('sessions:remove', { id: row.id, confirm: true });
    void useSessionsList.getState().refresh();
  };

  return (
    <aside className="sidebar" aria-label={t('shell.sidebar.title')}>
      <div className="sidebar-head">
        <h2 className="sidebar-title">{t('shell.sidebar.title')}</h2>
        <span className="sidebar-head-actions">
          <IconButton label={t('shell.sidebar.collapse')} onClick={() => useUi.getState().setSidebarOpen(false)}>
            <PanelLeftClose size={16} />
          </IconButton>
          <IconButton label={t('shell.sidebar.new')} onClick={props.onNewSession}><Plus size={16} /></IconButton>
        </span>
      </div>
      <div className="sidebar-filter">
        <Search size={13} aria-hidden="true" />
        <Input value={query} onChange={(event) => setQuery(event.target.value)}
          placeholder={t('shell.sidebar.filter')} aria-label={t('shell.sidebar.filter')} />
      </div>
      <div className="sidebar-scroll">
        {!loaded ? (
          <div className="sidebar-skeleton" role="status" aria-label={t('shell.sidebar.loading')}>
            {[0, 1, 2, 3, 4].map((index) => <Skeleton key={index} height={14} width={`${90 - index * 8}%`} />)}
          </div>
        ) : groups.length === 0 ? (
          <p className="sidebar-empty">{query ? t('shell.sidebar.emptyFiltered', { query }) : t('shell.sidebar.empty')}</p>
        ) : groups.map((group) => (
          <section key={group.key} className="sgroup">
            <h3 className="sgroup-title" title={group.rows[0]?.cwd}>{group.label}</h3>
            <ul className="slist">
              {group.rows.map((row) => (
                <Row key={row.id} row={row} live={statuses[row.id]} active={row.id === activeId} now={now}
                  onOpen={(r) => void open(r)} onPin={(r) => void pin(r)}
                  onBranch={(r) => void branch(r)} onDelete={setConfirmDelete} />
              ))}
            </ul>
          </section>
        ))}
        {mirrors.length === 0 && loaded && rows.length === 0 ? null : null}
      </div>

      <Dialog open={confirmDelete !== null} onOpenChange={(openState) => { if (!openState) setConfirmDelete(null); }}
        title={t('shell.sidebar.deleteTitle')} description={t('shell.sidebar.deleteBody')}
        actions={<>
          <Button variant="ghost" onClick={() => setConfirmDelete(null)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={() => confirmDelete && void remove(confirmDelete)}>{t('shell.sidebar.delete')}</Button>
        </>}>
        <p className="selectable">{confirmDelete?.title ?? ''}</p>
      </Dialog>

      <Dialog open={busyElsewhere !== null} onOpenChange={(openState) => { if (!openState) setBusyElsewhere(null); }}
        title={t('shell.live.busyElsewhereTitle')} description={t('shell.live.busyElsewhereBody')}
        actions={<>
          <Button variant="ghost" onClick={() => setBusyElsewhere(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => busyElsewhere && void branch(busyElsewhere)}>{t('shell.live.branch')}</Button>
        </>}>
        <p className="selectable">{busyElsewhere?.title ?? ''}</p>
      </Dialog>

      <Dialog open={openError !== null} onOpenChange={(openState) => { if (!openState) setOpenError(null); }}
        title={t('shell.open.failed')} actions={<Button onClick={() => setOpenError(null)}>{t('common.close')}</Button>}>
        <p className="selectable">{openError}</p>
      </Dialog>
    </aside>
  );
}
