/**
 * The window's frame: title bar, icon rail, session sidebar, the session pane and the
 * inspector. Layout only - every region's content comes from its own module, and each region
 * is wrapped in its own error boundary so one failing panel never blanks the window.
 */

import {
  BookMarked, FolderOpen, MessagesSquare, PanelRight, Search, Settings, Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ipc, platform } from '../api.js';
import { useHotkeys, type Hotkey } from '../hooks/use-hotkeys.js';
import { useT } from '../i18n/index.js';
import { InspectorPanel } from '../panels/InspectorPanel.js';
import { SessionView } from '../chat/SessionView.js';
import { SettingsShell } from '../settings/SettingsShell.js';
import { closeSession, openSession, reconnectSession } from '../store/actions.js';
import { sessionStore, useSession, useSessionList } from '../store/session-store.js';
import { writeSnapshot } from '../store/session-restore.js';
import { workspaceLabel } from '../store/sessions-list-store.js';
import { useUi } from '../store/ui-store.js';
import { LIMITS, type InspectorTab } from '../../shared/desktop-state.js';
import { Tab, TabsList, Tabs, Tooltip } from '../ui/overlay.js';
import { BrandMark } from '../ui/BrandMark.js';
import { Button, ErrorBoundary, IconButton, Kbd, Spinner } from '../ui/primitives.js';
import { CommandPalette } from './CommandPalette.js';
import { RESIZER_WIDTH, computeLayoutTier, inspectorMaxWidth } from './layout-tier.js';
import { Resizer } from './Resizer.js';
import { useBodyWidth } from './use-body-width.js';
import { ShortcutSheet } from './ShortcutSheet.js';
import { UpdateBadge } from './UpdateBadge.js';
import { PromptPicker } from '../prompts/PromptPicker.js';
import { SessionSidebar } from './SessionSidebar.js';
import './layout.css';

const INSPECTOR_TABS: InspectorTab[] = ['changes', 'plan', 'agents', 'jobs', 'context', 'governance'];

function Region({ children }: { children: ReactNode }) {
  const t = useT();
  return (
    <ErrorBoundary title={t('shell.region.error')} retryLabel={t('shell.region.retry')} copyLabel={t('shell.region.copy')}>
      {children}
    </ErrorBoundary>
  );
}

