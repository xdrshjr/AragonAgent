/**
 * Root of the renderer: decides WHICH screen to show before the shell itself.
 *
 *   engine could not load        -> a full-page error (never a white window)
 *   config.json unreadable       -> read-only recovery page; nothing is repaired or reset
 *   no usable model (first run)  -> onboarding, skippable, leaving a quiet banner behind
 *   otherwise                    -> the shell, with a one-time "configuration recognised" note
 *
 * A user who already configured the terminal falls into the last branch with zero input:
 * "recognised" is judged on a usable main model, not on the file merely existing.
 */

import { useEffect, useState } from 'react';
import { ipc, ipcValue, onBroadcast } from './api.js';
import { useAppearance, type ThemeSetting } from './hooks/use-appearance.js';
import { resolveLanguage, setLanguage, useT } from './i18n/index.js';
import { AppShell } from './layout/AppShell.js';
import { Onboarding } from './onboarding/Onboarding.js';
import { sessionStore } from './store/session-store.js';
import { useConfig, watchConfigChanges } from './store/config-store.js';
import { useSessionsList, watchSessions } from './store/sessions-list-store.js';
import { watchHostRecovery } from './store/actions.js';
import { watchActivity } from './store/native-activity.js';
import { INITIAL_SNAPSHOT, restoreOpenSessions } from './store/session-restore.js';
import { watchTurnEnd } from './store/turn-notifications.js';
import { watchUpdates } from './store/update-store.js';
import { useUi } from './store/ui-store.js';
import type { AppInfo } from '../shared/ipc-contract.js';
import type { DesktopState } from '../shared/desktop-state.js';
import { TooltipProvider, Dialog } from './ui/overlay.js';
import { Button, Spinner } from './ui/primitives.js';
import './layout/layout.css';

const ONBOARDING_HINT = 'onboarding-v1';

function FullPageError(props: { title: string; body: string; rows?: [string, string][]; actions?: React.ReactNode }) {
  return (
    <div className="fullpage" role="alert">
      <h1>{props.title}</h1>
      <p style={{ color: 'var(--fg-light)' }}>{props.body}</p>
      {props.rows ? <dl>{props.rows.map(([k, v]) => <><dt key={`${k}-k`}>{k}</dt><dd key={`${k}-v`} className="selectable">{v}</dd></>)}</dl> : null}
      <div style={{ display: 'flex', gap: 8 }}>{props.actions}</div>
    </div>
  );
}

function BrokenConfig() {
  const t = useT();
  const result = useConfig((state) => state.result);
  return (
    <FullPageError title={t('shell.config.brokenTitle')} body={t('shell.config.brokenBody')}
      rows={[[t('shell.config.path'), result?.path ?? ''], [t('shell.config.error'), result?.error ?? 'unknown']]}
      actions={<>
        <Button onClick={() => void ipc('config:open-in-editor')}>{t('shell.config.openEditor')}</Button>
        <Button onClick={async () => { await ipc('config:restore-backup'); await useConfig.getState().refresh(); }}>{t('shell.config.restore')}</Button>
        <Button variant="primary" onClick={() => void useConfig.getState().refresh()}>{t('shell.config.recheck')}</Button>
      </>} />
  );
}

function QuitDialog() {
  const t = useT();
  const [plan, setPlan] = useState<{ runningSessions: string[]; liveServices: number } | null>(null);
  useEffect(() => onBroadcast('app:quit-requested', setPlan), []);
  const close = (): void => { setPlan(null); void ipc('app:cancel-quit'); };
  return (
    <Dialog open={plan !== null} onOpenChange={(open) => { if (!open) close(); }} title={t('shell.quit.title')}
      actions={<>
        <Button variant="primary" autoFocus onClick={close}>{t('common.cancel')}</Button>
        <Button variant="danger" onClick={() => void ipc('app:quit-confirmed', { stopServices: true })}>{t('shell.quit.confirm')}</Button>
      </>}>
      {plan && plan.runningSessions.length > 0 ? <p>{t('shell.quit.running', { n: plan.runningSessions.length })}</p> : null}
      {plan && plan.liveServices > 0 ? <p>{t('shell.quit.services', { n: plan.liveServices })}</p> : null}
    </Dialog>
  );
}

