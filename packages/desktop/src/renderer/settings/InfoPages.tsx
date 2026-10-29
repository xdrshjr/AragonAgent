/**
 * The read-mostly settings pages: Shortcuts, Logs & Diagnostics, Updates and About.
 * Nothing here pretends a capability exists: the updater reports `unsupported` when it is, and
 * says so in words.
 */

import { useCallback, useEffect, useState } from 'react';
import { ipc, platform } from '../api.js';
import { useT } from '../i18n/index.js';
import { DESKTOP_SHORTCUTS, terminalKeyRows } from '../lib/settings-shortcuts.js';
import { SECTIONS } from '../lib/settings-sections.js';
import { useConfig } from '../store/config-store.js';
import type { DesktopState } from '../../shared/desktop-state.js';
import type { AppInfo } from '../../shared/ipc-contract.js';
import { useUpdates } from '../store/update-store.js';
import { Button, Kbd, Switch } from '../ui/primitives.js';
import { KeyCombo } from './KeyCombo.js';
import { SectionForm } from './SectionForm.js';

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void ipc('app:info').then((response) => { if (!cancelled && response.ok) setInfo(response.value); });
    return () => { cancelled = true; };
  }, []);
  return info;
}

export function ShortcutsPage() {
  const t = useT();
  const isMac = platform() === 'darwin';
  return (
    <div className="set-page">
      <section className="set-card" aria-labelledby="sc-desktop">
        <header className="set-card-head"><h3 id="sc-desktop">{t('workspace.keys.desktop')}</h3></header>
        <table className="set-table">
          <tbody>
            {DESKTOP_SHORTCUTS.map((shortcut) => (
              <tr key={shortcut.combo}><th scope="row">{t(shortcut.labelKey)}</th><td><KeyCombo combo={shortcut.combo} isMac={isMac} /></td></tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="set-card" aria-labelledby="sc-term">
        <header className="set-card-head"><h3 id="sc-term">{t('workspace.keys.terminal')}</h3></header>
        <p className="set-desc">{t('workspace.keys.terminalNote')}</p>
        <table className="set-table">
          <tbody>
            {terminalKeyRows().map((row) => (
              <tr key={row.id}>
                <th scope="row">{row.notApplicable ? row.id : <Kbd>{row.id}</Kbd>}</th>
                <td>{row.labelKey ? t(row.labelKey) : t('common.unknown')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

export function DiagnosticsPage() {
  const t = useT();
  const info = useAppInfo();
  const configPath = useConfig((state) => state.result?.path);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const exportBundle = async (): Promise<void> => {
    setBusy(true);
    const response = await ipc('diagnostics:export');
    setBusy(false);
    if (!response.ok) setNote(t('settings.diag.exportFailed', { message: response.message }));
    else setNote(response.value.savedTo ? t('settings.diag.exported', { path: response.value.savedTo }) : t('settings.diag.cancelled'));
  };
  const openConfig = async (): Promise<void> => {
    const response = await ipc('config:open-in-editor');
    if (!response.ok || !response.value.opened) setNote(t('settings.diag.openFailed'));
  };

  return (
    <div className="set-page">
      <SectionForm section={SECTIONS.log} />
      <section className="set-card" aria-labelledby="diag-tools">
        <header className="set-card-head"><h3 id="diag-tools">{t('settings.diag.title')}</h3></header>
        <dl className="set-dl selectable">
          <dt>{t('settings.diag.home')}</dt><dd>{info?.homeRoot ?? '…'}{info?.overridden ? ` (${t('settings.diag.overridden')})` : ''}</dd>
          <dt>{t('settings.diag.config')}</dt><dd>{configPath ?? '…'}</dd>
        </dl>
        <div className="set-card-foot">
          <span className="set-status" role="status">{note}</span>
          <Button size="sm" onClick={() => void openConfig()}>{t('settings.diag.openConfig')}</Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void exportBundle()}>{t('settings.diag.export')}</Button>
        </div>
        <p className="set-desc">{t('settings.diag.exportNote')}</p>
      </section>
    </div>
  );
}

export function UpdatesPage() {
  const t = useT();
  const status = useUpdates((state) => state.status);
  const [prefs, setPrefs] = useState<DesktopState | null>(null);
  useEffect(() => {
    void useUpdates.getState().check();
    void ipc('desktop-state:get').then((response) => { if (response.ok) setPrefs(response.value); });
  }, []);
  const setAuto = async (next: boolean): Promise<void> => {
    if (!prefs) return;
    const response = await ipc('desktop-state:patch', { update: { ...prefs.update, enabled: next } });
    if (response.ok) setPrefs(response.value);
  };

  const state = status?.state ?? 'checking';
  const headline = (): string => {
    switch (status?.state) {
      case 'available': return t('settings.updates.state.available', { version: status.version });
      case 'uptodate': return t('settings.updates.state.uptodate');
      case 'error': return t(`settings.updates.error.${status.kind}` as const);
      case 'unsupported': return status.message;
      case 'idle': return t('settings.updates.state.idle');
      default: return t('settings.updates.state.checking');
    }
  };

  return (
    <div className="set-page">
      <section className="set-card" aria-labelledby="upd-title">
        <header className="set-card-head"><h3 id="upd-title">{t('settings.page.updates')}</h3></header>
        <p className="set-status" role="status">{headline()}</p>
        {status?.state === 'available' ? (
          <>
            {status.releasedAt ? <p className="set-desc">{t('settings.updates.released', { date: new Date(status.releasedAt).toLocaleDateString() })}</p> : null}
            <p className="set-desc selectable">{t('settings.updates.opensBrowser', { host: hostOf(status.downloadUrl) })}</p>
          </>
        ) : null}
        <div className="set-card-foot">
          <Button size="sm" disabled={state === 'checking'} onClick={() => void useUpdates.getState().check()}>{t('settings.updates.check')}</Button>
          {status?.state === 'available' ? (
            <>
              <Button size="sm" onClick={() => void useUpdates.getState().skip(status.version)}>{t('settings.updates.skip')}</Button>
              <Button size="sm" variant="primary" onClick={() => void useUpdates.getState().openDownload()}>{t('settings.updates.download')}</Button>
            </>
          ) : null}
        </div>
      </section>
      <section className="set-card" aria-labelledby="upd-auto">
        <header className="set-card-head"><h3 id="upd-auto">{t('settings.updates.autoTitle')}</h3></header>
        <div className="mp-row">
          <div className="mp-main"><span>{t('settings.updates.auto')}</span></div>
          <div className="mp-actions">
            <Switch label={t('settings.updates.auto')} checked={prefs?.update.enabled !== false}
              disabled={prefs === null} onCheckedChange={(next) => void setAuto(next)} />
          </div>
        </div>
        <p className="set-desc">{t('settings.updates.privacy')}</p>
      </section>
    </div>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function AboutPage() {
  const t = useT();
  const info = useAppInfo();
  const rows: Array<[string, string | undefined]> = [
    [t('settings.about.desktop'), info?.versions.desktop], [t('settings.about.cli'), info?.versions.cli],
    [t('settings.about.core'), info?.versions.core], [t('settings.about.tui'), info?.versions.tui],
    ['Electron', info?.versions.electron], ['Node', info?.versions.node], [t('settings.about.platform'), info?.platform],
    [t('settings.diag.home'), info?.homeRoot],
  ];
  return (
    <div className="set-page">
      <section className="set-card" aria-labelledby="about-title">
        <header className="set-card-head"><h3 id="about-title">{t('shell.app')}</h3></header>
        <dl className="set-dl selectable">
          {rows.map(([label, value]) => (<div key={label} className="set-dl-row"><dt>{label}</dt><dd>{value ?? '…'}</dd></div>))}
        </dl>
      </section>
    </div>
  );
}
