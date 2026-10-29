/** Changing a session's working directory (the session bar chip and `/cwd` share this). */

import { ipc } from '../api.js';
import type { Translate } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore } from '../store/session-store.js';
import { pushToast } from './hooks.js';

export async function changeDirectory(sessionId: string, t: Translate): Promise<void> {
  if (sessionStore.get(sessionId)?.view?.status === 'running') {
    // The control stays reachable and explains itself rather than going silently dead.
    pushToast(sessionId, 'info', t('chat.bar.cwdBusy'));
    return;
  }
  const picked = await ipc('workspace:pick');
  if (!picked.ok) {
    pushToast(sessionId, 'error', picked.message);
    return;
  }
  if (!picked.value.path) return;
  const result = await sessionStore.command(sessionId, { c: 'cwd.set', path: picked.value.path });
  if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
}
