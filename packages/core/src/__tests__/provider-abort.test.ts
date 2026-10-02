import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../engine/agent.js';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import { OpenAIProvider } from '../llm/providers/openai.js';
import { GoogleProvider } from '../llm/providers/google.js';
import { ProviderRegistry } from '../llm/providers/index.js';
import { DEFAULT_RETRY_POLICY, withRetry } from '../llm/retry.js';
import type { LLMRequest } from '../llm/provider.js';
import type { StreamEvent } from '../llm/types.js';
import type { AgentEvent } from '../types.js';

const request: LLMRequest = { apiKey: 'test', model: 'test-model', messages: [] };
const dataFrame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const eventFrame = (event: string, value: unknown) => `event: ${event}\n${dataFrame(value)}`;
const providers = [
  { provider: new OpenAIProvider(), body: dataFrame({ choices: [{
    delta: { tool_calls: [0, 1].map((index) => ({
      index, id: `tool-${index}`, function: { name: 'act', arguments: '{}' },
    })) }, finish_reason: 'tool_calls',
  }] }) + 'data: [DONE]\n\n' },
  { provider: new AnthropicProvider(), body: [0, 1].map((index) => [
    eventFrame('content_block_start', {
      index, content_block: { type: 'tool_use', id: `tool-${index}`, name: 'act' },
    }),
    eventFrame('content_block_delta', {
      index, delta: { type: 'input_json_delta', partial_json: '{}' },
    }),
    eventFrame('content_block_stop', { index }),
  ].join('')).join('') + eventFrame('message_stop', {}) },
  { provider: new GoogleProvider(), body: dataFrame({ candidates: [{
    content: { parts: [0, 1].map(() => ({ functionCall: { name: 'act', args: {} } })) },
    finishReason: 'STOP',
  }] }) },
];

async function collect(stream: AsyncIterableIterator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

for (const { provider, body } of providers) {
  describe(`${provider.id} caller cancellation`, () => {
    it('does not fetch for an already cancelled request', async () => {
      const fetch = vi.fn(async () => new Response(body));
      vi.stubGlobal('fetch', fetch);
      const caller = new AbortController();
      caller.abort();
      expect(await collect(provider.stream({ ...request, signal: caller.signal }))).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each(['tool_call_start', 'tool_call_end'])('stops all output after %s cancellation', async (at) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
      const caller = new AbortController();
      const stream = provider.stream({ ...request, signal: caller.signal });
      let event = await stream.next();
      while (!event.done && event.value.type !== at) event = await stream.next();
      expect(event.value?.type).toBe(at);
      caller.abort();
      expect(await collect(stream)).toEqual([]);
    });

    it.each(['fetch', 'http', 'empty'])('suppresses %s errors after caller cancellation', async (mode) => {
      const caller = new AbortController();
      vi.stubGlobal('fetch', vi.fn(async () => {
        caller.abort();
        if (mode === 'fetch') throw new DOMException('aborted', 'AbortError');
        return mode === 'http' ? new Response('denied', { status: 401 }) : new Response(null);
      }));
      expect(await collect(provider.stream({ ...request, signal: caller.signal }))).toEqual([]);
    });

    it('drops partial JSON while a read is pending', async () => {
      let pulled!: () => void;
      const ready = new Promise<void>((resolve) => { pulled = resolve; });
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const source = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":')); },
        pull() { pulled(); },
        cancel,
      });
      vi.stubGlobal('fetch', vi.fn(async () => new Response(source)));
      const caller = new AbortController();
      const events = collect(provider.stream({ ...request, signal: caller.signal }));
      await ready;
      caller.abort();
      expect(await events).toEqual([]);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(source.locked).toBe(false);
    });

    it('does not execute accumulated tools through the real Agent and retry wrapper', async () => {
      const fetch = vi.fn(async () => new Response(body));
      vi.stubGlobal('fetch', fetch);
      const registry = new ProviderRegistry();
      registry.register(provider);
      const execute = vi.fn(async () => ({ content: [] }));
      const agent = new Agent({
        systemPrompt: 'test', model: { providerId: provider.id, modelId: request.model },
        providerRegistry: registry, getApiKey: () => 'test',
        tools: [{ name: 'act', label: 'act', description: 'act', parameters: {}, execute }],
      });
      const events: AgentEvent[] = [];
      agent.subscribe((event) => {
        events.push(event);
        if (event.type === 'message_update' && event.streamEvent.type === 'tool_call_end') {
          agent.abort();
        }
      });
      await agent.prompt('hello');
      expect(execute).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(events.some((event) => event.type === 'turn_end')).toBe(false);
      expect(events.filter((event) => event.type === 'message_update').map((event) =>
        event.streamEvent.type,
      )).not.toContain('retry_scheduled');
    });
  });

  it(`${provider.id} exposes one non-retryable frame-limit error through withRetry`, async () => {
    const fetch = vi.fn(async () => new Response('data:' + 'x'.repeat(1_048_577)));
    vi.stubGlobal('fetch', fetch);
    const sleep = vi.fn(async () => {});
    const events = await collect(withRetry(() => provider.stream(request), {
      policy: { ...DEFAULT_RETRY_POLICY, maxRetries: 1 },
      providerId: provider.id, modelId: request.model, sleep,
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: {
      message: 'SSE_FRAME_TOO_LARGE', provider: provider.id, errorType: 'unknown', retryable: false,
    } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
}

describe('retry cancellation boundaries', () => {
  it('does not invoke the source factory when already cancelled', async () => {
    const caller = new AbortController();
    caller.abort();
    const make = vi.fn(async function* (): AsyncIterableIterator<StreamEvent> {});
    const events = await collect(withRetry(make, {
      policy: DEFAULT_RETRY_POLICY, providerId: 'test', modelId: 'test', signal: caller.signal,
    }));
    expect(events).toEqual([]);
    expect(make).not.toHaveBeenCalled();
  });

  it('does not start failure accounting after a source aborts without a terminal event', async () => {
    const caller = new AbortController();
    const now = vi.fn(() => 0);
    const make = async function* (): AsyncIterableIterator<StreamEvent> { caller.abort(); };
    expect(await collect(withRetry(make, {
      policy: DEFAULT_RETRY_POLICY, providerId: 'test', modelId: 'test',
      signal: caller.signal, now,
    }))).toEqual([]);
    expect(now).not.toHaveBeenCalled();
  });
});
