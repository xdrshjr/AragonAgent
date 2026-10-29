/** The [+] menu: tools settings, "attach a path" (@ mention) and the project index build. */

import { AtSign, Database, Plus, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { pushToast } from '../chat/hooks.js';
import { useT } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { Dialog, Popover } from '../ui/overlay.js';
import { Button } from '../ui/primitives.js';
import { emitComposerIntent, onComposerIntent } from './composer-bus.js';

export function PlusMenu({ sessionId }: { sessionId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  useEffect(() => onComposerIntent('open-plus', () => setOpen(true)), []);

  const buildIndex = async (): Promise<void> => {
    setStarting(true);
    const result = await sessionStore.command(sessionId, { c: 'index.build' });
    setStarting(false);
    setConfirming(false);
    if (!result.ok) pushToast(sessionId, result.code === 'busy' ? 'info' : 'warn', describeFailure(t, result));
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen} side="top" align="start"
        trigger={(
          <button type="button" className="status-chip chip-icon" aria-label={t('chat.plus.label')} title={t('chat.plus.label')}>
            <Plus size={14} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}>
        <ul className="menu" role="menu" aria-label={t('chat.plus.label')}>
          <li role="none">
            <button type="button" role="menuitem" className="menu-item"
              onClick={() => { setOpen(false); useUi.getState().openSettings('agent'); }}>
              <Wrench size={14} strokeWidth={1.5} aria-hidden="true" /> <span>{t('chat.plus.tools')}</span>
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" className="menu-item"
              onClick={() => { setOpen(false); emitComposerIntent('insert-at', '@'); }}>
              <AtSign size={14} strokeWidth={1.5} aria-hidden="true" /> <span>{t('chat.plus.attach')}</span>
            </button>
          </li>
          <li role="none">
            <button type="button" role="menuitem" className="menu-item"
              onClick={() => { setOpen(false); setConfirming(true); }}>
              <Database size={14} strokeWidth={1.5} aria-hidden="true" />
              <span>{t('chat.plus.index')}</span>
            </button>
          </li>
        </ul>
      </Popover>
      <Dialog open={confirming} onOpenChange={(next) => { if (!starting) setConfirming(next); }}
        title={t('chat.index.title')} description={t('chat.index.body')}
        actions={(
          <>
            <Button onClick={() => setConfirming(false)} disabled={starting}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={() => void buildIndex()} disabled={starting}>{t('chat.index.confirm')}</Button>
          </>
        )}>
        <ul className="dialog-list">
          <li>{t('chat.index.writes')}</li>
          <li>{t('chat.index.visible')}</li>
        </ul>
      </Dialog>
    </>
  );
}
