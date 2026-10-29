/** What the buttons on an actionable error notice do. */

import type { Translate } from '../i18n/index.js';
import { findRetryText, type ErrorAction } from '../lib/chat-errors.js';
import { describeFailure } from '../lib/chat-results.js';
import { sessionStore } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { pushToast } from './hooks.js';

async function resubmit(sessionId: string, t: Translate): Promise<void> {
  const text = findRetryText(sessionStore.get(sessionId)?.view?.entries ?? []);
  if (text === null) {
    pushToast(sessionId, 'warn', t('chat.error.noRetry'));
    return;
  }
  const result = await sessionStore.command(sessionId, { c: 'submit', text });
  if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
}

export async function runErrorAction(sessionId: string, action: ErrorAction, t: Translate): Promise<void> {
  if (action === 'open-models') {
    useUi.getState().openSettings('models');
    return;
  }
  if (action === 'compact-retry') {
    const compacted = await sessionStore.command(sessionId, { c: 'compact' });
    if (!compacted.ok) {
      pushToast(sessionId, 'error', describeFailure(t, compacted));
      return;
    }
  }
  await resubmit(sessionId, t);
}
