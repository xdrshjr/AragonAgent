import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@aragon-agent/core';
import {
  buildToolPreview,
  initialViewState,
  reduceEvent,
  viewReducer,
  type Entry,
  type ViewAction,
  type ViewState,
} from '../agent/reducer.js';

function fold(state: ViewState, actions: ViewAction[]): ViewState {
  return actions.reduce(viewReducer, state);
}

function run(events: AgentEvent[], start = initialViewState()): ViewState {
  let s = start;
  for (const event of events) {
    s = fold(s, reduceEvent(event));
  }
  return s;
}

function assistantEntries(state: ViewState): Extract<Entry, { kind: 'assistant' }>[] {
  return state.entries.filter((e): e is Extract<Entry, { kind: 'assistant' }> => e.kind === 'assistant');
}

describe('event reducer — full turn', () => {
  it('accumulates text, tool cards, usage totals, and status transitions', () => {
    let state = viewReducer(initialViewState(), { type: 'submit', text: 'do it' });

    state = run(
      [
        { type: 'agent_start' },
        { type: 'turn_start' },
        { type: 'message_update', streamEvent: { type: 'text_delta', delta: 'Hel' } },
        { type: 'message_update', streamEvent: { type: 'text_delta', delta: 'lo' } },
        { type: 'message_update', streamEvent: { type: 'tool_call_start', toolCallId: 't1', toolName: 'bash' } },
        { type: 'message_update', streamEvent: { type: 'tool_call_delta', toolCallId: 't1', argsDelta: '{"command":"ls"}' } },
        {
          type: 'message_update',
          streamEvent: { type: 'tool_call_end', toolCallId: 't1', toolName: 'bash', args: { command: 'ls' } },
        },
        {
          type: 'turn_end',
          message: { role: 'assistant', content: [] },
          usage: { inputTokens: 100, outputTokens: 20 },
        },
        { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: {} },
        {
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'file1\nfile2' }] },
          isError: false,
          duration: 12,
        },
        { type: 'turn_start' },
        { type: 'message_update', streamEvent: { type: 'text_delta', delta: 'Done' } },
        {
          type: 'turn_end',
          message: { role: 'assistant', content: [] },
          usage: { inputTokens: 150, outputTokens: 5 },
        },
        { type: 'agent_end', messages: [] },
      ],
      state,
    );

    expect(state.status).toBe('idle');
    expect(state.usageTotal.inputTokens).toBe(250);
    expect(state.usageTotal.outputTokens).toBe(25);

    const texts = assistantEntries(state).map((e) => e.text);
    expect(texts).toContain('Hello');
    expect(texts).toContain('Done');
    for (const a of assistantEntries(state)) expect(a.streaming).toBe(false);

    const tool = state.entries.find((e) => e.kind === 'tool');
    expect(tool).toBeDefined();
    if (tool && tool.kind === 'tool') {
      expect(tool.name).toBe('bash');
      expect(tool.status).toBe('done');
      expect(tool.preview).toContain('file1');
      expect(tool.durationMs).toBe(12);
    }
  });
});

