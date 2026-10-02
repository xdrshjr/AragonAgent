import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../llm/providers/openai.js';
import type { StreamEvent } from '../llm/types.js';

afterEach(() => { vi.unstubAllGlobals(); });

function serve(deltas: unknown[], finish = true): void {
  const chunks: Array<Record<string, unknown>> = deltas.map((delta) => ({
    choices: [{ index: 0, delta }],
  }));
  if (finish) chunks.push({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body + 'data: [DONE]\n\n')));
}

describe('OpenAI-compatible reasoning progress', () => {
  it('emits one thinking_start and preserves thinking separately from the answer', async () => {
    serve([{ reasoning_content: 'first' }, { reasoning_content: ' second' }, { content: 'answer' }]);
    const events: StreamEvent[] = [];
    for await (const event of new OpenAIProvider().stream({
      apiKey: 'test', model: 'test', messages: [],
    })) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      'thinking_start', 'thinking_delta', 'thinking_delta', 'text_delta', 'done',
    ]);
    expect(events.at(-1)).toMatchObject({ message: { content: [
      { type: 'thinking', text: 'first second' }, { type: 'text', text: 'answer' },
    ] } });
  });

  it('ignores empty and non-string reasoning values', async () => {
    serve([null, '', {}, 42, false].map((reasoning_content) => ({ reasoning_content })));
    const events: StreamEvent[] = [];
    for await (const event of new OpenAIProvider().stream({
      apiKey: 'test', model: 'test', messages: [],
    })) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['done']);
  });

  it('ignores reasoning after a terminal frame', async () => {
    const body = [
      { choices: [{ delta: { reasoning_content: 'kept' }, finish_reason: 'stop' }] },
      { choices: [{ delta: { reasoning_content: 'discarded' } }] },
    ].map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const message = await new OpenAIProvider().complete({
      apiKey: 'test', model: 'test', messages: [],
    });
    expect(message.content).toEqual([{ type: 'thinking', text: 'kept' }]);
  });

  it('stops between thinking_start and its delta when the caller cancels', async () => {
    serve([{ reasoning_content: 'private' }]);
    const caller = new AbortController();
    const stream = new OpenAIProvider().stream({
      apiKey: 'test', model: 'test', messages: [], signal: caller.signal,
    });
    expect((await stream.next()).value?.type).toBe('thinking_start');
    caller.abort();
    expect((await stream.next()).done).toBe(true);
  });
});
