/**
 * The command palette (Ctrl/Cmd+K): sessions, actions and settings pages in one searchable
 * list, fully keyboard driven (cmdk). It matches on the TRANSLATED label as well as the id, so
 * a Chinese user searching in Chinese finds the action.
 *
 * Focus returns to whatever held it before the palette opened. That element is read during the
 * render that opens the palette - before Radix's focus scope moves focus into the dialog - and
 * restored explicitly on close, because a shortcut-opened dialog has no trigger button for the
 * browser to hand focus back to.
 */

import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import {
  BookMarked, FolderPlus, Keyboard, LayoutPanelLeft, MessageSquare, PanelRight, Settings, X,
} from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import { ipc, platform } from '../api.js';
import { useT, type MessageKey } from '../i18n/index.js';
import { comboParts } from '../lib/settings-shortcuts.js';
import { closeSession, openSession } from '../store/actions.js';
import { sessionStore } from '../store/session-store.js';
import { useSessionsList, workspaceLabel } from '../store/sessions-list-store.js';
import { useUi, type SettingsPage } from '../store/ui-store.js';
import type { InspectorTab } from '../../shared/desktop-state.js';
import type { SessionRowDto } from '../../shared/ipc-contract.js';
import { runSessionMenuItem } from '../chat/session-menu-actions.js';
import { SESSION_MENU, disabledReasonKey } from '../chat/session-menu.js';
import { sessionStore as sessionMirrors } from '../store/session-store.js';
import { Kbd } from '../ui/primitives.js';
import './palette.css';

const SETTINGS_PAGES: ReadonlyArray<{ page: SettingsPage; labelKey: MessageKey }> = [
  { page: 'general', labelKey: 'settings.page.general' }, { page: 'models', labelKey: 'settings.page.models' },
  { page: 'agent', labelKey: 'settings.page.agent' }, { page: 'team', labelKey: 'settings.page.team' },
  { page: 'todo', labelKey: 'settings.page.todo' }, { page: 'fast', labelKey: 'settings.page.fast' },
  { page: 'context', labelKey: 'settings.page.context' }, { page: 'retry', labelKey: 'settings.page.retry' },
  { page: 'skills', labelKey: 'settings.page.skills' }, { page: 'governance', labelKey: 'settings.page.governance' },
  { page: 'prompts', labelKey: 'settings.page.prompts' }, { page: 'shortcuts', labelKey: 'settings.page.shortcuts' },
  { page: 'diagnostics', labelKey: 'settings.page.diagnostics' }, { page: 'updates', labelKey: 'settings.page.updates' },
  { page: 'about', labelKey: 'settings.page.about' },
];

const INSPECTOR_TABS: ReadonlyArray<{ tab: InspectorTab; labelKey: MessageKey }> = [
  { tab: 'changes', labelKey: 'shell.inspector.changes' }, { tab: 'plan', labelKey: 'shell.inspector.plan' },
  { tab: 'agents', labelKey: 'shell.inspector.agents' }, { tab: 'jobs', labelKey: 'shell.inspector.jobs' },
  { tab: 'context', labelKey: 'shell.inspector.context' }, { tab: 'governance', labelKey: 'shell.inspector.governance' },
];

/** The newest sessions only: a few hundred rows is already more than anyone scrolls. */
const MAX_SESSION_ITEMS = 200;

function Item(props: { id: string; label: string; keywords?: string[]; icon: ReactNode; hint?: ReactNode; onSelect(): void }) {
  return (
    <Command.Item value={props.id} keywords={[props.label, ...(props.keywords ?? [])]} onSelect={props.onSelect} className="palette-item">
      <span className="palette-icon" aria-hidden="true">{props.icon}</span>
      <span className="palette-label">{props.label}</span>
      {props.hint ? <span className="palette-hint">{props.hint}</span> : null}
    </Command.Item>
  );
}