function EmptyState(props: { onOpenFolder(): void; onOpenRecent(path: string): void; recent: string[] }) {
  const t = useT();
  return (
    <div className="empty">
      <BrandMark size={56} />
      <h1>{t('shell.empty.title')}</h1>
      <p>{t('shell.empty.body')}</p>
      <Button variant="primary" size="lg" onClick={props.onOpenFolder}><FolderOpen size={15} /> {t('shell.empty.open')}</Button>
      {props.recent.length > 0 ? (
        <>
          <p style={{ marginTop: 24, marginBottom: 4, fontWeight: 500 }}>{t('shell.empty.recent')}</p>
          <ul className="recent">
            {props.recent.slice(0, 5).map((path) => (
              <li key={path}><button onClick={() => props.onOpenRecent(path)} title={path}>{path}</button></li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function SessionPane(props: { sessionId: string }) {
  const t = useT();
  const phase = useSession(props.sessionId, (mirror) => mirror?.phase);
  const error = useSession(props.sessionId, (mirror) => mirror?.error);
  const hydrated = useSession(props.sessionId, (mirror) => mirror?.hydrated);
  const cwd = useSession(props.sessionId, (mirror) => mirror?.meta?.cwd);
  if (phase === 'error' || phase === 'closed') {
    return (
      <div className="fullpage" role="alert">
        <h1>{phase === 'error' ? t('shell.open.failed') : t('shell.session.closed')}</h1>
        {error ? <p className="selectable">{error}</p> : null}
        {cwd ? <Button variant="primary" onClick={() => void reconnectSession(props.sessionId, cwd)}>{t('shell.session.reconnect')}</Button> : null}
      </div>
    );
  }
  if (!hydrated) {
    return <div className="empty" role="status"><Spinner label={t('shell.session.connecting')} /><p>{t('shell.session.connecting')}</p></div>;
  }
  return <SessionView sessionId={props.sessionId} />;
}

export function AppShell(props: { recentWorkspaces: string[]; noModelBanner: ReactNode }) {
  const t = useT();
  const isMac = platform() === 'darwin';
  const ui = useUi();
  const mirrors = useSessionList();
  const activeCwd = useSession(ui.activeSessionId, (mirror) => mirror?.meta?.cwd);
  const [sidebarDrag, setSidebarDrag] = useState(0);
  const [inspectorDrag, setInspectorDrag] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyWidth = useBodyWidth(bodyRef);

  const openFolder = useCallback(async (): Promise<void> => {
    const picked = await ipc('workspace:pick');
    if (picked.ok && picked.value.path) await openSession({ cwd: picked.value.path });
  }, []);

  // Remember what is open (ids and folders only) so a renderer crash / reload can put it back.
  useEffect(() => {
    writeSnapshot(
      mirrors.flatMap((mirror) => (mirror.meta?.cwd ? [{ id: mirror.id, cwd: mirror.meta.cwd }] : [])),
      ui.activeSessionId,
    );
  }, [mirrors, ui.activeSessionId]);

  const hotkeys = useMemo<Hotkey[]>(() => [
    { combo: 'mod+k', handler: () => ui.setPaletteOpen(!ui.paletteOpen) },
    { combo: 'mod+n', handler: () => void openFolder() },
    { combo: 'mod+w', handler: () => { if (ui.activeSessionId) void closeSession(ui.activeSessionId); } },
    { combo: 'mod+f', handler: () => { if (ui.activeSessionId && ui.view === 'session') ui.setFindSession(ui.activeSessionId); } },
    { combo: 'mod+j', handler: () => ui.setInspectorOpen(!ui.inspectorOpen) },
    { combo: 'mod+b', handler: () => ui.setSidebarOpen(!ui.sidebarOpen) },
    { combo: 'mod+shift+b', handler: () => ui.setInspectorTab('agents') },
    { combo: 'mod+p', handler: () => ui.setPromptPickerOpen(true) },
    { combo: 'mod+,', handler: () => ui.openSettings() },
    { combo: 'mod+/', handler: () => ui.setShortcutsOpen(true) },
    { combo: '?', handler: () => ui.setShortcutsOpen(true) },
    ...Array.from({ length: 9 }, (_unused, index): Hotkey => ({
      combo: `mod+${index + 1}`,
      handler: () => { const target = mirrors[index]; if (target) ui.setActiveSession(target.id); },
    })),
  ], [ui, mirrors, openFolder]);
  useHotkeys(hotkeys, isMac);

  useEffect(() => { document.documentElement.dataset.platform = platform(); }, []);

  const sidebarWidth = ui.sidebarWidth + sidebarDrag;
  const inSettings = ui.view === 'settings';
  const activeId = ui.activeSessionId;
  const inspectorVisible = ui.inspectorOpen && !inSettings && Boolean(activeId);
  // Derived, never stored: when the window cannot hold sidebar + main + inspector the sidebar yields
  // (the preference is untouched, so it returns as soon as there is room).
  const tier = computeLayoutTier(bodyWidth, sidebarWidth, inspectorVisible, inSettings);
  const sidebarAutoHidden = ui.sidebarOpen && !inSettings && tier > 1;
  const sidebarVisible = ui.sidebarOpen && !inSettings && tier === 1;
  const inspectorLimit = inspectorMaxWidth(bodyWidth, sidebarVisible, sidebarWidth, tier);
  const inspectorWidth = Math.min(LIMITS.inspectorWidth.max, Math.max(LIMITS.inspectorWidth.min, ui.inspectorWidth + inspectorDrag));

  const toggleSessions = (): void => {
    if (inSettings) ui.closeSettings(); // back to sessions; the sidebar preference is not rewritten
    else if (sidebarAutoHidden) ui.setInspectorOpen(false); // free the width so the list can return
    else ui.setSidebarOpen(!ui.sidebarOpen);
  };

  return (
    <div className="app">
      <header className="titlebar drag">
        <span className="titlebar-brand"><BrandMark size={20} /></span>
        <div className="crumbs">
          <span>{t('shell.app')}</span>
          {activeCwd ? <><span aria-hidden="true">›</span><strong>{workspaceLabel(activeCwd)}</strong></> : null}
        </div>
        <div className="titlebar-spacer" />
        <UpdateBadge />
        <button className="search-trigger" onClick={() => ui.setPaletteOpen(true)}>
          <Search size={13} aria-hidden="true" /> <span>{t('shell.title.search')}</span>
          <span style={{ marginLeft: 'auto' }}><Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd> <Kbd>K</Kbd></span>
        </button>
        <IconButton label={t('shell.rail.settings')} onClick={() => ui.openSettings()}><Settings size={16} /></IconButton>
        <IconButton label={t('shell.title.toggleInspector')} active={ui.inspectorOpen} onClick={() => ui.setInspectorOpen(!ui.inspectorOpen)}>
          <PanelRight size={16} />
        </IconButton>
      </header>

      {props.noModelBanner}

      <div className="body" ref={bodyRef} data-tier={tier}
        style={{ '--sidebar-slot-w': `${sidebarVisible ? sidebarWidth + RESIZER_WIDTH : 0}px` } as CSSProperties}>
        <nav className="rail" aria-label={t('shell.rail.sessions')}>
          <Tooltip content={sidebarAutoHidden ? t('shell.rail.sessionsNarrow') : t('shell.rail.sessions')} side="right">
            <IconButton label={sidebarAutoHidden ? t('shell.rail.sessionsNarrow') : t('shell.rail.sessions')}
              active={sidebarVisible} onClick={toggleSessions}><MessagesSquare size={18} /></IconButton>
          </Tooltip>
          <Tooltip content={t('shell.rail.search')} side="right">
            <IconButton label={t('shell.rail.search')} onClick={() => ui.setPaletteOpen(true)}><Search size={18} /></IconButton>
          </Tooltip>
          <Tooltip content={t('shell.rail.prompts')} side="right">
            <IconButton label={t('shell.rail.prompts')} onClick={() => ui.setPromptPickerOpen(true)}><BookMarked size={18} /></IconButton>
          </Tooltip>
          <Tooltip content={t('shell.rail.agents')} side="right">
            <IconButton label={t('shell.rail.agents')} onClick={() => ui.setInspectorTab('agents')}><Users size={18} /></IconButton>
          </Tooltip>
          <div className="rail-spacer" />
          <Tooltip content={t('shell.rail.settings')} side="right">
            <IconButton label={t('shell.rail.settings')} active={inSettings} onClick={() => ui.openSettings()}><Settings size={18} /></IconButton>
          </Tooltip>
        </nav>

        {sidebarVisible ? (
          <>
            <div className="sidebar-slot" style={{ width: sidebarWidth }}>
              <Region><SessionSidebar onNewSession={() => void openFolder()} /></Region>
            </div>
            <Resizer label={t('shell.sidebar.title')}
              onDrag={(delta) => setSidebarDrag((value) => Math.min(420 - ui.sidebarWidth, Math.max(200 - ui.sidebarWidth, value + delta)))}
              onReset={() => setSidebarDrag(260 - ui.sidebarWidth)} />
          </>
        ) : null}
        {sidebarDrag !== 0 ? <CommitOnRelease onCommit={() => { ui.setSidebarWidth(sidebarWidth); setSidebarDrag(0); }} /> : null}
        {inspectorDrag !== 0 ? <CommitOnRelease onCommit={() => { ui.setInspectorWidth(inspectorWidth); setInspectorDrag(0); }} /> : null}

        <main className="main">
          <Region>
            {inSettings ? <SettingsShell /> : activeId && sessionStore.get(activeId) ? (
              <SessionPane sessionId={activeId} key={activeId} />
            ) : (
              <EmptyState recent={props.recentWorkspaces} onOpenFolder={() => void openFolder()}
                onOpenRecent={(path) => void openSession({ cwd: path })} />
            )}
          </Region>
        </main>

        {inspectorVisible && activeId ? (
          <>
            <Resizer edge="left" className="inspector-resizer" label={t('shell.inspector.label')}
              onDrag={(delta) => setInspectorDrag((value) => Math.min(
                Math.max(LIMITS.inspectorWidth.min, inspectorLimit) - ui.inspectorWidth,
                Math.max(LIMITS.inspectorWidth.min - ui.inspectorWidth, value + delta),
              ))}
              onReset={() => setInspectorDrag(LIMITS.inspectorWidth.fallback - ui.inspectorWidth)} />
            <aside className="inspector" style={{ width: inspectorWidth }} aria-label={t('shell.inspector.label')}>
              <Tabs value={ui.inspectorTab} onValueChange={(value) => ui.setInspectorTab(value as InspectorTab)}>
                <TabsList label={t('shell.inspector.label')}>
                  {INSPECTOR_TABS.map((tab) => <Tab key={tab} value={tab}>{t(`shell.inspector.${tab}` as const)}</Tab>)}
                </TabsList>
              </Tabs>
              <div className="inspector-body">
                <Region><InspectorPanel sessionId={activeId} tab={ui.inspectorTab} /></Region>
              </div>
            </aside>
          </>
        ) : null}
      </div>

      <CommandPalette />
      <PromptPicker />
      <ShortcutSheet />
    </div>
  );
}

/** Persists a drag's final width on pointer release (a drag updates a local delta only). */
function CommitOnRelease(props: { onCommit(): void }) {
  useEffect(() => {
    const commit = (): void => props.onCommit();
    window.addEventListener('pointerup', commit, { once: true });
    return () => window.removeEventListener('pointerup', commit);
  });
  return null;
}

