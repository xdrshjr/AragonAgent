import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../llm/providers/openai.js';
import type { LLMRequest } from '../llm/provider.js';
import type { StreamEvent } from '../llm/types.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../llm/retry.js';

const request: LLMRequest = { apiKey: 'test', model: 'test-model', messages: [] };
const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const terminal = (reason = 'stop') => frame({
  choices: [{ index: 0, delta: {}, finish_reason: reason }],
});

function fixture(initial = '') {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel,
  });
  const fetch = vi.fn(async () => new Response(body));
  vi.stubGlobal('fetch', fetch);
  const push = (value: string) => controller.enqueue(encoder.encode(value));
  if (initial) push(initial);
  return { push, close: () => controller.close(), cancel, body, fetch };
}

function observe(stream = new OpenAIProvider().stream(request)) {
  const events: StreamEvent[] = [];
  let settled = false;
  const done = (async () => {
    for await (const event of stream) events.push(event);
    settled = true;
  })();
  return { events, done, settled: () => settled };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('OpenAI terminal drain', () => {
  it('finishes at 750ms with one done and no retry while the connection stays open', async () => {
    const feed = fixture(terminal());
    const stream = observe(withRetry(() => new OpenAIProvider().stream(request), {
      providerId: 'openai', modelId: request.model, policy: DEFAULT_RETRY_POLICY,
    }));
    await vi.advanceTimersByTimeAsync(749);
    expect(stream.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stream.settled()).toBe(true);
    expect(stream.events.map((event) => event.type)).toEqual(['done']);
    expect(feed.fetch).toHaveBeenCalledTimes(1);
    expect(feed.cancel).toHaveBeenCalledTimes(1);
    expect(feed.body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not extend the deadline for heartbeats, repeated finish reasons or usage', async () => {
    const tools = [0, 1].map((index) => ({
      index, id: `tool-${index}`, function: { name: 'act', arguments: '{"ok":true}' },
    }));
    const feed = fixture(frame({ choices: [{
      index: 0, delta: { tool_calls: tools }, finish_reason: 'tool_calls',
    }] }));
    const stream = observe();
    await vi.advanceTimersByTimeAsync(300);
    feed.push(': heartbeat\n\n' + terminal('stop'));
    feed.push(frame({ usage: { prompt_tokens: 7, completion_tokens: 8 } }));
    await vi.advanceTimersByTimeAsync(450);
    expect(stream.settled()).toBe(true);
    const ends = stream.events.filter((event) => event.type === 'tool_call_end');
    expect(ends.map((event) => event.toolCallId)).toEqual(['tool-0', 'tool-1']);
    expect(stream.events.at(-1)).toMatchObject({
      type: 'done', usage: { inputTokens: 7, outputTokens: 8 },
      message: { stopReason: 'tool_use' },
    });
  });

  it('keeps usage arriving at 300ms and closes early on DONE', async () => {
    const feed = fixture(terminal());
    const stream = observe();
    await vi.advanceTimersByTimeAsync(300);
    feed.push(frame({ usage: { prompt_tokens: 11, completion_tokens: 12 } }) + 'data: [DONE]\n\n');
    await stream.done;
    expect(stream.events.at(-1)).toMatchObject({ usage: { inputTokens: 11, outputTokens: 12 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains known usage and prevents a 900ms update after completion', async () => {
    const feed = fixture(frame({ usage: { prompt_tokens: 3, completion_tokens: 4 } }) + terminal());
    const stream = observe();
    await vi.advanceTimersByTimeAsync(750);
    expect(stream.settled()).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(() => feed.push(frame({ usage: { completion_tokens: 99 } }))).toThrow();
    expect(stream.events.at(-1)).toMatchObject({ usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it('consumes terminal-frame deltas but ignores subsequent content and tool arguments', async () => {
    const feed = fixture(frame({ choices: [{
      index: 0, delta: { content: 'last' }, finish_reason: 'stop',
    }] }) + frame({ choices: [{ index: 0, delta: {
      content: 'ignored', tool_calls: [{ index: 0, function: { name: 'act', arguments: '{}' } }],
    } }] }) + 'data: [DONE]\n\n');
    const stream = observe();
    await stream.done;
    expect(stream.events.map((event) => event.type)).toEqual(['text_delta', 'done']);
    expect(stream.events.at(-1)).toMatchObject({
      message: { content: [{ type: 'text', text: 'last' }] },
    });
    expect(feed.cancel).toHaveBeenCalledTimes(1);
  });

  it('ignores another choice terminal and selects index zero', async () => {
    const feed = fixture(frame({ choices: [
      { index: 1, delta: { content: 'other' }, finish_reason: 'stop' },
      { index: 0, delta: { content: 'selected' } },
    ] }));
    const stream = observe();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stream.settled()).toBe(false);
    expect(stream.events).toEqual([{ type: 'text_delta', delta: 'selected' }]);
    feed.push(terminal());
    feed.close();
    await stream.done;
    expect(stream.events.at(-1)?.type).toBe('done');
  });

  it.each([['length', 'max_tokens'], ['content_filter', 'end_turn']])(
    'preserves the existing %s mapping', async (reason, mapped) => {
      const feed = fixture(terminal(reason));
      feed.close();
      const stream = observe();
      await stream.done;
      expect(stream.events.at(-1)).toMatchObject({ message: { stopReason: mapped } });
    },
  );

  it('gives caller cancellation priority at the terminal deadline', async () => {
    const feed = fixture(terminal('tool_calls'));
    const caller = new AbortController();
    const stream = observe(new OpenAIProvider().stream({ ...request, signal: caller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    // Synchronous timer advancement fires the drain before the same-tick caller abort.
    vi.advanceTimersByTime(750);
    caller.abort();
    await stream.done;
    expect(stream.events).toEqual([]);
    expect(feed.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a read AbortError caused by terminal drain as normal completion', async () => {
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(terminal()));
        vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
          signal = init.signal;
          signal?.addEventListener('abort', () => {
            controller.error(new DOMException('aborted', 'AbortError'));
          });
          return new Response(body);
        }));
      },
    });
    const stream = observe();
    await vi.advanceTimersByTimeAsync(750);
    expect(signal?.aborted).toBe(true);
    expect(stream.events.map((event) => event.type)).toEqual(['done']);
    expect(stream.settled()).toBe(true);
  });
});

describe('OpenAI request scope cleanup', () => {
  it.each(['fetch', 'http', 'empty'])('cleans caller listeners after %s failure', async (mode) => {
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, 'addEventListener');
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (mode === 'fetch') throw new Error('offline');
      return mode === 'http' ? new Response('denied', { status: 401 }) : new Response(null);
    }));
    const stream = observe(new OpenAIProvider().stream({ ...request, signal: caller.signal }));
    await stream.done;
    expect(stream.events.at(-1)?.type).toBe('error');
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans caller listeners and terminal timer on consumer return', async () => {
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, 'addEventListener');
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const feed = fixture(frame({ choices: [{ delta: { content: 'last' }, finish_reason: 'stop' }] }));
    const stream = new OpenAIProvider().stream({ ...request, signal: caller.signal });
    expect((await stream.next()).value?.type).toBe('text_delta');
    await stream.return!();
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]?.[1]);
    expect(feed.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
