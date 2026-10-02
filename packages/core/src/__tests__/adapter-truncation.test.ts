/**
 * The terminal-sentinel contract (llm-api-retry-backoff §4.5a, AC-9 / AC-9b).
 *
 * THESE CASES DRIVE THE REAL ADAPTERS against a scripted `fetch`, not a fake
 * provider, and that is the whole point: what is under test is what each adapter
 * does at the END of an SSE body, so a `FakeProvider` would assert the design
 * against itself.
 *
 * Against a pre-feature build all three "truncated" cases yield `done` with
 * partial content — success carrying a silently truncated answer, which no
 * wrapper installed above the adapter can tell from a real one. That is the
 * failure this file exists to make impossible.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import { OpenAIProvider } from '../llm/providers/openai.js';
import { GoogleProvider } from '../llm/providers/google.js';
import { LLMError } from '../llm/provider.js';
import type { LLMProvider, LLMRequest } from '../llm/provider.js';
import type { StreamEvent } from '../llm/types.js';
import { clearLearnedCeilings } from '../llm/output-limits.js';
import { clearLearnedTokenFields } from '../llm/output-limit-recovery.js';

afterEach(() => {
  vi.unstubAllGlobals();
  // Both caches live for the whole PROCESS; leaving either populated fails a
  // later test file for a reason that is not in it.
  clearLearnedCeilings();
  clearLearnedTokenFields();
});

const baseRequest: LLMRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello' }],
  apiKey: 'k',
};

/** Serve `body` as a 200 SSE response to whatever the adapter asks for. */
function stubSSE(body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
    ),
  );
}

async function collect(
  provider: LLMProvider,
  request: LLMRequest = baseRequest,
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(request)) out.push(event);
  return out;
}

function sse(lines: string[]): string {
  return `${lines.join('\n\n')}\n\n`;
}

// ---------------------------------------------------------------------------
// Bodies. Each provider gets a TRUNCATED, a COMPLETE and an EMPTY-BUT-COMPLETE
// variant, because the three have to be told apart.
// ---------------------------------------------------------------------------

const ANTHROPIC = {
  truncated: sse([
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}',
    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text"}}',
    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"half an ans"}}',
    // ... and the connection closes. No `message_stop`.
  ]),
  complete: sse([
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}',
    'event: content_block_start\ndata: {"index":0,"content_block":{"type":"text"}}',
    'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"whole"}}',
    'event: content_block_stop\ndata: {"index":0}',
    'event: message_stop\ndata: {}',
  ]),
  emptyButComplete: sse([
    'event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}',
    'event: message_stop\ndata: {}',
  ]),
};

