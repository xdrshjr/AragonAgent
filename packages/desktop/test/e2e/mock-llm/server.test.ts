/**
 * The mock endpoint, judged by the REAL OpenAI adapter from the engine: if `core`'s parser can
 * read what the mock writes, an E2E run exercises the genuine stream path (spec R-V13).
 */
import { getProviderRegistry, type StreamEvent } from '@aragon-agent/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startMockLlm, type MockLlm } from './server.js';

let mock: MockLlm;
beforeEach(async () => { mock = await startMockLlm(['mock-1', 'mock-2']); });
afterEach(async () => { await mock.close(); });

async function ask(text = 'hi', signal?: AbortSignal): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const iterator = getProviderRegistry().stream('openai', {
    model: 'mock-1', apiKey: 'test-key', baseUrl: `${mock.url}/v1`,
    messages: [{ role: 'user', content: text, timestamp: 1 }],
    ...(signal ? { signal } : {}),
  });
  for await (const event of iterator) events.push(event);
  return events;
}

describe('mock-llm (read by the real adapter)', () => {
  it('streams text deltas and a final message with usage', async () => {
    mock.script([{ deltas: ['Hel', 'lo'] }]);
    const events = await ask();
    expect(events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta)).toEqual(['Hel', 'lo']);
    const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;
    expect(done.message.stopReason).toBe('end_turn');
    expect(done.usage.outputTokens).toBeGreaterThan(0);
    expect(mock.unconsumed()).toBe(0);
  });

  it('streams a tool call whose arguments arrive in pieces and parse as one object', async () => {
    mock.script([{ deltas: ['Running it.'], toolCalls: [{ name: 'bash', args: { command: 'echo hi' } }] }]);
    const events = await ask();
    expect(events.some((e) => e.type === 'tool_call_start' && (e as { toolName: string }).toolName === 'bash')).toBe(true);
    const done = events.find((e) => e.type === 'done') as Extract<StreamEvent, { type: 'done' }>;
    expect(done.message.stopReason).toBe('tool_use');
    const call = done.message.content.find((block) => block.type === 'tool_call') as { args: unknown };
    expect(call.args).toEqual({ command: 'echo hi' });
  });

  it('consumes one turn per request, in order, and answers a fixed line once the script runs out', async () => {
    mock.script([{ deltas: ['one'] }, { deltas: ['two'] }]);
    await ask();
    expect(mock.unconsumed()).toBe(1);
    await ask();
    expect(mock.unconsumed()).toBe(0);
    const extra = await ask();
    expect(extra.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta).join('')).toBe('(mock: script exhausted)');
    expect(mock.unconsumed()).toBe(0); // running past the end is not "unconsumed"; the test must check requests().length
    expect(mock.requests()).toHaveLength(3);
  });

  it('records what the client sent, including the tools it offered and every message', async () => {
    mock.script([{ deltas: ['ok'] }]);
    await ask('what is 2+2');
    const [request] = mock.requests();
    expect(request).toMatchObject({ path: '/v1/chat/completions', model: 'mock-1', stream: true });
    expect(request!.messages.some((m) => m.role === 'user' && m.content === 'what is 2+2')).toBe(true);
  });

  it('serves the model list for model discovery', async () => {
    const response = await fetch(`${mock.url}/v1/models`);
    expect(((await response.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id)).toEqual(['mock-1', 'mock-2']);
  });

  it('can fail a request with a status and Retry-After', async () => {
    mock.script([{ fail: { status: 429, retryAfter: 1 } }]);
    const response = await fetch(`${mock.url}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ stream: true, messages: [] }) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('1');
  });

  it('can cut the stream before a terminal frame; the adapter treats that as a retryable network error and asks again', async () => {
    mock.script([{ deltas: ['a', 'b', 'c'], fail: { cutAfter: 1 } }]);
    const events = await ask();
    // The first request died mid-stream; the engine retried and the (exhausted) script answered.
    expect(mock.requests().length).toBeGreaterThanOrEqual(2);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });

  it('notices when the client hangs up mid-stream (this is how "Esc stops the run" is observed)', async () => {
    mock.script([{ deltas: ['x'.repeat(40)], tokensPerSecond: 5, holdOpen: true }]);
    const abort = new AbortController();
    const pending = ask('hi', abort.signal).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 300));
    abort.abort();
    await pending;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(mock.requests()[0]!.closedByClient).toBe(true);
    mock.release();
  });

  it('paces a throttled turn instead of dumping it at once', async () => {
    mock.script([{ deltas: ['abcd', 'efgh', 'ijkl'], tokensPerSecond: 40 }]); // ~25 ms per 4-char piece
    const started = Date.now();
    await ask();
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });
});
