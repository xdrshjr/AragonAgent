/**
 * Executing a picked slash item. Only `clear` and `compact` run on the host; everything else
 * opens the desktop surface that replaced the terminal command (the parity matrix names it).
 */

import { changeDirectory } from '../chat/workdir.js';
import { pushToast } from '../chat/hooks.js';
import type { Translate } from '../i18n/index.js';
import { describeFailure } from '../lib/chat-results.js';
import type { SlashItem } from '../lib/chat-slash.js';
import { branchSession, closeSession, resetConversation, saveCheckpoint } from '../store/actions.js';
import { sessionStore } from '../store/session-store.js';
import { useUi } from '../store/ui-store.js';
import { emitComposerIntent } from './composer-bus.js';
import { cyclePosture } from './ModeChip.js';

async function runHostSlash(sessionId: string, name: 'clear' | 'compact', args: string, t: Translate): Promise<void> {
  const result = await sessionStore.command(sessionId, { c: 'slash', name, args });
  if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
}

/** `/plan` flips plan mode while keeping the governance dimension the user already chose. */
async function togglePlan(sessionId: string, t: Translate): Promise<void> {
  const posture = sessionStore.get(sessionId)?.view?.posture ?? 'build';
  const next = { build: 'plan', plan: 'build', govern: 'plan_govern', plan_govern: 'govern' }[posture] as typeof posture;
  const result = await sessionStore.command(sessionId, { c: 'posture.set', posture: next });
  if (!result.ok) pushToast(sessionId, 'warn', describeFailure(t, result));
}

/** Move focus to the first queued message's withdraw button; say so when nothing is queued. */
function focusQueue(sessionId: string, t: Translate): void {
  const button = document.querySelector<HTMLElement>('[data-queued="true"] .queue-mark button');
  if (button) { button.focus(); return; }
  pushToast(sessionId, 'info', t('chat.queue.empty'));
}

export function runSlashItem(item: SlashItem, args: string, sessionId: string, t: Translate): void {
  const action = item.action;
  const ui = useUi.getState();
  if (!action) {
    pushToast(sessionId, 'info', t('chat.slash.na', { target: item.target }));
    return;
  }
  switch (action.do) {
    case 'run': void runHostSlash(sessionId, action.name, args, t); return;
    case 'settings': ui.openSettings(action.page); return;
    case 'inspector': ui.setInspectorTab(action.tab); return;
    case 'palette': ui.setPaletteOpen(true); return;
    case 'prompts': ui.setPromptPickerOpen(true); return;
    case 'shortcuts': ui.setShortcutsOpen(true); return;
    case 'cwd': void changeDirectory(sessionId, t); return;
    case 'model': emitComposerIntent('open-model'); return;
    case 'plus-menu': emitComposerIntent('open-plus'); return;
    case 'posture-plan': void togglePlan(sessionId, t); return;
    case 'sidebar': ui.setSidebarOpen(true); return;
    case 'reset': void resetConversation(sessionId, t); return;
    case 'save': void saveCheckpoint(sessionId, t); return;
    case 'branch': void branchSession(sessionId, t); return;
    case 'focus-queue': focusQueue(sessionId, t); return;
    case 'close-session': void closeSession(sessionId); return;
    case 'copy-id':
      void navigator.clipboard?.writeText(sessionId).then(() => pushToast(sessionId, 'info', t('common.copied')));
      return;
  }
}

export { cyclePosture };
