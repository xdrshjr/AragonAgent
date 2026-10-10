/**
 * Stream translation and budgets (cli-integration-surface section 3.3 / 3.5 /
 * AC-16 / AC-17).
 *
 * THE CONTROLLER IS AN OBJECT LITERAL, which is the property
 * `HeadlessController` was designed for and the reason `ExecRunnerController`
 * extends it rather than naming `AgentController`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, ModelInfo } from '@aragon-agent/core';
import { ExecRunner, singlePrompt, type ExecRunnerController } from '../exec/runner.js';
import { StreamJsonEmitter } from '../exec/emitter.js';
import type { ExecEvent } from '../exec/events.js';
import type { TeamEvent } from '../team/types.js';
import type { CompactionEvent } from '../compaction/types.js';

const MODEL: ModelInfo = {
  id: 'm',
  name: 'M',
  provider: 'anthropic',
  contextWindow: 200_000,
  maxOutputTokens: 8192,
  supportsThinking: false,
  supportsTools: true,
  supportsImages: false,
  cost: { input: 0, output: 0 },
};

function sink(): { stream: NodeJS.WritableStream; lines: () => ExecEvent[] } {
  const chunks: string[] = [];
  return {
    stream: {
      write: (s: string) => {
        chunks.push(String(s));
        return true;
      },
    } as unknown as NodeJS.WritableStream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ExecEvent),
  };
}

interface StubOptions {
  onRun?: (call: number, emit: (e: AgentEvent) => void) => void;
}

function makeStub(options: StubOptions = {}): {
  controller: ExecRunnerController;
  prompts: string[];
  aborts: () => number;
} {
  const listeners: ((e: AgentEvent) => void)[] = [];
  const emit = (e: AgentEvent): void => {
    for (const l of listeners) l(e);
  };
  const prompts: string[] = [];
  let aborted = 0;
  const controller: ExecRunnerController = {
    preflight: () => ({ ok: true }),
    subscribe: (l) => {
      listeners.push(l);
      return () => {
        const i = listeners.indexOf(l);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getModelInfo: () => MODEL,
    abort: () => {
      aborted += 1;
    },
    prompt: async (text: string) => {
      prompts.push(text);
      if (options.onRun) options.onRun(prompts.length, emit);
      else healthyTurn(emit, `answer ${prompts.length}`, () => aborted > 0);
    },
  };
  return { controller, prompts, aborts: () => aborted };
}

/**
 * One turn as the ENGINE emits it: `turn_start` before the work, `turn_end`
 * after.
 *
 * `turn_start` IS NOT DECORATION HERE. The turn budget is enforced there rather
 * than at `turn_end` (IF-3), so a stub that skipped it would make the budget
 * cases pass for the wrong reason - or not fire at all.
 *
 * `isAborted` models what a real controller does when the budget aborts it
 * mid-turn: the loop stops before producing another assistant message.
 */
function healthyTurn(
  emit: (e: AgentEvent) => void,
  text: string,
  isAborted: () => boolean = () => false,
): void {
  emit({ type: 'agent_start' } as AgentEvent);
  emit({ type: 'turn_start' } as AgentEvent);
  if (isAborted()) {
    emit({ type: 'agent_end', messages: [] } as AgentEvent);
    return;
  }
  emit({
    type: 'turn_end',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { inputTokens: 3, outputTokens: 4 },
  } as AgentEvent);
  emit({ type: 'agent_end', messages: [] } as AgentEvent);
}

function makeRunner(
  out: NodeJS.WritableStream,
  extra: Partial<ConstructorParameters<typeof ExecRunner>[0]> = {},
): ExecRunner {
  return new ExecRunner({
    emitter: new StreamJsonEmitter(out),
    sessionId: 's1',
    quiet: true,
    // Never the real terminator in a unit test: replacing the process-wide one
    // would leak into every case that ran afterwards.
    signals: { setTerminator: () => {}, exit: () => {} },
    ...extra,
  });
}

