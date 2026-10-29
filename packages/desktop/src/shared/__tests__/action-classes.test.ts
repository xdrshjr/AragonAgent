/**
 * The mirror protocol's two safeguards, checked against each other (spec 3.4 / AC-40):
 * `ACTION_CLASSES` says who may dispatch an action, `LOCAL_VIEW_KEYS` says which state the
 * renderer owns. If a `host` action ever wrote one of those fields, a snapshot would silently
 * undo it (or the host and renderer would diverge) - so here every action we can build is
 * reduced on a realistic state and the fields it touches are compared with its class.
 */

import { describe, expect, it } from 'vitest';
import {
  initialViewState,
  viewReducer,
  type ViewAction,
  type ViewState,
} from '@aragon-agent/tui/model/agent/reducer';
import { emptyContextUsage } from '@aragon-agent/tui/model/compaction/meter';
import {
  ACTION_CLASSES,
  HOST_ACTIONS_THAT_RESET_LOCAL_KEYS,
  LOCAL_VIEW_KEYS,
  applyLocalAction,
  classifyAction,
  isLocalAction,
  mergeSnapshot,
} from '../action-classes.js';

const usage = { inputTokens: 10, outputTokens: 5 };

/** One representative action per type that can be built from public shapes alone. */
const FIXTURES: ViewAction[] = [
  { type: 'submit', text: 'hello' },
  { type: 'steerQueued', queueId: 'q1', text: 'later' },
  { type: 'steeringAccepted', ids: ['q1'] },
  { type: 'steerWithdrawn', queueId: 'q1' },
  { type: 'runStarting' },
  { type: 'runStart' },
  { type: 'turnStart' },
  { type: 'thinkingStart' },
  { type: 'thinkingDelta', delta: 'hm' },
  { type: 'textDelta', delta: 'hi there' },
  { type: 'toolCallStart', toolCallId: 't1', toolName: 'bash' },
  { type: 'toolCallDelta', toolCallId: 't1', argsDelta: '{"cmd":' },
  { type: 'toolCallEnd', toolCallId: 't1', args: { cmd: 'ls' } },
  { type: 'toolExecStart', toolCallId: 't1', toolName: 'bash' },
  { type: 'toolOutputDelta', toolCallId: 't1', rows: ['a', 'b'], at: 1 },
  { type: 'toolExecEnd', toolCallId: 't1', isError: false, duration: 12, preview: 'a\nb' },
  { type: 'turnEnd', usage, costDelta: 0.01 },
  { type: 'notice', level: 'info', text: 'note' },
  { type: 'retryScheduled', attempt: 1, maxRetries: 3, delayMs: 1000, resumeAt: 5, errorType: 'rate_limit', message: 'slow down' },
  { type: 'retryAttempt', attempt: 1, maxRetries: 3 },
  { type: 'streamRestart', discardedToolCallIds: [] },
  { type: 'fastStart', index: 1, turn: 1, model: 'm' },
  { type: 'fastUsage', usage, costDelta: 0 },
  { type: 'compactionUsage', usage, costDelta: 0 },
  { type: 'teamUsage', usage, costDelta: 0 },
  { type: 'contextUsage', snapshot: emptyContextUsage() },
  { type: 'abortMark' },
  { type: 'runError' },
  { type: 'runEnd' },
  { type: 'taskSummaryPending' },
  { type: 'setAgentMode', mode: 'plan', pending: null, posture: 'plan', pendingPosture: null },
  { type: 'govEnd' },
  { type: 'todoCleared' },
  { type: 'resetUsage' },
  { type: 'clearTranscript' },
  { type: 'restoreEntries', entries: [] },
  { type: 'resetConversation' },
];

const LOCAL_FIXTURES: ViewAction[] = [
  { type: 'setOverlay', overlay: null },
  { type: 'pushToast', level: 'info', text: 'saved' },
  { type: 'toggleThinking' },
  { type: 'toggleDeveloperMode' },
  { type: 'setDeveloperMode', value: true },
  { type: 'toggleExpand', id: 't1' },
  { type: 'retryTick' },
];

/** Types with a payload too large to fabricate here; they ride the same reducer and are listed so a
 *  new, unexercised type is a visible decision rather than a silent gap. */
const UNEXERCISED = new Set([
  'dismissToast', 'taskSummaryReady', 'govSnapshot', 'governanceCard', 'teamStart', 'teamUpdate',
  'teamEnd', 'todoUpdate', 'fastEnd', 'fastTier', 'compactionStart', 'compactionEnd',
  'compactionPhase', 'compactionSnapshot', 'serviceStart', 'serviceUpdate', 'serviceEnd', 'waitUpdate',
]);

const localKeys = new Set<string>(LOCAL_VIEW_KEYS);

function changedKeys(before: ViewState, after: ViewState): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !Object.is(
    (before as unknown as Record<string, unknown>)[key], (after as unknown as Record<string, unknown>)[key]));
}

