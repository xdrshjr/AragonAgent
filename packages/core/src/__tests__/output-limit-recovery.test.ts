/**
 * One-shot output-limit recovery (§9 cases 13-20).
 *
 * Two of these assertions exist to pin failure modes that are catastrophic and
 * invisible: reading a `Response` body twice (`TypeError: Body is unusable`, and
 * only on the error path nobody exercises), and a recovery LOOP, which doubles
 * every user's bill without a single failing test.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyOutputLimitFailure,
  clearLearnedTokenFields,
  getLearnedTokenField,
  sendWithOutputLimitRecovery,
} from '../llm/output-limit-recovery.js';
import { clearLearnedCeilings, getLearnedCeiling } from '../llm/output-limits.js';

// BOTH module-level maps have process lifetime; leaving either populated fails
// the next test file for a reason that is not in it.
afterEach(() => {
  clearLearnedCeilings();
  clearLearnedTokenFields();
  vi.restoreAllMocks();
});

// -- Real provider error bodies (§4.3) --------------------------------------

const OPENAI_UNSUPPORTED_FIELD =
  `{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this ` +
  `model. Use 'max_completion_tokens' instead.","type":"invalid_request_error"}}`;

const ANTHROPIC_THINKING_CONFLICT =
  `{"error":{"type":"invalid_request_error","message":"max_tokens must be greater than ` +
  `thinking.budget_tokens"}}`;

const ANTHROPIC_CEILING =
  `{"error":{"type":"invalid_request_error","message":"max_tokens: 64000 > 8192, which is ` +
  `the maximum allowed number of output tokens for claude-3-5-haiku-20241022"}}`;

const OPENAI_CEILING =
  `{"error":{"message":"This model supports at most 16384 completion tokens, however you ` +
  `requested 64000 tokens.","type":"invalid_request_error"}}`;

const GOOGLE_CEILING =
  `{"error":{"code":400,"message":"The requested output size exceeds the model limit of 8192."}}`;

const OPENAI_CONTEXT_SUM =
  `{"error":{"message":"This model's maximum context length is 128000 tokens. However, you ` +
  `requested 190000 tokens (126000 in the messages, 64000 in the completion). Please reduce ` +
  `the length of the messages or completion.","type":"invalid_request_error"}}`;

describe('classifyOutputLimitFailure', () => {
  it('case 13: classifies every real provider error and captures the number', () => {
    expect(classifyOutputLimitFailure('openai', 400, OPENAI_UNSUPPORTED_FIELD)).toEqual({
      kind: 'unsupported_field',
      expected: 'max_completion_tokens',
    });
    expect(classifyOutputLimitFailure('anthropic', 400, ANTHROPIC_THINKING_CONFLICT)).toEqual({
      kind: 'thinking_conflict',
    });
    expect(classifyOutputLimitFailure('anthropic', 400, ANTHROPIC_CEILING)).toEqual({
      kind: 'exceeds_ceiling',
      ceiling: 8_192,
    });
    expect(classifyOutputLimitFailure('openai', 400, OPENAI_CEILING)).toEqual({
      kind: 'exceeds_ceiling',
      ceiling: 16_384,
    });
    expect(classifyOutputLimitFailure('google', 400, GOOGLE_CEILING)).toEqual({
      kind: 'exceeds_ceiling',
      ceiling: 8_192,
    });
    expect(classifyOutputLimitFailure('openai', 400, OPENAI_CONTEXT_SUM)).toEqual({
      kind: 'context_sum',
      contextWindow: 128_000,
      promptTokens: 126_000,
    });
  });

  it('falls back to a numberless exceeds_ceiling when the provider names no limit', () => {
    const body = '{"error":{"message":"max_output_tokens is invalid for this deployment"}}';

    expect(classifyOutputLimitFailure('openai', 400, body)).toEqual({ kind: 'exceeds_ceiling' });
  });

  it('case 14: only 400 is inspected, whatever the body says', () => {
    for (const status of [200, 401, 429, 500, 529]) {
      expect(classifyOutputLimitFailure('anthropic', status, ANTHROPIC_CEILING)).toBeUndefined();
    }
    expect(classifyOutputLimitFailure('anthropic', 400, '')).toBeUndefined();
  });

  it('leaves an unrelated 400 alone', () => {
    const body = '{"error":{"message":"messages: at least one message is required"}}';

    expect(classifyOutputLimitFailure('anthropic', 400, body)).toBeUndefined();
  });
});

// -- sendWithOutputLimitRecovery --------------------------------------------

function ok(): Response {
  return new Response('data: {}\n\n', { status: 200 });
}

function bad(body: string): Response {
  return new Response(body, { status: 400 });
}

describe('sendWithOutputLimitRecovery', () => {
  it('case 15: a 200 is returned with its body UNCONSUMED', async () => {
    const send = vi.fn(async () => ok());

    const attempt = await sendWithOutputLimitRecovery({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      body: { max_tokens: 64_000 },
      tokenField: 'max_tokens',
      send,
    });

    // A streaming response must reach the SSE parser intact; even peeking here
    // would set `bodyUsed` and leave the parser nothing to read.
    expect(attempt.response.bodyUsed).toBe(false);
    expect(attempt.bodyText).toBe('');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('case 16: an exceeds_ceiling 400 retries ONCE at the parsed ceiling and learns it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return bodies.length === 1 ? bad(ANTHROPIC_CEILING) : ok();
    });

    const attempt = await sendWithOutputLimitRecovery({
      providerId: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      body: { max_tokens: 64_000 },
      tokenField: 'max_tokens',
      send,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(bodies[1]?.max_tokens).toBe(8_192);
    expect(attempt.response.ok).toBe(true);
    expect(attempt.adjustment).toEqual({ from: 64_000, to: 8_192, reason: 'exceeds_ceiling' });
    expect(getLearnedCeiling('anthropic', 'claude-3-5-haiku-20241022')).toEqual({
      ceiling: 8_192,
      source: 'error',
    });
  });

  it('falls back to the safe ceiling when the provider names no number', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return bodies.length === 1 ? bad('max_completion_tokens out of range') : ok();
    });

    await sendWithOutputLimitRecovery({
      providerId: 'openai',
      modelId: 'proxy-model',
      body: { max_tokens: 64_000 },
      tokenField: 'max_tokens',
      send,
    });

    expect(bodies[1]?.max_tokens).toBe(8_192);
  });

  it('case 17: a 400 that is not an output-limit failure sends exactly once', async () => {
    const send = vi.fn(async () => bad('{"error":{"message":"invalid api key"}}'));

    const attempt = await sendWithOutputLimitRecovery({
      providerId: 'openai',
      modelId: 'gpt-4o',
      body: { max_tokens: 64_000 },
      tokenField: 'max_tokens',
      send,
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(attempt.bodyText).toContain('invalid api key');
    expect(attempt.adjustment).toBeUndefined();
  });

  it('case 18: two consecutive 400s send exactly twice and return the second body', async () => {
    let call = 0;
    const send = vi.fn(async () => {
      call += 1;
      return call === 1 ? bad(ANTHROPIC_CEILING) : bad('{"error":{"message":"still no"}}');
    });

    const attempt = await sendWithOutputLimitRecovery({
      providerId: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      body: { max_tokens: 64_000 },
      tokenField: 'max_tokens',
      send,
    });

    // No loop construct exists in the module; this is the assertion that keeps
    // it that way.
    expect(send).toHaveBeenCalledTimes(2);
    expect(attempt.response.status).toBe(400);
    expect(attempt.bodyText).toContain('still no');
  });

  it('case 19: unsupported_field renames the key, keeps the value, memoizes the dialect', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return bodies.length === 1 ? bad(OPENAI_UNSUPPORTED_FIELD) : ok();
    });

    await sendWithOutputLimitRecovery({
      providerId: 'openai',
      modelId: 'o3-preview',
      body: { max_tokens: 32_000, temperature: 0.7 },
      tokenField: 'max_tokens',
      send,
    });

    expect(bodies[1]).not.toHaveProperty('max_tokens');
    expect(bodies[1]?.max_completion_tokens).toBe(32_000);
    // The same models reject `temperature`; leaving it buys a second 400.
    expect(bodies[1]).not.toHaveProperty('temperature');
    // The memo is what makes the SECOND request in this session right first try.
    expect(getLearnedTokenField('openai', 'o3-preview')).toBe('max_completion_tokens');
  });

  it('case 20: a context_sum repair does NOT write to the learned-ceiling cache', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return bodies.length === 1 ? bad(OPENAI_CONTEXT_SUM) : ok();
    });

    await sendWithOutputLimitRecovery({
      providerId: 'openai',
      modelId: 'gpt-4o',
      body: { max_tokens: 64_000 },
      tokenField: 'max_tokens',
      send,
    });

    // 128000 - 126000 - 1024 = 976, floored at MIN_MAX_OUTPUT_TOKENS.
    expect(bodies[1]?.max_tokens).toBe(976);
    // A context-sum failure is a property of THIS conversation, not of the
    // model; recording it would cap every later turn in the session.
    expect(getLearnedCeiling('openai', 'gpt-4o')).toBeUndefined();
  });

  it('repairs the thinking conflict by raising the cap when the ceiling allows it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return bodies.length === 1 ? bad(ANTHROPIC_THINKING_CONFLICT) : ok();
    });

    await sendWithOutputLimitRecovery({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5-20250929',
      body: { max_tokens: 32_000, thinking: { type: 'enabled', budget_tokens: 32_768 } },
      tokenField: 'max_tokens',
      send,
    });

    expect(bodies[1]?.max_tokens).toBe(36_864);
  });

  it('repairs a Google body through its dotted generationConfig path', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies: Array<Record<string, unknown>> = [];
    const send = vi.fn(async (body: Record<string, unknown>) => {
      bodies.push(body);
      return bodies.length === 1 ? bad(GOOGLE_CEILING) : ok();
    });

    await sendWithOutputLimitRecovery({
      providerId: 'google',
      modelId: 'gemini-x',
      body: { contents: [], generationConfig: { maxOutputTokens: 64_000, temperature: 0.2 } },
      tokenField: 'generationConfig.maxOutputTokens',
      send,
    });

    expect(bodies[1]?.generationConfig).toEqual({ maxOutputTokens: 8_192, temperature: 0.2 });
  });

  it('warns once, naming the model, when a repair succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const send = vi.fn(async () => {
      call += 1;
      return call === 1 ? bad(ANTHROPIC_CEILING) : ok();
    });

    await sendWithOutputLimitRecovery({
      providerId: 'anthropic',
      modelId: 'claude-3-5-haiku-20241022',
      body: { max_tokens: 64_000 },
      tokenField: 'max_tokens',
      send,
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('claude-3-5-haiku-20241022');
    expect(String(warn.mock.calls[0]?.[0])).toContain('64000 -> 8192');
  });
});
