/** Running a session-menu item: shared by the ⋯ menu and the command palette. */

import { ipc } from '../api.js';
import type { Translate } from '../i18n/index.js';
import { branchSession, closeSession, resetConversation, saveCheckpoint } from '../store/actions.js';
import { sessionStore } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { pushToast } from './hooks.js';
import type { SessionMenuItemId } from './session-menu.js';

export function runSessionMenuItem(
  id: SessionMenuItemId, sessionId: string, t: Translate, copyId?: (id: string) => void,
): void {
  switch (id) {
    case 'new': void resetConversation(sessionId, t); return;
    case 'save': void saveCheckpoint(sessionId, t); return;
    case 'export': useUi.getState().setExportSession(sessionId); return;
    case 'branch': void branchSession(sessionId, t); return;
    case 'copy-id':
      if (copyId) copyId(sessionId);
      else void navigator.clipboard?.writeText(sessionId).then(() => pushToast(sessionId, 'info', t('common.copied')));
      return;
    case 'reveal': {
      const cwd = sessionStore.get(sessionId)?.meta?.cwd;
      if (cwd) void ipc('native:open-path', { sessionId, relPath: cwd, reveal: true });
      return;
    }
    case 'close': void closeSession(sessionId); return;
  }
}