describe('event translation', () => {
  it('retains billed compaction usage separately with cache terms and unknown pricing', () => {
    const out = sink();
    const { controller } = makeStub();
    let publish!: (event: CompactionEvent) => void;
    controller.subscribeCompaction = (listener) => { publish = listener; return () => {}; };
    const runner = makeRunner(out.stream);
    runner.attach(controller);
    publish({ type: 'usage', usage: { inputTokens: 100, outputTokens: 10,
      cacheReadTokens: 50, cacheWriteTokens: 25 }, costUsd: 1.25, pricingUnknown: false });
    publish({ type: 'usage', usage: { inputTokens: 5, outputTokens: 1 },
      costUsd: 0, pricingUnknown: true });
    expect(runner.stats().compactionBilling).toEqual({
      usage: { inputTokens: 105, outputTokens: 11, cacheReadTokens: 50, cacheWriteTokens: 25 },
      costUsd: 1.25, pricingUnknown: true,
    });
    expect(runner.stats().usage.cacheReadTokens).toBe(50);
    runner.detach();
  });
  it.each([false, true])('keeps compaction decision fields optional: %s', (metadata) => {
    const out = sink();
    const { controller } = makeStub();
    let publish: ((event: CompactionEvent) => void) | undefined;
    controller.subscribeCompaction = (listener) => { publish = listener; return () => {}; };
    const runner = makeRunner(out.stream);
    runner.attach(controller);
    const decision = { occupied: 90, contextWindow: 100, threshold: 0.9,
      source: 'usage' as const, deltaTokens: 0 };
    publish!({ type: 'compaction_end', record: {
      index: 1, trigger: 'manual', mode: 'summarized', applied: true,
      messagesBefore: 10, messagesAfter: 4, tokensBefore: 90, tokensAfter: 40,
      model: 'summary', durationMs: 1, ...(metadata ? { decision, memoryVersion: 2 as const } : {}),
    } });
    const event = out.lines().find((item) => item.type === 'compaction');
    if (metadata) expect(event).toMatchObject({ decision, memoryVersion: 2 });
    else {
      expect(event).not.toHaveProperty('decision');
      expect(event).not.toHaveProperty('memoryVersion');
    }
    runner.detach();
  });
  it('emits user, assistant, tool_call and tool_result in order', async () => {
    const out = sink();
    const { controller } = makeStub({
      onRun: (_call, emit) => {
        emit({ type: 'agent_start' } as AgentEvent);
        emit({
          type: 'tool_execution_start',
          toolCallId: 't1',
          toolName: 'read_file',
          args: { path: 'a.txt' },
        } as AgentEvent);
        emit({
          type: 'tool_execution_end',
          toolCallId: 't1',
          toolName: 'read_file',
          result: { content: [{ type: 'text', text: 'contents' }] },
          isError: false,
          duration: 7,
        } as AgentEvent);
        healthyTurn(emit, 'final');
      },
    });
    const runner = makeRunner(out.stream);
    runner.attach(controller);
    await runner.run(singlePrompt('hi'));
    runner.detach();

    const types = out.lines().filter((e) => e.type !== 'execution_progress').map((e) => e.type);
    expect(types).toEqual(['turn_state', 'user', 'tool_call', 'tool_result', 'assistant', 'turn_state']);
    const toolResult = out.lines().find((e) => e.type === 'tool_result') as { output: string; durationMs: number };
    expect(toolResult.output).toBe('contents');
    expect(toolResult.durationMs).toBe(7);
    expect(runner.stats().lastAssistantText).toBe('final');
    expect(runner.exitCode()).toBe(0);
  });

  it('omits text_delta and thinking unless they were asked for', async () => {
    const out = sink();
    const { controller } = makeStub({
      onRun: (_call, emit) => {
        emit({ type: 'message_update', streamEvent: { type: 'thinking_delta', delta: 'hm' } } as AgentEvent);
        emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'a' } } as AgentEvent);
        healthyTurn(emit, 'a');
      },
    });
    const runner = makeRunner(out.stream);
    runner.attach(controller);
    await runner.run(singlePrompt('hi'));
    const types = out.lines().filter((e) => e.type !== 'execution_progress').map((e) => e.type);
    expect(types).not.toContain('text_delta');
    expect(types).not.toContain('thinking');
  });

  it('emits them when they were', async () => {
    const out = sink();
    const { controller } = makeStub({
      onRun: (_call, emit) => {
        emit({ type: 'message_update', streamEvent: { type: 'thinking_delta', delta: 'hm' } } as AgentEvent);
        emit({ type: 'message_update', streamEvent: { type: 'text_delta', delta: 'a' } } as AgentEvent);
        healthyTurn(emit, 'a');
      },
    });
    const runner = makeRunner(out.stream, { partialMessages: true, includeThinking: true });
    runner.attach(controller);
    await runner.run(singlePrompt('hi'));
    const types = out.lines().filter((e) => e.type !== 'execution_progress').map((e) => e.type);
    // Thinking is flushed when text starts, so it precedes the first delta.
    expect(types).toEqual(['turn_state', 'user', 'thinking', 'text_delta', 'assistant', 'turn_state']);
  });

  it('reports a stream error as fatal and exits 1', async () => {
    const out = sink();
    const { controller } = makeStub({
      onRun: (_call, emit) => {
        emit({
          type: 'message_update',
          streamEvent: { type: 'error', error: new Error('boom') },
        } as AgentEvent);
        emit({ type: 'agent_end', messages: [] } as AgentEvent);
      },
    });
    const runner = makeRunner(out.stream);
    runner.attach(controller);
    await runner.run(singlePrompt('hi'));
    expect(runner.exitCode()).toBe(1);
    expect(runner.stats().stopReason).toBe('error');
    const error = out.lines().find((e) => e.type === 'error') as { fatal: boolean };
    expect(error.fatal).toBe(true);
  });
});

