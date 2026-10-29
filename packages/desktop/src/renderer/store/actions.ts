/**
 * Renderer-level flows that span stores: opening, closing and switching sessions.
 *
 * Opening a session is a three-party handshake and the order is what makes it safe:
 *   1. `sessions:open` - the main process starts (or reuses) the host, issues a one-time token
 *      and ALREADY transfers the port towards this window;
 *   2. `takePort(token)` - claim the buffered port that arrived with that token;
 *   3. `sessionStore.attach` - start mirroring; the host answers with a full snapshot.
 * A failure at any step leaves the mirror in an `error` phase with a message the UI can show
 * and a retry, never a half-open session.
 */

import { ipc, onBroadcast } from '../api.js';
import { pushToast } from '../chat/hooks.js';
import type { Translate } from '../i18n/index.js';
import { discardDraft } from '../lib/chat-drafts.js';
import { formatClock } from '../lib/chat-format.js';
import { describeFailure } from '../lib/chat-results.js';
import type { IpcErrorCode } from '../../shared/ipc-contract.js';
import { takePort } from './port-client.js';
import { sessionStore } from './session-store.js';
import { useSessionsList } from './sessions-list-store.js';
import { useUi } from './ui-store.js';

export type OpenOutcome =
  | { ok: true; sessionId: string }
  | { ok: false; code: IpcErrorCode | 'port_timeout'; message: string; sessionId?: string };

export interface OpenRequest {
  id?: string;
  cwd: string;
  branchOf?: string;
  readOnly?: boolean;
}

export async function openSession(request: OpenRequest): Promise<OpenOutcome> {
  const response = await ipc('sessions:open', request);
  if (!response.ok) return { ok: false, code: response.code, message: response.message, ...(request.id ? { sessionId: request.id } : {}) };
  const { sessionId, channelToken } = response.value;
  sessionStore.begin(sessionId);
  try {
    sessionStore.attach(sessionId, await takePort(sessionId, channelToken));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sessionStore.fail(sessionId, message);
    return { ok: false, code: 'port_timeout', message, sessionId };
  }
  useUi.getState().setActiveSession(sessionId);
  void useSessionsList.getState().refresh();
  return { ok: true, sessionId };
}

/** Close a session in this window and stop its host. */
export async function closeSession(id: string): Promise<void> {
  await ipc('sessions:close', { id });
  sessionStore.end(id);
  discardDraft(id);
  const ui = useUi.getState();
  if (ui.activeSessionId === id) {
    const next = sessionStore.all().find((mirror) => mirror.id !== id)?.id ?? null;
    ui.setActiveSession(next);
  }
  void useSessionsList.getState().refresh();
}

/** Re-attach a session whose port died (a parked or restarted host). */
export async function reconnectSession(id: string, cwd: string): Promise<OpenOutcome> {
  return openSession({ id, cwd });
}

/**
 * When a session host was lost and the main process has restarted it, re-attach the window on its
 * own. Without this the user sees "This session is not connected" and has to press Reconnect for a
 * recovery the supervisor already finished (found by the E2E run that kills the host).
 *
 * Only a session whose port is CLOSED is touched - a healthy one is never re-opened - and one
 * attempt per session is in flight at a time, so a flapping host cannot start a stampede.
 */
export function watchHostRecovery(): () => void {
  const inFlight = new Set<string>();
  return onBroadcast('session:status', ({ id, status }) => {
    if (status !== 'ready' && status !== 'running' && status !== 'waiting-approval') return;
    const mirror = sessionStore.get(id);
    const cwd = mirror?.meta?.cwd;
    if (!mirror || mirror.phase !== 'closed' || !cwd || inFlight.has(id)) return;
    inFlight.add(id);
    void reconnectSession(id, cwd).finally(() => inFlight.delete(id));
  });
}

/**
 * Branch a saved session into a new one in this window. The one implementation behind the sidebar
 * row's branch button, the "session busy elsewhere" dialog, the session menu and `/branch`.
 */
export async function branchSessionFrom(sourceId: string, cwd: string): Promise<OpenOutcome> {
  return openSession({ cwd, branchOf: sourceId });
}

/** Write a checkpoint now and say where it went. */
export async function saveCheckpoint(sessionId: string, t: Translate): Promise<void> {
  const result = await sessionStore.command(sessionId, { c: 'session.save' });
  if (!result.ok) { pushToast(sessionId, 'error', describeFailure(t, result)); return; }
  const path = (result.value as { path?: string } | undefined)?.path;
  pushToast(sessionId, 'info', path ? t('chat.save.done', { path }) : t('chat.bar.saved', { time: formatClock(Date.now()) }));
}

/**
 * Start a new conversation in this session. `/reset` is an alias of `/clear` in the engine and the host
 * recognises only the literal `clear` with no arguments, so that is exactly what is sent.
 */
export async function resetConversation(sessionId: string, t: Translate): Promise<void> {
  const result = await sessionStore.command(sessionId, { c: 'slash', name: 'clear', args: '' });
  if (!result.ok) pushToast(sessionId, 'error', describeFailure(t, result));
}

/** Branch the open session from the menu / `/branch`; failures surface as a toast on the SOURCE session. */
export async function branchSession(sessionId: string, t: Translate): Promise<void> {
  const cwd = sessionStore.get(sessionId)?.meta?.cwd;
  if (!cwd) { pushToast(sessionId, 'warn', t('chat.err.portClosed')); return; }
  const outcome = await branchSessionFrom(sessionId, cwd);
  if (!outcome.ok) pushToast(sessionId, 'error', outcome.message);
}
