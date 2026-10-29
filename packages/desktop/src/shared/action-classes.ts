/**
 * Who may dispatch each `ViewAction`, and which `ViewState` fields belong to the renderer.
 *
 * THE HOST OWNS THE AUTHORITATIVE `ViewState`; the renderer holds a mirror (spec D-3). Two
 * things keep the mirror honest, and both live here so a change to the reducer cannot slip
 * past them:
 *
 *   1. `ACTION_CLASSES` is a `Record<ViewAction['type'], ...>`. Add an action type to the
 *      terminal reducer and this file stops compiling until it is classified - that is the
 *      only defence against "the renderer applies an action the host never sends".
 *   2. `LOCAL_VIEW_KEYS` are the five fields only `local` actions write. A snapshot (resync,
 *      window reload, host restart) overwrites everything EXCEPT these, so an expanded tool
 *      card, the thinking toggle, an open overlay and an unexpired toast survive it (AC-40).
 *
 * `action-classes.test.ts` checks the two against each other by reducing every action on a
 * fixture state, which is what catches a new `host` action that writes a UI field.
 */

import type { ViewAction, ViewState } from '@aragon-agent/tui/model/agent/reducer';

export type ActionClass = 'host' | 'local';

export const ACTION_CLASSES: Record<ViewAction['type'], ActionClass> = {
  // Renderer-only: pure UI state, never checkpointed, never sent by the host.
  setOverlay: 'local',
  pushToast: 'local',
  dismissToast: 'local',
  toggleThinking: 'local',
  // The terminal's display-only developer-mode switch: renderer-owned view state in the
  // same family as `toggleThinking`. The desktop host never dispatches either.
  toggleDeveloperMode: 'local',
  setDeveloperMode: 'local',
  toggleExpand: 'local',
  retryTick: 'local',
  // Everything else is a domain action and only the host dispatches it.
  abortMark: 'host',
  clearTranscript: 'host',
  compactionEnd: 'host',
  compactionPhase: 'host',
  compactionSnapshot: 'host',
  compactionStart: 'host',
  compactionUsage: 'host',
  contextUsage: 'host',
  fastEnd: 'host',
  fastStart: 'host',
  fastTier: 'host',
  fastUsage: 'host',
  govEnd: 'host',
  govSnapshot: 'host',
  governanceCard: 'host',
  notice: 'host',
  resetConversation: 'host',
  resetUsage: 'host',
  restoreEntries: 'host',
  retryAttempt: 'host',
  retryScheduled: 'host',
  runEnd: 'host',
  runError: 'host',
  runStart: 'host',
  runStarting: 'host',
  serviceEnd: 'host',
  serviceStart: 'host',
  serviceUpdate: 'host',
  setAgentMode: 'host',
  steerQueued: 'host',
  steeringAccepted: 'host',
  steerWithdrawn: 'host',
  streamRestart: 'host',
  submit: 'host',
  taskSummaryPending: 'host',
  taskSummaryReady: 'host',
  teamEnd: 'host',
  teamStart: 'host',
  teamUpdate: 'host',
  teamUsage: 'host',
  textDelta: 'host',
  thinkingDelta: 'host',
  thinkingStart: 'host',
  todoCleared: 'host',
  todoUpdate: 'host',
  toolCallDelta: 'host',
  toolCallEnd: 'host',
  toolCallStart: 'host',
  toolExecEnd: 'host',
  toolExecStart: 'host',
  toolOutputDelta: 'host',
  turnEnd: 'host',
  turnStart: 'host',
  waitUpdate: 'host',
};

/**
 * Host actions that RESET a renderer-owned field (they empty `expandedToolIds` because the
 * entries it points at are gone). That is safe: the renderer mirror applies the same reducer,
 * so its copy empties too, and a snapshot keeping a few stale ids for vanished entries is
 * harmless. What a host action must never do is POPULATE a renderer-owned field.
 */
export const HOST_ACTIONS_THAT_RESET_LOCAL_KEYS: ReadonlySet<ViewAction['type']> = new Set([
  'clearTranscript', 'resetConversation', 'restoreEntries',
]);

/** The `ViewState` fields written only by `local` actions. */
export const LOCAL_VIEW_KEYS = [
  'overlay', 'toasts', 'expandedToolIds', 'thinkingVisible', 'developerMode',
] as const;

export type LocalViewKey = (typeof LOCAL_VIEW_KEYS)[number];

/**
 * Reduce one renderer-only action WITHOUT touching the host-owned id counter.
 *
 * `viewReducer` mints a toast id from `ViewState.seq`, the same counter that names transcript
 * entries. Letting a local toast advance the mirror's `seq` would make the mirror assign
 * different entry ids than the host for the same action (and re-key every row on the next
 * snapshot), so toasts are built here with their own id space and `seq` is never written.
 */
export function applyLocalAction(
  state: ViewState,
  action: ViewAction,
  reduce: (state: ViewState, action: ViewAction) => ViewState,
  nextToastId: () => string,
): ViewState {
  if (action.type === 'pushToast') {
    const toast = { id: nextToastId(), level: action.level, text: action.text, ttlMs: action.ttlMs ?? 2500 };
    return { ...state, toasts: [...state.toasts, toast] };
  }
  return reduce(state, action);
}

export function classifyAction(action: ViewAction): ActionClass {
  return ACTION_CLASSES[action.type];
}

export function isLocalAction(action: ViewAction): boolean {
  return ACTION_CLASSES[action.type] === 'local';
}

/**
 * Build the next mirror from a host snapshot.
 *
 * The snapshot is the base and the renderer's own UI fields are laid back over it. With no
 * previous mirror (first attach) the snapshot is adopted whole, which is also how the seeded
 * `thinkingVisible` default reaches the renderer.
 */
export function mergeSnapshot(previous: ViewState | null, snapshot: ViewState): ViewState {
  if (previous === null) return snapshot;
  const merged: ViewState = { ...snapshot };
  for (const key of LOCAL_VIEW_KEYS) {
    (merged as unknown as Record<string, unknown>)[key] = previous[key];
  }
  return merged;
}