describe('silent-failure guard (R2)', () => {
  it('synthesizes an error notice when agent_end has no turn_end', () => {
    const state = run([{ type: 'agent_start' }, { type: 'turn_start' }, { type: 'agent_end', messages: [] }]);
    expect(state.status).toBe('idle');
    const notice = state.entries.find((e) => e.kind === 'notice');
    expect(notice).toBeDefined();
    if (notice && notice.kind === 'notice') {
      expect(notice.level).toBe('error');
    }
  });

  it('does NOT synthesize a failure notice after a user abort', () => {
    let state = viewReducer(initialViewState(), { type: 'submit', text: 'long task' });
    state = fold(state, reduceEvent({ type: 'agent_start' }));
    state = fold(state, reduceEvent({ type: 'turn_start' }));
    state = fold(state, reduceEvent({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'partial' } }));
    // User presses Esc: the App dispatches abortMark + an info notice, then the
    // engine breaks the loop and emits agent_end with no turn_end.
    state = viewReducer(state, { type: 'abortMark' });
    state = viewReducer(state, { type: 'notice', level: 'info', text: 'Run aborted.' });
    state = fold(state, reduceEvent({ type: 'agent_end', messages: [] }));

    expect(state.status).toBe('idle');
    const errorNotices = state.entries.filter((e) => e.kind === 'notice' && e.level === 'error');
    expect(errorNotices).toHaveLength(0);
    const assistant = state.entries.find((e) => e.kind === 'assistant');
    expect(assistant?.kind === 'assistant' && assistant.aborted).toBe(true);
  });

  it('renders the error StreamEvent and does NOT double-add a generic notice', () => {
    const state = run([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_update', streamEvent: { type: 'error', error: Object.assign(new Error('boom'), { errorType: 'auth_error' }) } },
      { type: 'agent_end', messages: [] },
    ]);
    const notices = state.entries.filter((e) => e.kind === 'notice');
    expect(notices).toHaveLength(1);
    if (notices[0] && notices[0].kind === 'notice') {
      expect(notices[0].level).toBe('error');
      expect(notices[0].text.toLowerCase()).toContain('authentication');
    }
  });
});

describe('overlay + thinking toggles', () => {
  it('sets and clears overlays and toggles thinking visibility', () => {
    let state = viewReducer(initialViewState(), { type: 'setOverlay', overlay: 'help' });
    expect(state.overlay).toBe('help');
    state = viewReducer(state, { type: 'setOverlay', overlay: null });
    expect(state.overlay).toBeNull();
    const before = state.thinkingVisible;
    state = viewReducer(state, { type: 'toggleThinking' });
    expect(state.thinkingVisible).toBe(!before);
  });
});

describe('toasts (§3.9)', () => {
  it('pushes and dismisses ephemeral toasts', () => {
    let state = viewReducer(initialViewState(), {
      type: 'pushToast',
      level: 'success',
      text: 'Saved.',
    });
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]!.level).toBe('success');
    expect(state.toasts[0]!.ttlMs).toBeGreaterThan(0);
    const id = state.toasts[0]!.id;

    state = viewReducer(state, { type: 'pushToast', level: 'info', text: 'Queued.' });
    expect(state.toasts).toHaveLength(2);

    state = viewReducer(state, { type: 'dismissToast', id });
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts.find((t) => t.id === id)).toBeUndefined();
  });
});

describe('tool expansion (§3.7)', () => {
  it('toggles expandedToolIds on and off', () => {
    let state = viewReducer(initialViewState(), { type: 'toggleExpand', id: 'e5' });
    expect(state.expandedToolIds.e5).toBe(true);
    state = viewReducer(state, { type: 'toggleExpand', id: 'e5' });
    expect(state.expandedToolIds.e5).toBeUndefined();
  });
});

describe('stored preview cap (P1-3)', () => {
  it('stores more than the 8-line collapsed view so Ctrl+O can reveal it', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const preview = buildToolPreview({ content: [{ type: 'text', text }] });
    expect(preview.split('\n').length).toBeGreaterThan(8);
    expect(preview).toContain('line 30');
  });
});

// ---------------------------------------------------------------------------
// agent-activity-presentation — thinking timing, the patch side channel, and
// the preview/patch exclusion (D-19 / AC-14a)
// ---------------------------------------------------------------------------

