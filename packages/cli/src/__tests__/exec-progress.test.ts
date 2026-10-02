import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider, type AgentEvent, type StreamEvent } from '@aragon-agent/core';
import type { CompactionEvent } from '../compaction/types.js';
import { ExecRunner, singlePrompt, type ExecRunnerController } from '../exec/runner.js';
import { StreamJsonEmitter } from '../exec/emitter.js';

function fixture() {
  const events: Record<string, unknown>[] = [];
  let listener: (event: AgentEvent) => void = () => {};
  let complete: () => void = () => {};
  let compactionListener: (event: CompactionEvent) => void = () => {};
  const controller: ExecRunnerController = {
    preflight: () => ({ ok: true }),
    getModelInfo: () => ({ id: 'fixture', name: 'fixture', provider: 'openai',
      contextWindow: 32_000, maxOutputTokens: 1_000, supportsThinking: true,
      supportsTools: true, supportsImages: false, cost: { input: 0, output: 0 } }),
    subscribe: (fn) => { listener = fn; return () => { listener = () => {}; }; },
    subscribeCompaction: (fn) => { compactionListener = fn; return () => { compactionListener = () => {}; }; },
    abort: () => {},
    prompt: () => new Promise<void>((resolve) => { complete = resolve; }),
  };
  const runner = new ExecRunner({
    emitter: new StreamJsonEmitter({ write: (s: string) => {
      events.push(JSON.parse(s)); return true;
    } } as unknown as NodeJS.WritableStream),
    sessionId: 'fixture', quiet: true, includeThinking: false,
    signals: { setTerminator: () => {}, exit: () => {} },
  });
  runner.attach(controller);
  return {
    events, runner, controller,
    stream: (event: StreamEvent) => listener({ type: 'message_update', streamEvent: event } as AgentEvent),
    emit: (event: AgentEvent) => listener(event),
    compact: (event: CompactionEvent) => compactionListener(event),
    complete: () => complete(),
    progress: () => events.filter((e) => e.type === 'execution_progress'),
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('exec semantic progress', () => {
  it('reports actual OpenAI reasoning deltas through the runner with thinking disabled', async () => {
    const f = fixture();
    const run = f.runner.run(singlePrompt('hello'));
    await Promise.resolve();
    vi.stubGlobal('fetch', async () => new Response([
      'data: {"choices":[{"index":0,"delta":{"reasoning_content":"secret reasoning"}}]}',
      'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}',
      'data: [DONE]', '',
    ].join('\r\n\r\n')));
    const provider = new OpenAIProvider();
    for await (const event of provider.stream({ model: 'fixture', apiKey: 'fixture',
      messages: [{ role: 'user', content: 'hello' }] })) f.stream(event);
    f.complete(); await run; f.runner.detach();
    expect(f.progress().map((event) => event.phase)).toContain('thinking');
    expect(JSON.stringify(f.events)).not.toContain('secret reasoning');
  });

  it('leaves compaction and ignores late compaction source events after terminal', async () => {
    const f = fixture();
    const run = f.runner.run(singlePrompt('hello'));
    await Promise.resolve();
    f.compact({ type: 'compaction_start', trigger: 'pressure' } as CompactionEvent);
    f.compact({ type: 'compaction_end', record: { trigger: 'pressure', applied: false,
      mode: 'none', messagesBefore: 2, messagesAfter: 2, tokensBefore: 1, tokensAfter: 1,
      durationMs: 10 } } as CompactionEvent);
    f.complete(); await run;
    expect(f.progress().map((event) => event.phase)).toEqual(['compaction', 'model']);
    f.compact({ type: 'compaction_start', trigger: 'pressure' } as CompactionEvent);
    expect(f.progress()).toHaveLength(2);
    f.runner.detach();
  });

  it('reports thinking without disclosing text and never manufactures idle heartbeats', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const run = f.runner.run(singlePrompt('hello'));
    await Promise.resolve();
    for (let i = 0; i < 50; i++) {
      f.stream({ type: 'thinking_delta', delta: 'private reasoning' });
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(f.progress().length).toBeGreaterThanOrEqual(5);
    expect(f.progress().length).toBeLessThanOrEqual(6);
    expect(JSON.stringify(f.events)).not.toContain('private reasoning');
    const count = f.progress().length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.progress()).toHaveLength(count);
    f.complete(); await run; f.runner.detach();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flushes before terminal, rejects late source events and resets sequence for new requests', async () => {
    vi.useFakeTimers();
    const f = fixture();
    for (let requestSeq = 1; requestSeq <= 2; requestSeq++) {
      const run = f.runner.run(singlePrompt('hello'));
      await Promise.resolve();
      f.stream({ type: 'thinking_delta', delta: 'a' });
      f.stream({ type: 'thinking_delta', delta: 'b' });
      f.complete(); await run;
      const progress = f.progress().filter((e) => e.requestSeq === requestSeq);
      expect(progress.map((e) => e.progressSeq)).toEqual([1, 2]);
      expect(f.events.at(-1)).toMatchObject({ type: 'turn_state', phase: 'completed', requestSeq });
      const count = f.progress().length;
      f.stream({ type: 'thinking_delta', delta: 'late' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.progress()).toHaveLength(count);
    }
    f.runner.detach();
  });

  it('distinguishes arguments, tool execution and retry exit without counting empty deltas', async () => {
    const f = fixture();
    const run = f.runner.run(singlePrompt('hello'));
    await Promise.resolve();
    f.stream({ type: 'text_delta', delta: '' });
    f.stream({ type: 'thinking_delta', delta: '' });
    f.stream({ type: 'tool_call_delta', toolCallId: 't', argsDelta: '{' });
    f.emit({ type: 'tool_execution_start', toolCallId: 't', toolName: 'bash', args: {} } as AgentEvent);
    f.emit({ type: 'tool_execution_end', toolCallId: 't', toolName: 'bash', result: { content: [] }, duration: 1, isError: false } as AgentEvent);
    f.stream({ type: 'retry_scheduled', delayMs: 999_999, attempt: 1, maxRetries: 3,
      errorType: 'network_error', resumeAt: 999_999, message: 'fixture' });
    f.stream({ type: 'retry_attempt', attempt: 1, maxRetries: 3 });
    f.complete(); await run; f.runner.detach();
    expect(f.progress().map((e) => e.phase)).toEqual(['tool_arguments', 'tool', 'model', 'retry', 'model']);
    expect(f.progress().map((e) => e.progressSeq)).toEqual([1, 2, 3, 4, 5]);
    expect(f.progress()[3]).toMatchObject({ retryDelayMs: 120_000 });
  });

  it('cancels pending aggregation on detach', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const run = f.runner.run(singlePrompt('hello'));
    await Promise.resolve();
    f.stream({ type: 'text_delta', delta: 'a' });
    f.stream({ type: 'text_delta', delta: 'b' });
    const count = f.progress().length;
    f.runner.detach();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.progress()).toHaveLength(count);
    expect(vi.getTimerCount()).toBe(0);
    f.complete(); await run;
  });
});