export function CommandPalette() {
  const t = useT();
  const isMac = platform() === 'darwin';
  const open = useUi((state) => state.paletteOpen);
  const setOpen = useUi((state) => state.setPaletteOpen);
  const rows = useSessionsList((state) => state.rows);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = open;

  /** Close first, then act: the action may move focus (opening a session focuses its composer). */
  const run = (action: () => void | Promise<unknown>): void => {
    setOpen(false);
    void action();
  };
  const hint = (combo: string): ReactNode => <span className="palette-keys">{comboParts(combo, isMac).map((part, index) => <Kbd key={`${part}${index}`}>{part}</Kbd>)}</span>;

  const openRow = async (row: SessionRowDto): Promise<void> => {
    if (sessionStore.get(row.id)) { useUi.getState().setActiveSession(row.id); return; }
    // A session a terminal is writing opens read-only here: two writers would corrupt it.
    await openSession({ id: row.id, cwd: row.cwd, ...(row.liveElsewhere ? { readOnly: true } : {}) });
  };
  const newSession = async (): Promise<void> => {
    const picked = await ipc('workspace:pick');
    if (picked.ok && picked.value.path) await openSession({ cwd: picked.value.path });
  };
  const ui = useUi.getState;
  const activeId = useUi((state) => state.activeSessionId);
  const activeMirror = activeId ? sessionMirrors.get(activeId) : undefined;
  // Items that cannot run right now are left out of the palette (the menu shows them disabled with a reason).
  const menuContext = { running: activeMirror?.view?.status === 'running', hasCwd: Boolean(activeMirror?.meta?.cwd) };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="overlay-backdrop" />
        <DialogPrimitive.Content className="palette selectable" aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (returnFocus.current?.isConnected) returnFocus.current.focus();
          }}>
          <DialogPrimitive.Title className="sr-only">{t('workspace.palette.title')}</DialogPrimitive.Title>
          <Command label={t('workspace.palette.title')} loop>
            <Command.Input className="palette-input" placeholder={t('workspace.palette.placeholder')} autoFocus />
            <Command.List className="palette-list">
              <Command.Empty className="palette-empty">{t('workspace.palette.empty')}</Command.Empty>

              <Command.Group heading={t('workspace.palette.actions')}>
                <Item id="action:new-session" label={t('shell.title.newSession')} icon={<FolderPlus size={14} />} hint={hint('mod+n')}
                  onSelect={() => run(newSession)} />
                <Item id="action:toggle-sidebar" label={t('shell.title.toggleSidebar')} icon={<LayoutPanelLeft size={14} />} hint={hint('mod+b')}
                  onSelect={() => run(() => ui().setSidebarOpen(!ui().sidebarOpen))} />
                <Item id="action:toggle-inspector" label={t('shell.title.toggleInspector')} icon={<PanelRight size={14} />} hint={hint('mod+j')}
                  onSelect={() => run(() => ui().setInspectorOpen(!ui().inspectorOpen))} />
                <Item id="action:prompts" label={t('shell.rail.prompts')} icon={<BookMarked size={14} />} hint={hint('mod+p')}
                  onSelect={() => run(() => ui().setPromptPickerOpen(true))} />
                <Item id="action:shortcuts" label={t('workspace.keys.shortcuts')} icon={<Keyboard size={14} />} hint={hint('mod+/')}
                  onSelect={() => run(() => ui().setShortcutsOpen(true))} />
                <Item id="action:close-session" label={t('workspace.keys.closeSession')} icon={<X size={14} />} hint={hint('mod+w')}
                  onSelect={() => run(() => { const id = ui().activeSessionId; if (id) return closeSession(id); })} />
                {INSPECTOR_TABS.map(({ tab, labelKey }) => (
                  <Item key={tab} id={`inspector:${tab}`} label={`${t('shell.inspector.label')}: ${t(labelKey)}`} icon={<PanelRight size={14} />}
                    onSelect={() => run(() => ui().setInspectorTab(tab))} />
                ))}
              </Command.Group>

              {activeId ? (
                <Command.Group heading={t('chat.menu.label')}>
                  {SESSION_MENU.filter((item) => disabledReasonKey(item, menuContext) === null).map((item) => (
                    <Item key={item.id} id={`session-menu:${item.id}`} label={t(item.labelKey)} icon={<MessageSquare size={14} />}
                      onSelect={() => run(() => runSessionMenuItem(item.id, activeId, t))} />
                  ))}
                  <Item id="action:find" label={t('chat.find.label')} icon={<MessageSquare size={14} />} hint={hint('mod+f')}
                    onSelect={() => run(() => ui().setFindSession(activeId))} />
                </Command.Group>
              ) : null}

              {rows.length > 0 ? (
                <Command.Group heading={t('workspace.palette.sessions')}>
                  {rows.slice(0, MAX_SESSION_ITEMS).map((row) => (
                    <Item key={row.id} id={`session:${row.id}`} label={row.title ?? t('shell.sidebar.untitled')}
                      keywords={[row.cwd, row.model]} icon={<MessageSquare size={14} />}
                      hint={<span className="palette-sub">{workspaceLabel(row.cwd)}</span>} onSelect={() => run(() => openRow(row))} />
                  ))}
                </Command.Group>
              ) : null}

              <Command.Group heading={t('workspace.palette.settings')}>
                {SETTINGS_PAGES.map(({ page, labelKey }) => (
                  <Item key={page} id={`settings:${page}`} label={`${t('shell.rail.settings')}: ${t(labelKey)}`} icon={<Settings size={14} />}
                    onSelect={() => run(() => ui().openSettings(page))} />
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
