import { describe, expect, it } from 'vitest';
import { createFoldState, foldAll, foldEvent } from '../shared/fold';
import type { ExecEvent } from '../shared/exec-events';

function events(...list: ExecEvent[]): ExecEvent[] {
  return list;
}

const INIT: ExecEvent = {
  type: 'system',
  subtype: 'init',
  schemaVersion: 1,
  sessionId: 'desktop-x',
  cli: '0.6.13',
  cwd: 'E:/work',
  startedAt: 1,
  model: { provider: 'anthropic', id: 'claude-sonnet-4-6', baseUrl: null },
  permissionMode: 'auto',
  tools: ['bash'],
  resumed: false,
};

describe('fold: init', () => {
  it('captures session id and model', () => {
    const state = foldAll([INIT]);
    expect(state.sessionId).toBe('desktop-x');
    expect(state.model?.id).toBe('claude-sonnet-4-6');
    expect(state.entries).toEqual([]);
  });
});

describe('fold: streaming text', () => {
  it('accumulates deltas into one streaming entry', () => {
    const state = foldAll(
      events(
        { type: 'text_delta', sessionId: 's', turn: 1, delta: 'Hello' },
        { type: 'text_delta', sessionId: 's', turn: 1, delta: ' world' },
      ),
    );
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0];
    expect(entry.kind).toBe('assistant');
    if (entry.kind === 'assistant') {
      expect(entry.text).toBe('Hello world');
      expect(entry.streaming).toBe(true);
    }
  });

  it('assistant event finalizes the open entry without duplicating it', () => {
    const state = foldAll(
      events(
        { type: 'text_delta', sessionId: 's', turn: 1, delta: 'partial' },
        { type: 'assistant', sessionId: 's', turn: 1, text: 'partial but final' },
      ),
    );
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0];
    if (entry.kind === 'assistant') {
      expect(entry.text).toBe('partial but final');
      expect(entry.streaming).toBe(false);
    }
  });

  it('a user event closes the streaming assistant', () => {
    const state = foldAll(
      events(
        { type: 'text_delta', sessionId: 's', turn: 1, delta: 'hi' },
        { type: 'user', sessionId: 's', turn: 2, text: 'next', source: 'caller' },
      ),
    );
    const first = state.entries[0];
    if (first.kind === 'assistant') expect(first.streaming).toBe(false);
    const second = state.entries[1];
    expect(second?.kind).toBe('user');
  });
});

describe('fold: tools', () => {
  const call: ExecEvent = {
    type: 'tool_call',
    sessionId: 's',
    turn: 1,
    id: 'tc1',
    name: 'bash',
    input: { command: 'npm test' },
  };
  const result: ExecEvent = {
    type: 'tool_result',
    sessionId: 's',
    turn: 1,
    id: 'tc1',
    name: 'bash',
    isError: false,
    durationMs: 1200,
    output: 'all passed',
  };

  it('pairs call and result by id', () => {
    const state = foldAll(events(call, result));
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0];
    expect(entry.kind).toBe('tool');
    if (entry.kind === 'tool') {
      expect(entry.status).toBe('done');
      expect(entry.output).toBe('all passed');
      expect(entry.durationMs).toBe(1200);
      expect(entry.input).toEqual({ command: 'npm test' });
    }
  });

  it('keeps unmatched calls running', () => {
    const state = foldAll(events(call));
    const entry = state.entries[0];
    if (entry.kind === 'tool') expect(entry.status).toBe('running');
  });

  it('synthesizes an entry for an orphan result instead of dropping output', () => {
    const state = foldAll(events(result));
    const entry = state.entries[0];
    if (entry.kind === 'tool') {
      expect(entry.status).toBe('done');
      expect(entry.output).toBe('all passed');
    }
  });
});

describe('fold: todo', () => {
  it('is a single evolving entry', () => {
    const base = {
      type: 'todo' as const,
      sessionId: 's',
      total: 2,
      done: 0,
      activeIndex: 0,
    };
    const state = createFoldState();
    foldEvent(state, { ...base, items: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'pending' }] });
    foldEvent(state, { ...base, done: 1, activeIndex: 1, items: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] });
    expect(state.entries).toHaveLength(1);
    const entry = state.entries[0];
    if (entry.kind === 'todo') {
      expect(entry.items[0].status).toBe('completed');
      expect(entry.activeIndex).toBe(1);
    }
  });
});

describe('fold: notices and usage', () => {
  it('turns retries, compaction and fatal errors into notices', () => {
    const state = foldAll(
      events(
        { type: 'retry', sessionId: 's', attempt: 1, maxRetries: 3, errorType: 'rate_limit', delayMs: 2000 },
        { type: 'compaction', sessionId: 's', turn: 1, subtype: 'start', trigger: 'pressure' },
        { type: 'compaction', sessionId: 's', turn: 1, subtype: 'end', trigger: 'pressure', applied: true, mode: 'summarized', tokensBefore: 100, tokensAfter: 40 },
        { type: 'error', sessionId: 's', fatal: true, code: 'boom', message: 'it broke' },
      ),
    );
    expect(state.entries.filter((entry) => entry.kind === 'notice')).toHaveLength(4);
  });

  it('skips a compaction end that applied nothing', () => {
    const state = foldAll(
      events({ type: 'compaction', sessionId: 's', turn: 1, subtype: 'end', trigger: 'overflow', applied: false }),
    );
    expect(state.entries).toHaveLength(0);
  });

  it('accumulates usage across results', () => {
    const result = (tokens: number): ExecEvent => ({
      type: 'result',
      schemaVersion: 1,
      sessionId: 's',
      isError: false,
      stopReason: 'end_turn',
      exitCode: 0,
      result: 'done',
      turns: 1,
      durationMs: 100,
      usage: { inputTokens: tokens, outputTokens: tokens * 2, totalTokens: tokens * 3 },
      cost: { amount: 0.01, currency: 'USD', known: true },
      model: { provider: 'anthropic', id: 'm' },
      todos: null,
      error: null,
    });
    const state = foldAll(events(result(10), result(5)));
    expect(state.usage.totalTokens).toBe(45);
    expect(state.usage.turns).toBe(2);
    expect(state.turnBusy).toBe(false);
  });
});

describe('fold: forward compatibility', () => {
  it('ignores unknown event types', () => {
    const state = createFoldState();
    const unknown = { type: 'shiny_new_event', payload: true } as unknown as ExecEvent;
    expect(() => foldEvent(state, unknown)).not.toThrow();
    expect(state.entries).toHaveLength(0);
  });
});
