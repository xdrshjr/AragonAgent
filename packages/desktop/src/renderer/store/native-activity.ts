/**
 * "How much is going on", reported to the main process for the taskbar / dock: a progress bar while
 * something runs in the background, an attention flash (Windows) or badge + bounce (macOS) while a session
 * waits for an answer. The decision of what to DO with the numbers is the main process's
 * (`main/native-bridge.ts` `planActivity`); this module only counts and rate-limits.
 */

import { ipc } from '../api.js';
import { sessionStore, type SessionMirror } from './session-store.js';

/** At most one report per this many ms: a streaming reply changes the store dozens of times a second. */
export const ACTIVITY_THROTTLE_MS = 250;

export interface Activity {
  running: number;
  waiting: number;
}

export function summarizeActivity(mirrors: readonly Pick<SessionMirror, 'runStatus'>[]): Activity {
  let running = 0;
  let waiting = 0;
  for (const mirror of mirrors) {
    if (mirror.runStatus === 'running') running += 1;
    else if (mirror.runStatus === 'waiting-approval') waiting += 1;
  }
  return { running, waiting };
}

/** Subscribe to the session store; returns the unsubscribe. Reports only when the numbers change. */
export function watchActivity(send: (activity: Activity) => void = (activity) => { void ipc('native:activity', activity); }): () => void {
  let last: Activity | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    timer = null;
    const next = summarizeActivity(sessionStore.all());
    if (last && last.running === next.running && last.waiting === next.waiting) return;
    last = next;
    send(next);
  };
  const unsubscribe = sessionStore.subscribe(() => {
    // Trailing edge: the first change starts the clock, later ones inside the window ride along.
    if (timer === null) timer = setTimeout(flush, ACTIVITY_THROTTLE_MS);
  });
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}
