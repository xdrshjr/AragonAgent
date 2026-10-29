/** The sticky bar above the transcript: working directory, session id, checkpoint status, ⋯ menu. */

import {
  Check, Copy, FileDown, Folder, FolderOpen, GitBranch, MessageSquarePlus, MoreHorizontal, Save, X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { platform } from '../api.js';
import { useT, type MessageKey } from '../i18n/index.js';
import { basename, formatClock } from '../lib/chat-format.js';
import { comboParts } from '../lib/settings-shortcuts.js';
import { useSession } from '../store/session-store.js';
import { MenuList, type MenuItemData } from '../ui/MenuList.js';
import { Popover } from '../ui/overlay.js';
import { IconButton, Kbd } from '../ui/primitives.js';
import { useCopy } from './hooks.js';
import { runSessionMenuItem } from './session-menu-actions.js';
import { SESSION_MENU, disabledReasonKey, type SessionMenuItemId } from './session-menu.js';
import { changeDirectory } from './workdir.js';

const ICONS: Record<SessionMenuItemId, ReactNode> = {
  new: <MessageSquarePlus size={14} strokeWidth={1.5} />,
  save: <Save size={14} strokeWidth={1.5} />,
  export: <FileDown size={14} strokeWidth={1.5} />,
  branch: <GitBranch size={14} strokeWidth={1.5} />,
  'copy-id': <Copy size={14} strokeWidth={1.5} />,
  reveal: <FolderOpen size={14} strokeWidth={1.5} />,
  close: <X size={14} strokeWidth={1.5} />,
};

export function SessionBar({ sessionId }: { sessionId: string }) {
  const t = useT();
  const isMac = platform() === 'darwin';
  const cwd = useSession(sessionId, (mirror) => mirror?.meta?.cwd) ?? '';
  const restoredAt = useSession(sessionId, (mirror) => mirror?.meta?.restoredAt);
  const savedAt = useSession(sessionId, (mirror) => mirror?.checkpointAt);
  const running = useSession(sessionId, (mirror) => mirror?.view?.status === 'running');
  const { copied, copy } = useCopy();
  const [menuOpen, setMenuOpen] = useState(false);

  const items: MenuItemData[] = SESSION_MENU.map((item) => {
    const reasonKey = disabledReasonKey(item, { running, hasCwd: cwd !== '' });
    return {
      id: item.id,
      label: t(item.labelKey),
      icon: ICONS[item.id],
      separatorBefore: item.separatorBefore ?? false,
      disabled: reasonKey !== null,
      ...(reasonKey ? { disabledReason: t(reasonKey as MessageKey) } : {}),
      ...(item.shortcut ? { hint: <span className="menu-keys">{comboParts(item.shortcut, isMac).map((part) => <Kbd key={part}>{part}</Kbd>)}</span> } : {}),
    };
  });

  const select = (id: string): void => {
    setMenuOpen(false);
    runSessionMenuItem(id as SessionMenuItemId, sessionId, t, copy);
  };

  return (
    <div className="session-bar">
      <button type="button" className="chip" aria-disabled={running} title={running ? t('chat.bar.cwdBusy') : cwd}
        onClick={() => void changeDirectory(sessionId, t)}>
        <Folder size={14} strokeWidth={1.5} aria-hidden="true" />
        <span className="chip-text">{basename(cwd) || t('chat.bar.cwdNone')}</span>
        <span className="sr-only">{t('chat.bar.cwdChange')}</span>
      </button>
      <button type="button" className="chip chip-id" title={sessionId} onClick={() => copy(sessionId)}>
        {copied ? <Check size={14} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.5} aria-hidden="true" />}
        <span className="chip-text">{copied ? t('common.copied') : sessionId.slice(0, 8)}</span>
        <span className="sr-only">{t('chat.bar.copyId')}</span>
      </button>
      <span className="bar-spacer" />
      {restoredAt ? <span className="bar-note">{t('chat.bar.restored', { time: formatClock(restoredAt) })}</span> : null}
      {savedAt ? <span className="bar-note">{t('chat.bar.saved', { time: formatClock(savedAt) })}</span> : null}
      <Popover open={menuOpen} onOpenChange={setMenuOpen} align="end" side="bottom" className="menu-popover"
        trigger={(
          <IconButton size="sm" label={t('chat.menu.label')} aria-haspopup="menu" aria-expanded={menuOpen}>
            <MoreHorizontal size={16} strokeWidth={1.5} />
          </IconButton>
        )}>
        <MenuList items={items} label={t('chat.menu.label')} onSelect={select} />
      </Popover>
    </div>
  );
}
