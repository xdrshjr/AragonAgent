/**
 * "A turn finished" system notifications.
 *
 * The renderer knows what was said (the mirror holds the transcript) and the main process knows
 * whether any window has focus, so the work is split: this module decides WHEN a notice is worth
 * sending - a session went from running to idle - and builds its text, then asks the main process
 * through `native:notify`, which drops it when a window is focused (a notice on top of the window
 * you are reading is noise). Approval requests are notified by the main process itself.
 */

import { ipc } from '../api.js';
import { translate } from '../i18n/index.js';
import { clip } from '../lib/chat-format.js';
import { workspaceLabel } from './sessions-list-store.js';
import { sessionStore, type SessionMirror } from './session-store.js';
import { useSessionsList } from './sessions-list-store.js';

/** Longer than the host's frame batching (~16 ms), short enough to feel immediate. */
export const SETTLE_MS = 80;

/** First line of the last assistant message, clipped; the generic line when there was none. */
export function turnEndBody(mirror: SessionMirror): string {
  const entries = mirror.view?.entries ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind === 'user' || entry.kind === 'queued') break; // nothing was said since the question
    if (entry.kind !== 'assistant') continue;
    const firstLine = entry.text.split(/\r?\n/).find((line) => line.trim() !== '')?.trim();
    if (firstLine) return clip(firstLine, 120);
  }
  return translate('notify.turnDone');
}

export function turnEndTitle(mirror: SessionMirror): string {
  const row = useSessionsList.getState().rows.find((candidate) => candidate.id === mirror.id);
  return row?.title?.trim() || workspaceLabel(mirror.meta?.cwd ?? row?.cwd ?? '') || 'AragonAgent';
}

/** Subscribe to the session store; returns the unsubscribe. */
export function watchTurnEnd(): () => void {
  const previous = new Map<string, SessionMirror['runStatus']>();
  return sessionStore.subscribe(() => {
    for (const mirror of sessionStore.all()) {
      const before = previous.get(mirror.id);
      previous.set(mirror.id, mirror.runStatus);
      const wasBusy = before === 'running' || before === 'waiting-approval';
      if (wasBusy && mirror.runStatus === 'idle') {
        // The host sends the status event at once but batches transcript actions per frame, so the
        // last words of the reply can arrive just AFTER "idle". Read the mirror a moment later.
        const id = mirror.id;
        setTimeout(() => {
          const latest = sessionStore.get(id);
          if (latest) void ipc('native:notify', { title: turnEndTitle(latest), body: turnEndBody(latest), sessionId: id });
        }, SETTLE_MS);
      }
    }
  });
}