export function App() {
  const t = useT();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [state, setState] = useState<DesktopState | null>(null);
  const [skippedOnboarding, setSkippedOnboarding] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const config = useConfig();
  const view = config.result?.view ?? null;

  useAppearance({
    theme: view?.theme as ThemeSetting | undefined,
    density: view?.density,
    reducedMotion: view?.reducedMotion,
    enabled: view?.theme !== undefined,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [appInfo, desktopState] = await Promise.all([ipcValue('app:info'), ipcValue('desktop-state:get')]);
      if (cancelled) return;
      setInfo(appInfo);
      useUi.getState().setAttachmentsEnabled(appInfo.features?.attachments !== false);
      setState(desktopState);
      useUi.getState().setGroupToolRuns(desktopState.groupToolRuns);
      setLanguage(resolveLanguage(desktopState.language, navigator.language));
      const ui = useUi.getState();
      const window0 = desktopState.windows[0];
      if (window0) {
        ui.setSidebarWidth(window0.sidebarWidth);
        ui.setInspectorWidth(window0.inspectorWidth);
        ui.setInspectorOpen(window0.inspectorOpen);
        useUi.setState({ inspectorTab: window0.inspectorTab });
      }
      if (!appInfo.engineError) {
        await Promise.all([useConfig.getState().refresh(), useSessionsList.getState().refresh()]);
        // After a renderer crash / reload the main process still holds the session hosts: put this
        // window back on what it had open. At a fresh launch there is no snapshot, so nothing changes.
        if (!cancelled && INITIAL_SNAPSHOT) {
          void restoreOpenSessions(INITIAL_SNAPSHOT, new Set(useSessionsList.getState().rows.map((row) => row.id)));
        }
      }
    })();
    const offConfig = watchConfigChanges();
    const offSessions = watchSessions();
    const offTurns = watchTurnEnd();
    const offUpdates = watchUpdates();
    const offRecovery = watchHostRecovery();
    const offActivity = watchActivity();
    return () => { cancelled = true; offConfig(); offSessions(); offTurns(); offUpdates(); offRecovery(); offActivity(); };
  }, []);

  useEffect(() => {
    if (config.recognised) setNote(t('shell.config.recognised', { profiles: config.recognised.profiles, model: config.recognised.model }));
  }, [config.recognised, t]);
  // Declared after the "recognised" note on purpose: when both apply, this one is the one to read.
  useEffect(() => {
    if (info?.preferencesReset) setNote(t('shell.state.reset'));
    // Re-run when the "recognised" note is (re)applied, so it can never bury this one.
  }, [info?.preferencesReset, config.recognised, t]);
  useEffect(() => {
    if (!note) return undefined;
    const timer = setTimeout(() => setNote(null), 9000);
    return () => clearTimeout(timer);
  }, [note]);

  // Persist the layout (debounced) so the window reopens as it was left.
  const ui = useUi();
  useEffect(() => {
    if (!state) return undefined;
    const timer = setTimeout(() => {
      void ipc('desktop-state:patch', {
        windows: [{
          id: 'w1', bounds: state.windows[0]?.bounds ?? { width: 1280, height: 820 }, maximized: state.windows[0]?.maximized ?? false,
          sidebarWidth: ui.sidebarWidth, inspectorWidth: ui.inspectorWidth, inspectorOpen: ui.inspectorOpen,
          inspectorTab: ui.inspectorTab, openSessions: sessionStore.all().map((mirror) => mirror.id), activeSession: ui.activeSessionId,
        }],
      });
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.sidebarWidth, ui.inspectorWidth, ui.inspectorOpen, ui.inspectorTab, ui.activeSessionId]);

  if (!info || !state) {
    return <div className="empty" role="status"><Spinner label={t('common.loading')} /></div>;
  }
  if (info.engineError) {
    return <FullPageError title={t('shell.engine.title')} body={t('shell.engine.body')} rows={[[t('common.error.details'), info.engineError]]} />;
  }
  if (config.startup === 'unknown') {
    return <div className="empty" role="status"><Spinner label={t('common.loading')} /></div>;
  }
  if (config.startup === 'broken') return <BrokenConfig />;

  const needsModel = config.startup === 'onboarding';
  const onboardingDismissed = state.dismissedHints.includes(ONBOARDING_HINT) || skippedOnboarding;
  if (needsModel && !onboardingDismissed) {
    return (
      <Onboarding
        onFinished={() => void config.refresh()}
        onSkip={() => {
          setSkippedOnboarding(true);
          void ipc('desktop-state:patch', { dismissedHints: [...state.dismissedHints, ONBOARDING_HINT] }).then((response) => {
            if (response.ok) setState(response.value);
          });
        }} />
    );
  }

  return (
    <TooltipProvider>
      <AppShell
        recentWorkspaces={state.recentWorkspaces}
        noModelBanner={needsModel ? (
          <div className="banner" role="status">
            <span>{t('shell.banner.noModel')}</span>
            <Button size="sm" onClick={() => useUi.getState().openSettings('models')}>{t('shell.banner.setup')}</Button>
          </div>
        ) : null} />
      {note ? <div className="toast-note" role="status" onClick={() => setNote(null)}>{note}</div> : null}
      <QuitDialog />
    </TooltipProvider>
  );
}
