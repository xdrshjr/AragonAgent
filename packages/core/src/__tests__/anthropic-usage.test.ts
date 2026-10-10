/**
 * Usage merging across `message_start` and `message_delta`
 * (context-usage-zero-input-tokens A).
 *
 * THE BUG THIS FILE EXISTS FOR. The adapter read input tokens ONLY from
 * `message_start` and took `output_tokens` - and nothing else - from
 * `message_delta.usage`. Anthropic-COMPATIBLE relays (bigmodel, Kimi) commonly
 * put the real input count in the stream-final `message_delta` and send 0 /
 * nothing in `message_start`, so every such session ended with
 * `usage.inputTokens === 0`, which then collapsed the context gauge and disarmed
 * auto-compaction downstream. No test in the suite ever sent a
 * `message_delta` event before this file (that is how the bug slipped in), so
 * BOTH directions are asserted here: what must change, and what must not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import type { LLMRequest } from '../llm/provider.js';
import type { StreamEvent, TokenUsage } from '../llm/types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const baseRequest: LLMRequest = {
  model: 'glm-5.3',
  messages: [{ role: 'user', content: 'hello' }],
  apiKey: 'k',
  baseUrl: 'https://relay.test',
};

/** Serialize `[event, data]` pairs into an SSE body. */
function sse(
  events: ReadonlyArray<readonly [string, Record<string, unknown>]>,
): string {
  return `${events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}`)
    .join('\n\n')}\n\n`;
}

/** The usage the adapter reports on `done` for the given SSE events. */
async function usageFrom(
  events: ReadonlyArray<readonly [string, Record<string, unknown>]>,
): Promise<TokenUsage> {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(sse(events), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ),
  );
  const collected: StreamEvent[] = [];
  for await (const event of new AnthropicProvider().stream(baseRequest)) collected.push(event);
  const done = collected.at(-1);
  if (!done || done.type !== 'done') {
    throw new Error(`stream did not finish with done: ${done?.type}`);
  }
  return done.usage;
}

const TEXT_BLOCK: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['content_block_start', { index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'hi' } }],
  ['content_block_stop', { index: 0 }],
];

describe('conservation - first-party streams keep their message_start numbers', () => {
  it('a delta with only output_tokens leaves input and cache fields untouched', async () => {
    // THE OFFICIAL SHAPE: api.anthropic.com puts the full input-side usage in
    // `message_start` and only a cumulative `output_tokens` in
    // `message_delta`. Byte-identical behaviour here is the whole point of the
    // "present and non-zero" takeover guard - this is the one case that must
    // NOT move.
    const usage = await usageFrom([
      ['message_start', { message: { usage: {
        input_tokens: 1234,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 500,
      } } }],
      ...TEXT_BLOCK,
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 245 } }],
      ['message_stop', {}],
    ]);
    expect(usage).toEqual({
      inputTokens: 1234,
      outputTokens: 245,
      cacheReadTokens: 9000,
      cacheWriteTokens: 500,
    });
  });

  it('a delta reporting input_tokens: 0 does not erase the message_start input', async () => {
    // Zero is "nothing new to say", not "the request was free". A relay that
    // echoes an explicit zero must not zero out a number it never owned.
    const usage = await usageFrom([
      ['message_start', { message: { usage: { input_tokens: 4321 } } }],
      ...TEXT_BLOCK,
      ['message_delta', {
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 0, output_tokens: 99 },
      }],
      ['message_stop', {}],
    ]);
    expect(usage.inputTokens).toBe(4321);
    expect(usage.outputTokens).toBe(99);
  });
});

describe('merge - relays that disclose input in message_delta', () => {
  it('adopts a non-zero delta input when message_start had none (the bug)', async () => {
    // THE §2.2 REPRO SHAPE: message_start carries an unusable 0, the stream
    // ends with the real count. Pre-fix this yielded inputTokens 0 while the
    // relay reported 95,123.
    const usage = await usageFrom([
      ['message_start', { message: { usage: { input_tokens: 0 } } }],
      ...TEXT_BLOCK,
      ['message_delta', { delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 95_123, output_tokens: 245 } }],
      ['message_stop', {}],
    ]);
    expect(usage.inputTokens).toBe(95_123);
    expect(usage.outputTokens).toBe(245);
  });

  it('adopts the input when message_start had no usage object at all', async () => {
    const usage = await usageFrom([
      ['message_start', { message: {} }],
      ...TEXT_BLOCK,
      ['message_delta', { delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 8_000, output_tokens: 40 } }],
      ['message_stop', {}],
    ]);
    expect(usage.inputTokens).toBe(8_000);
  });

  it('later non-zero deltas win, and a delta without input keeps the earlier one', async () => {
    // Relays may emit several message_delta events; the takeover is
    // last-non-zero-wins on the input side and last-words on output.
    const usage = await usageFrom([
      ['message_start', { message: { usage: { input_tokens: 0 } } }],
      ...TEXT_BLOCK,
      ['message_delta', { usage: { input_tokens: 5_000, output_tokens: 10 } }],
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 245 } }],
      ['message_stop', {}],
    ]);
    expect(usage.inputTokens).toBe(5_000);
    expect(usage.outputTokens).toBe(245);
  });

  it('takes the cache terms over from the delta rather than summing across events', async () => {
    // THE ANTI-DOUBLE-COUNT CASE (P1-10). A delta that discloses input may
    // report an INCLUSIVE total; keeping message_start's additive cache fields
    // on top of it counts the cached tokens twice, inflating occupancy and
    // firing compaction early. The input side must be re-derived from the delta
    // alone: its own cache terms when present.
    const usage = await usageFrom([
      ['message_start', { message: { usage: {
        input_tokens: 0,
        cache_read_input_tokens: 80_000,
        cache_creation_input_tokens: 3_000,
      } } }],
      ...TEXT_BLOCK,
      ['message_delta', { delta: { stop_reason: 'end_turn' }, usage: {
        input_tokens: 95_123,
        cache_read_input_tokens: 2_000,
        output_tokens: 245,
      } }],
      ['message_stop', {}],
    ]);
    expect(usage.inputTokens).toBe(95_123);
    expect(usage.cacheReadTokens).toBe(2_000);
    expect(usage.cacheWriteTokens).toBeUndefined();
  });

  it('clears message_start cache terms when the delta input arrives without any', async () => {
    // The inclusive-total reading of the case above: 95,123 already covers the
    // request, and silently re-adding the 80,000 from message_start would
    // double-bill the cache. Under-counting a hypothetical exclusive-total
    // relay is the conservative direction - the gauge reads slightly low
    // instead of compacting early.
    const usage = await usageFrom([
      ['message_start', { message: { usage: {
        input_tokens: 0,
        cache_read_input_tokens: 80_000,
      } } }],
      ...TEXT_BLOCK,
      ['message_delta', { delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 95_123, output_tokens: 245 } }],
      ['message_stop', {}],
    ]);
    expect(usage.inputTokens).toBe(95_123);
    expect(usage.cacheReadTokens).toBeUndefined();
    expect(usage.cacheWriteTokens).toBeUndefined();
  });
});