const OPENAI = {
  truncated: sse([
    'data: {"choices":[{"delta":{"content":"half an ans"}}]}',
    // No `finish_reason`, no `[DONE]`.
  ]),
  complete: sse([
    'data: {"choices":[{"delta":{"content":"whole"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ]),
  emptyButComplete: sse([
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
    'data: [DONE]',
  ]),
  /**
   * A completed stream from an OpenAI-COMPATIBLE endpoint that never sends the
   * `[DONE]` sentinel. Common enough among the proxies `--base-url` exists for
   * that keying truncation on `[DONE]` alone would make every such request a
   * retryable error (see the note on `sawTerminal` in `openai.ts`).
   */
  completeWithoutDoneSentinel: sse([
    'data: {"choices":[{"delta":{"content":"whole"}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  ]),
};

const GOOGLE = {
  truncated: sse([
    'data: {"candidates":[{"content":{"parts":[{"text":"half an ans"}]}}]}',
    // No candidate carrying `finishReason`.
  ]),
  complete: sse([
    'data: {"candidates":[{"content":{"parts":[{"text":"whole"}]}}]}',
    'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[]}}]}',
  ]),
  emptyButComplete: sse([
    'data: {"candidates":[{"finishReason":"STOP","content":{"parts":[]}}]}',
  ]),
};

// ---------------------------------------------------------------------------
// AC-9 — a truncated stream is an error, per adapter
// ---------------------------------------------------------------------------

const TRUNCATION_CASES: Array<{
  name: string;
  provider: () => LLMProvider;
  body: string;
}> = [
  { name: 'anthropic', provider: () => new AnthropicProvider(), body: ANTHROPIC.truncated },
  { name: 'openai', provider: () => new OpenAIProvider(), body: OPENAI.truncated },
  { name: 'google', provider: () => new GoogleProvider(), body: GOOGLE.truncated },
];

describe('a stream that ends without its terminal sentinel (AC-9)', () => {
  for (const testCase of TRUNCATION_CASES) {
    it(`${testCase.name} reports a retryable network_error, NOT done`, async () => {
      stubSSE(testCase.body);
      const events = await collect(testCase.provider());

      // The partial content was still forwarded — the consumer saw it, which is
      // exactly why `stream_restart` has to tell it what to discard.
      expect(events.some((e) => e.type === 'text_delta')).toBe(true);
      expect(events.some((e) => e.type === 'done')).toBe(false);

      const terminal = events[events.length - 1];
      expect(terminal?.type).toBe('error');
      const error = (terminal as { error: unknown }).error;
      expect(error).toBeInstanceOf(LLMError);
      expect((error as LLMError).errorType).toBe('network_error');
      expect((error as LLMError).retryable).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// AC-9b — the two things a truncation check must NOT break
// ---------------------------------------------------------------------------

const COMPLETE_CASES: Array<{
  name: string;
  provider: () => LLMProvider;
  complete: string;
  empty: string;
}> = [
  {
    name: 'anthropic',
    provider: () => new AnthropicProvider(),
    complete: ANTHROPIC.complete,
    empty: ANTHROPIC.emptyButComplete,
  },
  {
    name: 'openai',
    provider: () => new OpenAIProvider(),
    complete: OPENAI.complete,
    empty: OPENAI.emptyButComplete,
  },
  {
    name: 'google',
    provider: () => new GoogleProvider(),
    complete: GOOGLE.complete,
    empty: GOOGLE.emptyButComplete,
  },
];

describe('a completed stream is untouched (AC-9b)', () => {
  for (const testCase of COMPLETE_CASES) {
    it(`${testCase.name} still yields done for a normal answer`, async () => {
      stubSSE(testCase.complete);
      const events = await collect(testCase.provider());
      expect(events[events.length - 1]?.type).toBe('done');
      expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it(`${testCase.name} still yields done for an EMPTY but complete turn`, async () => {
      // A model that legitimately produces nothing and stops is a SUCCESS. The
      // flag is set at the terminal frame, never inferred from content length,
      // which is what makes this case safe (§4.5a constraint 2).
      stubSSE(testCase.empty);
      const events = await collect(testCase.provider());
      expect(events[events.length - 1]?.type).toBe('done');
      expect(events.some((e) => e.type === 'error')).toBe(false);
    });

    it(`${testCase.name} emits no terminal output when the request was aborted`, async () => {
      // Intentional v2 contract change: cancellation produces neither a success
      // terminal nor a retryable truncation error, even with accumulated content.
      stubSSE(testCase.complete);
      const controller = new AbortController();
      controller.abort();
      const events = await collect(testCase.provider(), {
        ...baseRequest,
        signal: controller.signal,
      });
      expect(events).toEqual([]);
    });
  }
});

describe('an OpenAI-compatible endpoint that omits [DONE]', () => {
  it('is a completed stream, not a truncated one', async () => {
    // Keying truncation on `[DONE]` alone would make ten retries and a failure
    // out of a perfectly complete response from such a server.
    stubSSE(OPENAI.completeWithoutDoneSentinel);
    const events = await collect(new OpenAIProvider());
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events[events.length - 1]?.type).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// The header pass-through (§5.5a) — the other half of the adapter change
// ---------------------------------------------------------------------------

describe('adapters pass response headers into classifyHttpError', () => {
  const providers: Array<{ name: string; provider: () => LLMProvider }> = [
    { name: 'anthropic', provider: () => new AnthropicProvider() },
    { name: 'openai', provider: () => new OpenAIProvider() },
    { name: 'google', provider: () => new GoogleProvider() },
  ];

  for (const { name, provider } of providers) {
    it(`${name} carries Retry-After out on the error`, async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('{"error":"slow down"}', {
              status: 429,
              headers: { 'Content-Type': 'application/json', 'retry-after': '9' },
            }),
        ),
      );
      const events = await collect(provider());
      const error = (events[events.length - 1] as unknown as { error: LLMError }).error;
      expect(error.errorType).toBe('rate_limit');
      expect(error.retryAfterMs).toBe(9000);
    });
  }
});