describe('AC-16: --max-turns', () => {
  it('a model that would take five turns stops at two: exit 3, partial answer kept', async () => {
    const out = sink();
    // ONE prompt, five turns inside it - the ordinary case, and the one a
    // ceiling enforced only between caller messages would never catch.
    let turn = 0;
    const { controller, aborts } = makeStub({
      onRun: (_call, emit) => {
        for (let i = 0; i < 5; i += 1) {
          emit({ type: 'turn_start' } as AgentEvent);
          if (aborted) break;
          turn += 1;
          emit({
            type: 'turn_end',
            message: { role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }] },
            usage: { inputTokens: 3, outputTokens: 4 },
          } as AgentEvent);
        }
        emit({ type: 'agent_end', messages: [] } as AgentEvent);
      },
    });
    let aborted = false;
    const runner = makeRunner(out.stream, { maxTurns: 2 });
    const original = controller.abort;
    controller.abort = (): void => {
      aborted = true;
      original();
    };
    runner.attach(controller);
    await runner.run(singlePrompt('do five things'));

    expect(runner.stats().stopReason).toBe('max_turns');
    expect(runner.exitCode()).toBe(3);
    // NOT an error: a budget the caller set firing is not a malfunction.
    expect(runner.stats().errored).toBe(false);
    expect(runner.stats().turns).toBe(2);
    expect(runner.stats().lastAssistantText).toBe('answer 2');
    expect(aborts()).toBe(1);
  });

  it('stops before consuming a further caller message', async () => {
    const out = sink();
    const { controller, prompts } = makeStub();
    const runner = makeRunner(out.stream, { maxTurns: 2 });
    runner.attach(controller);
    let served = 0;
    await runner.run({ next: async () => (served++ < 5 ? `turn ${served}` : null) });
    expect(runner.stats().stopReason).toBe('max_turns');
    // Two prompts, not three: the third message is not sent to the model at all.
    expect(prompts).toHaveLength(2);
  });

  it('IF-3: a run that ENDS in exactly --max-turns turns exits 0, not 3', async () => {
    // The failure this ordering exists to prevent: a CI script running
    // `aragon exec --max-turns 20 ... || fail` must not fail on a successful
    // twenty-turn run. The ceiling is a safety bound, not a target.
    const out = sink();
    const { controller } = makeStub();
    const runner = makeRunner(out.stream, { maxTurns: 1 });
    runner.attach(controller);
    await runner.run(singlePrompt('one turn is enough'));
    expect(runner.stats().turns).toBe(1);
    expect(runner.stats().stopReason).toBe('end_turn');
    expect(runner.exitCode()).toBe(0);
  });

  it('does not fire below the ceiling', async () => {
    const out = sink();
    const { controller } = makeStub();
    const runner = makeRunner(out.stream, { maxTurns: 5 });
    runner.attach(controller);
    await runner.run(singlePrompt('hi'));
    expect(runner.stats().stopReason).toBe('end_turn');
    expect(runner.exitCode()).toBe(0);
  });
});