describe('ACTION_CLASSES', () => {
  it('has exactly the eight renderer-only actions the terminal reducer shares with the UI', () => {
    const local = Object.entries(ACTION_CLASSES).filter(([, cls]) => cls === 'local').map(([type]) => type).sort();
    expect(local).toEqual([
      'dismissToast', 'pushToast', 'retryTick', 'setDeveloperMode', 'setOverlay', 'toggleDeveloperMode',
      'toggleExpand', 'toggleThinking',
    ].sort());
  });

  it('classifies every action the fixtures use, and the fixtures cover every type but the listed few', () => {
    const covered = new Set([...FIXTURES, ...LOCAL_FIXTURES].map((action) => action.type));
    for (const type of Object.keys(ACTION_CLASSES)) {
      expect(covered.has(type as ViewAction['type']) || UNEXERCISED.has(type), `${type} is neither exercised nor acknowledged`).toBe(true);
    }
    for (const type of UNEXERCISED) expect(ACTION_CLASSES).toHaveProperty(type);
  });

  it('exposes the same decision through classifyAction and isLocalAction', () => {
    expect(classifyAction({ type: 'textDelta', delta: 'x' })).toBe('host');
    expect(isLocalAction({ type: 'toggleThinking' })).toBe(true);
    expect(isLocalAction({ type: 'submit', text: 'x' })).toBe(false);
  });
});

describe('class and LOCAL_VIEW_KEYS agree (mutual verification)', () => {
  it('no host action POPULATES a renderer-owned field; only the documented resets may empty one', () => {
    let state = initialViewState({ thinkingVisible: false });
    state = viewReducer(state, { type: 'toggleExpand', id: 't1' });
    for (const action of FIXTURES) {
      const next = viewReducer(state, action);
      const touched = changedKeys(state, next).filter((key) => localKeys.has(key));
      if (touched.length > 0) {
        expect(HOST_ACTIONS_THAT_RESET_LOCAL_KEYS.has(action.type), `host action "${action.type}" wrote ${touched.join(', ')}`).toBe(true);
        expect(touched).toEqual(['expandedToolIds']);
        expect(next.expandedToolIds).toEqual({});
      }
      state = next;
    }
  });

  it('every local action touches only renderer-owned fields', () => {
    let state = viewReducer(initialViewState({ thinkingVisible: false }), { type: 'submit', text: 'hi' });
    for (const action of LOCAL_FIXTURES) {
      const next = viewReducer(state, action);
      const outside = changedKeys(state, next).filter((key) => !localKeys.has(key));
      // `retryTick` re-clones the live retry entry so its countdown re-renders; that is the one
      // local action allowed to touch `entries`. `pushToast` goes through `applyLocalAction`
      // below because the reducer would otherwise advance `seq` (a host-owned id counter).
      const allowed = action.type === 'retryTick' ? outside.filter((key) => key !== 'entries') : outside;
      const allowedWithoutSeq = action.type === 'pushToast' ? allowed.filter((key) => key !== 'seq') : allowed;
      expect(allowedWithoutSeq, `local action "${action.type}" wrote host-owned field(s) ${allowedWithoutSeq.join(', ')}`).toEqual([]);
      state = next;
    }
  });

  it('applyLocalAction never advances the host-owned id counter, even for toasts', () => {
    let state = viewReducer(initialViewState({ thinkingVisible: false }), { type: 'submit', text: 'hi' });
    const seq = state.seq;
    let counter = 0;
    for (const action of [...LOCAL_FIXTURES, { type: 'pushToast', level: 'warn', text: 'again' } as ViewAction]) {
      state = applyLocalAction(state, action, viewReducer, () => `lt${++counter}`);
      expect(state.seq).toBe(seq);
    }
    const ids = state.toasts.map((toast) => toast.id);
    expect(new Set(ids).size).toBe(ids.length); // two toasts never share an id
  });
});

describe('mergeSnapshot', () => {
  const snapshot = viewReducer(initialViewState({ thinkingVisible: false }), { type: 'submit', text: 'from the host' });

  it('adopts the snapshot whole on first attach', () => {
    expect(mergeSnapshot(null, snapshot)).toBe(snapshot);
  });

  it('keeps the renderer-owned fields and takes everything else from the snapshot (AC-40)', () => {
    let mine = initialViewState({ thinkingVisible: false });
    mine = viewReducer(mine, { type: 'toggleThinking' });
    mine = viewReducer(mine, { type: 'toggleExpand', id: 'tool-1' });
    mine = viewReducer(mine, { type: 'pushToast', level: 'info', text: 'still here' });
    const merged = mergeSnapshot(mine, snapshot);
    expect(merged.thinkingVisible).toBe(true);
    expect(merged.expandedToolIds).toEqual({ 'tool-1': true });
    expect(merged.toasts).toBe(mine.toasts);
    expect(merged.overlay).toBe(mine.overlay);
    expect(merged.entries).toBe(snapshot.entries);
  });
});

describe('structured clone safety', () => {
  it('every fixture action survives structuredClone unchanged', () => {
    for (const action of [...FIXTURES, ...LOCAL_FIXTURES]) {
      expect(structuredClone(action)).toEqual(action);
    }
  });

  it('a state built from the whole fixture sequence clones (the port does exactly this on every snapshot)', () => {
    let state = initialViewState({ thinkingVisible: false });
    for (const action of FIXTURES) state = viewReducer(state, action);
    const clone = structuredClone(state);
    expect(clone.entries).toEqual(state.entries);
    expect(clone.seenSteeringIds).toEqual(state.seenSteeringIds);
  });
});