describe('thinking timing (§3.1.2)', () => {
  const thoughtThenAnswer: AgentEvent[] = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_update', streamEvent: { type: 'thinking_start' } },
    { type: 'message_update', streamEvent: { type: 'thinking_delta', delta: 'hmm' } },
    { type: 'message_update', streamEvent: { type: 'text_delta', delta: 'answer' } },
  ];

  it('starts the clock on thinkingStart and seals it at the FIRST text delta', () => {
    const state = run(thoughtThenAnswer);
    const entry = assistantEntries(state)[0]!;
    expect(entry.thinkingStartedAt).toBeTypeOf('number');
    expect(entry.thinkingMs).toBeTypeOf('number');
    expect(entry.thinkingMs).toBeGreaterThanOrEqual(0);
  });

  it('does not let the sealed duration climb with the answer', () => {
    let state = run(thoughtThenAnswer);
    const sealed = assistantEntries(state)[0]!.thinkingMs;
    state = fold(state, [{ type: 'textDelta', delta: ' and more' }]);
    expect(assistantEntries(state)[0]!.thinkingMs).toBe(sealed);
  });

  it('seals at turn end for a turn that thought and then only called a tool', () => {
    const state = run([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_update', streamEvent: { type: 'thinking_start' } },
      { type: 'message_update', streamEvent: { type: 'thinking_delta', delta: 'plan' } },
      {
        type: 'turn_end',
        message: { role: 'assistant', content: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);
    expect(assistantEntries(state)[0]!.thinkingMs).toBeTypeOf('number');
  });

  it('clears both fields on a stream restart — the reasoning was discarded', () => {
    let state = run(thoughtThenAnswer);
    state = fold(state, [{ type: 'streamRestart', discardedToolCallIds: [] }]);
    const entry = assistantEntries(state)[0]!;
    expect(entry.thinkingStartedAt).toBeUndefined();
    expect(entry.thinkingMs).toBeUndefined();
  });

  it('leaves a turn that never thought with no clock at all', () => {
    const state = run([
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_update', streamEvent: { type: 'text_delta', delta: 'straight to it' } },
    ]);
    expect(assistantEntries(state)[0]!.thinkingMs).toBeUndefined();
  });
});

describe('the patch side channel (§3.3.7 / AC-14a)', () => {
  const patch = {
    path: 'a.ts',
    kind: 'update' as const,
    added: 1,
    removed: 1,
    hunks: [],
    truncated: false,
    lineCount: 2,
  };

  const execEnd: AgentEvent = {
    type: 'tool_execution_end',
    toolCallId: 't1',
    toolName: 'edit_file',
    result: { content: [{ type: 'text', text: 'Applied edit to a.ts:\n- old\n+ new\n  ctx' }] },
    isError: false,
    duration: 3,
  };

  it('produces byte-identical actions when no source is supplied', () => {
    // Every existing test, and headless mode, take this path.
    expect(reduceEvent(execEnd)).toEqual([
      {
        type: 'toolExecEnd',
        toolCallId: 't1',
        isError: false,
        duration: 3,
        preview: 'Applied edit to a.ts:\n- old\n+ new\n  ctx',
      },
    ]);
  });

  it('attaches the patch and TRUNCATES the preview to one line (D-19)', () => {
    const actions = reduceEvent(execEnd, undefined, { take: () => patch });
    expect(actions).toEqual([
      {
        type: 'toolExecEnd',
        toolCallId: 't1',
        isError: false,
        duration: 3,
        preview: 'Applied edit to a.ts:',
        patch,
      },
    ]);
  });

  it('consumes the patch exactly once, and writes it onto the entry', () => {
    let taken = 0;
    const source = {
      take: (): typeof patch | undefined => (taken++ === 0 ? patch : undefined),
    };
    let state = viewReducer(initialViewState(), {
      type: 'toolCallStart',
      toolCallId: 't1',
      toolName: 'edit_file',
    });
    state = fold(state, reduceEvent(execEnd, undefined, source));
    const entry = state.entries[0]!;
    expect(entry.kind).toBe('tool');
    expect(entry.kind === 'tool' && entry.patch).toBe(patch);
    expect(taken).toBe(1);
  });

  it('never holds both a patch and a multi-line preview (AC-14a)', () => {
    const state = fold(
      viewReducer(initialViewState(), {
        type: 'toolCallStart',
        toolCallId: 't1',
        toolName: 'edit_file',
      }),
      reduceEvent(execEnd, undefined, { take: () => patch }),
    );
    for (const entry of state.entries) {
      if (entry.kind !== 'tool' || !entry.patch) continue;
      expect(entry.preview?.includes('\n')).toBe(false);
    }
  });
});