describe('AC-17: --max-duration', () => {
  it('aborts on the wall clock, exits 3, and clears the timer', async () => {
    vi.useFakeTimers();
    try {
      const out = sink();
      let release: (() => void) | null = null;
      const { controller, aborts } = makeStub({
        onRun: (_call, emit) => {
          // A slow stub: it settles only once the timer has fired and aborted.
          release = () => healthyTurn(emit, 'partial');
        },
      });
      const runner = makeRunner(out.stream, { maxDurationMs: 1000 });
      runner.attach(controller);
      const promise = runner.run({
        next: async () => (release === null ? 'go' : null),
      });
      await vi.advanceTimersByTimeAsync(1500);
      (release as unknown as () => void)?.();
      await promise;

      expect(runner.stats().stopReason).toBe('timeout');
      expect(runner.exitCode()).toBe(3);
      expect(aborts()).toBe(1);
      runner.detach();
      // Cleared, so it can never fire against a disposed controller (R-10).
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('per-input lifecycle', () => {
  it('wraps multiple model turns and two todo continuations in one request', async () => {
    const out = sink();
    const stub = makeStub({ onRun: (call, emit) => {
      emit({ type: 'message_update', streamEvent: { type: 'thinking_delta', delta: 'reason' } } as AgentEvent);
      healthyTurn(emit, `answer ${call}`);
      if (call === 1) healthyTurn(emit, 'another model turn');
    } });
    stub.controller.getTodoSnapshot = () => ({
      items: [0, 1, 2].map(i => ({ content: `step ${i}`, activeForm: `doing ${i}`,
        status: i < stub.prompts.length ? 'completed' as const : 'pending' as const })),
      total: 3, doneCount: stub.prompts.length, activeIndex: stub.prompts.length < 3 ? stub.prompts.length : -1,
      updatedAt: stub.prompts.length,
    });
    const runner = makeRunner(out.stream, { followThrough: 'auto' });
    runner.attach(stub.controller);
    await runner.run(singlePrompt('finish all steps'));
    expect(stub.prompts).toHaveLength(3);
    const progress = out.lines().filter(e => e.type === 'execution_progress');
    expect(progress.map(e => e.requestSeq)).toEqual([1, 1]);
    expect(progress.map(e => e.progressSeq)).toEqual([1, 3]);
    expect(out.lines().filter(e => e.type === 'turn_state')).toEqual([
      { type: 'turn_state', sessionId: 's1', requestSeq: 1, phase: 'started' },
      { type: 'turn_state', sessionId: 's1', requestSeq: 1, phase: 'completed' },
    ]);
    runner.detach();
  });

  it('assigns a sequence to each dequeued input including a rejected budget input', async () => {
    const out = sink();
    const stub = makeStub();
    const runner = makeRunner(out.stream, { maxTurns: 2 });
    runner.attach(stub.controller);
    const queue = ['one', 'two', 'three'];
    await runner.run({ next: async () => queue.shift() ?? null });
    const events = out.lines().filter(e => e.type === 'turn_state');
    expect(events.map(e => [e.requestSeq, e.phase])).toEqual([
      [1, 'started'], [1, 'completed'], [2, 'started'], [2, 'completed'],
      [3, 'started'], [3, 'cancelled'],
    ]);
    expect(stub.prompts).toEqual(['one', 'two']);
    runner.detach();
  });

  it('does not prompt an input obtained after interruption while waiting for source', async () => {
    const out = sink();
    const stub = makeStub();
    const runner = makeRunner(out.stream);
    runner.attach(stub.controller);
    let supply!: (value: string) => void;
    const running = runner.run({ next: () => new Promise(resolve => { supply = resolve; }) });
    runner.requestInterrupt();
    supply('too late');
    await running;
    expect(stub.prompts).toEqual([]);
    expect(out.lines().filter(e => e.type === 'turn_state').map(e => e.phase)).toEqual(['started', 'cancelled']);
    runner.detach();
  });

  it('records each request error even when the cumulative error is already set', async () => {
    const out = sink();
    const stub = makeStub({ onRun: (call, emit) => {
      if (call === 1 || call === 3) throw new Error(`failure ${call}`);
      healthyTurn(emit, 'recovered');
    } });
    const runner = makeRunner(out.stream);
    runner.attach(stub.controller);
    await expect(runner.run(singlePrompt('one'))).rejects.toThrow('failure 1');
    await runner.run(singlePrompt('two'));
    await expect(runner.run(singlePrompt('three'))).rejects.toThrow('failure 3');
    expect(out.lines().filter(e => e.type === 'turn_state').map(e => [e.requestSeq, e.phase])).toEqual([
      [1, 'started'], [1, 'failed'], [2, 'started'], [2, 'completed'], [3, 'started'], [3, 'failed'],
    ]);
    runner.detach();
  });

  it('keeps cancellation ahead of a concurrent thrown error', async () => {
    const out = sink();
    const runner = makeRunner(out.stream);
    const stub = makeStub({ onRun: () => { runner.requestInterrupt(); throw new Error('aborted'); } });
    runner.attach(stub.controller);
    await expect(runner.run(singlePrompt('go'))).rejects.toThrow('aborted');
    expect(out.lines().filter(e => e.type === 'turn_state').map(e => e.phase)).toEqual(['started', 'cancelled']);
    expect(out.lines().filter(e => e.type === 'result')).toEqual([]);
    runner.detach();
  });

  it('does not hide a later silent failure behind the first cumulative error', async () => {
    const out = sink();
    const stub = makeStub({ onRun: (call, emit) => {
      if (call === 1) throw new Error('first failure');
      emit({ type: 'agent_end', messages: [] } as AgentEvent);
    } });
    const runner = makeRunner(out.stream);
    runner.attach(stub.controller);
    await expect(runner.run(singlePrompt('one'))).rejects.toThrow('first failure');
    await runner.run(singlePrompt('two'));
    expect(out.lines().filter(e => e.type === 'turn_state').at(-1)?.phase).toBe('failed');
    runner.detach();
  });
});

describe('team supervisor events (subagent-overseer-v2 section 7.1-8)', () => {
  it('passes the overseer decision fields through verbatim, including trigger quiet', () => {
    // exec is ZERO-CHANGE by design (R-P1-1): `trigger` is a transparent
    // string, so the new 'quiet' value must flow without any exec edit.
    const out = sink();
    const { controller } = makeStub();
    let publish!: (event: TeamEvent) => void;
    (controller as { subscribeTeam?: unknown }).subscribeTeam = (listener: (e: TeamEvent) => void) => {
      publish = listener;
      return () => {};
    };
    const runner = makeRunner(out.stream);
    runner.attach(controller);
    publish({
      type: 'overseer',
      dispatchId: 'd1',
      label: 'a1',
      decision: { action: 'wait', reason: 'look budget exhausted' },
      trigger: 'quiet',
    });
    runner.detach();
    const team = out.lines().filter((e) => e.type === 'team');
    expect(team).toHaveLength(1);
    expect(team[0]).toMatchObject({
      type: 'team',
      subtype: 'overseer',
      label: 'a1',
      action: 'wait',
      trigger: 'quiet',
      reason: 'look budget exhausted',
    });
  });
});
