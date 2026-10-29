/**
 * Which sessions this window had open, kept in `sessionStorage` so that a renderer crash (or a
 * reload) re-attaches them. `sessionStorage` is the right scope: it survives a reload of the same
 * window, and is empty at a fresh launch - so the app still opens on the welcome page after a quit,
 * as it always did, while a crash recovery puts the user back where they were.
 *
 * Only ids and working directories are stored (no conversation text). The session hosts live in the
 * main process and are not affected by a renderer crash, so re-opening is `sessions:open` on a live
 * host: it answers with a fresh snapshot and the transcript comes back from the host's memory.
 */

import { openSession } from './actions.js';
import { useUi } from './ui-store.js';

const KEY = 'aragon.open-sessions.v1';
const MAX_SESSIONS = 24;

export interface RestorableSession {
  id: string;
  cwd: string;
}

export interface OpenSnapshot {
  sessions: RestorableSession[];
  active: string | null;
}

function area(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function parseSnapshot(raw: string | null): OpenSnapshot | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OpenSnapshot>;
    if (!Array.isArray(value.sessions)) return null;
    const sessions = value.sessions
      .filter((entry): entry is RestorableSession => typeof entry?.id === 'string' && typeof entry.cwd === 'string' && entry.cwd !== '')
      .map((entry) => ({ id: entry.id, cwd: entry.cwd })) // rebuilt, so nothing else a stored value carries is passed on
      .slice(0, MAX_SESSIONS);
    return { sessions, active: typeof value.active === 'string' ? value.active : null };
  } catch {
    return null;
  }
}

/** Read ONCE, when the renderer loads and before anything has a chance to overwrite it. */
export const INITIAL_SNAPSHOT: OpenSnapshot | null = parseSnapshot((() => {
  try { return area()?.getItem(KEY) ?? null; } catch { return null; }
})());

let restoring = INITIAL_SNAPSHOT !== null && INITIAL_SNAPSHOT.sessions.length > 0;

/** Record the current open set. Ignored while a restore is still re-opening (it would write "empty"). */
export function writeSnapshot(sessions: RestorableSession[], active: string | null): void {
  if (restoring) return;
  try {
    area()?.setItem(KEY, JSON.stringify({ sessions: sessions.slice(0, MAX_SESSIONS), active } satisfies OpenSnapshot));
  } catch { /* storage unavailable: the app works, it just cannot self-heal */ }
}

/**
 * Re-attach what was open. Sessions that no longer exist (deleted meanwhile) are skipped; the active
 * one is selected last so the user lands where they were.
 */
export async function restoreOpenSessions(
  snapshot: OpenSnapshot | null, known: ReadonlySet<string>,
): Promise<void> {
  try {
    if (!snapshot) return;
    for (const entry of snapshot.sessions) {
      if (!known.has(entry.id)) continue;
      await openSession({ id: entry.id, cwd: entry.cwd });
    }
    if (snapshot.active && snapshot.sessions.some((entry) => entry.id === snapshot.active)) {
      useUi.getState().setActiveSession(snapshot.active);
    }
  } finally {
    restoring = false;
  }
}

export function isRestoring(): boolean {
  return restoring;
}
