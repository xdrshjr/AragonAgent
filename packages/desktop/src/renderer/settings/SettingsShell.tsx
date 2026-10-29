/**
 * Full-page settings: a left navigation and one page at a time.
 *
 * Every page footer repeats two facts the user needs after any save: running terminals only
 * pick the change up after `/reload`, and keys the desktop does not show are kept untouched.
 * A save never needs an extra step for a live desktop session (its host reloads when idle);
 * while a run is in flight the footer says the change applies after it.
 */

import { ArrowLeft } from 'lucide-react';
import type { ComponentType } from 'react';
import { useT, type MessageKey } from '../i18n/index.js';
import { useConfig } from '../store/config-store.js';
import { useSessionList } from '../store/session-store.js';
import { useUi, type SettingsPage } from '../store/ui-store.js';
import { Button } from '../ui/primitives.js';
import { ConfigConflictDialog, StaleDraftBanner } from './ConfigConflict.js';
import { AboutPage, DiagnosticsPage, ShortcutsPage, UpdatesPage } from './InfoPages.js';
import { ModelsPage } from './ModelsPage.js';
import { PromptsPage } from './PromptsPage.js';
import { SkillsPage } from './SkillsPage.js';
import {
  AgentPage, ContextPage, FastPage, GeneralPage, GovernancePage, RetryPage, TeamPage, TodoPage,
} from './SimplePages.js';
import './settings.css';

/** `wide` pages (editors, lists) get a wider centred column; every page is centred. */
export const PAGES: ReadonlyArray<{ id: SettingsPage; titleKey: MessageKey; Component: ComponentType; wide?: boolean }> = [
  { id: 'general', titleKey: 'settings.page.general', Component: GeneralPage },
  { id: 'models', titleKey: 'settings.page.models', Component: ModelsPage, wide: true },
  { id: 'agent', titleKey: 'settings.page.agent', Component: AgentPage },
  { id: 'team', titleKey: 'settings.page.team', Component: TeamPage },
  { id: 'todo', titleKey: 'settings.page.todo', Component: TodoPage },
  { id: 'fast', titleKey: 'settings.page.fast', Component: FastPage },
  { id: 'context', titleKey: 'settings.page.context', Component: ContextPage },
  { id: 'retry', titleKey: 'settings.page.retry', Component: RetryPage },
  { id: 'skills', titleKey: 'settings.page.skills', Component: SkillsPage },
  { id: 'governance', titleKey: 'settings.page.governance', Component: GovernancePage },
  { id: 'prompts', titleKey: 'settings.page.prompts', Component: PromptsPage, wide: true },
  { id: 'shortcuts', titleKey: 'settings.page.shortcuts', Component: ShortcutsPage },
  { id: 'diagnostics', titleKey: 'settings.page.diagnostics', Component: DiagnosticsPage },
  { id: 'updates', titleKey: 'settings.page.updates', Component: UpdatesPage },
  { id: 'about', titleKey: 'settings.page.about', Component: AboutPage },
];

function SettingsFooter({ wide }: { wide: boolean }) {
  const t = useT();
  const terminalOnly = useConfig((state) => state.result?.terminalOnlyKeys.length ?? 0);
  const running = useSessionList().some((mirror) => mirror.runStatus === 'running' || mirror.runStatus === 'waiting-approval');
  return (
    <footer className="set-footer">
      <div className="settings-col set-footer-col" data-wide={wide || undefined}>
        <span>{t('settings.footer.reload')}</span>
        {running ? <span>{t('settings.footer.running')}</span> : null}
        {terminalOnly > 0 ? <span>{t('settings.footer.terminalOnly', { n: terminalOnly })}</span> : null}
      </div>
    </footer>
  );
}

export function SettingsShell() {
  const t = useT();
  const page = useUi((state) => state.settingsPage);
  const openSettings = useUi((state) => state.openSettings);
  const closeSettings = useUi((state) => state.closeSettings);
  const active = PAGES.find((entry) => entry.id === page) ?? PAGES[0]!;
  const { Component } = active;

  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t('settings.nav')}>
        <Button variant="ghost" size="sm" className="settings-back" onClick={closeSettings}>
          <ArrowLeft size={14} aria-hidden="true" /> {t('settings.back')}
        </Button>
        <ul>
          {PAGES.map((entry) => (
            <li key={entry.id}>
              <button type="button" className="settings-nav-item" aria-current={entry.id === active.id ? 'page' : undefined}
                onClick={() => openSettings(entry.id)}>{t(entry.titleKey)}</button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-main">
        <header className="settings-head">
          <div className="settings-col" data-wide={active.wide || undefined}>
            <h1 id="settings-title">{t(active.titleKey)}</h1>
          </div>
        </header>
        <div className="settings-stale-slot"><div className="settings-col" data-wide={active.wide || undefined}><StaleDraftBanner /></div></div>
        <div className="settings-scroll">
          <div className="settings-col" data-wide={active.wide || undefined}><Component /></div>
        </div>
        <SettingsFooter wide={active.wide === true} />
      </div>
      <ConfigConflictDialog />
    </div>
  );
}
