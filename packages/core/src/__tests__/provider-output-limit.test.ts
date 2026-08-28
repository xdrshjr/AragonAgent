import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, ModelInfo } from '../llm/types.js';
import type { LLMProvider, LLMRequest } from '../llm/provider.js';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import { GoogleProvider } from '../llm/providers/google.js';
import { OpenAIProvider } from '../llm/providers/openai.js';
import { ProviderRegistry } from '../llm/providers/index.js';
import { ModelRegistry } from '../llm/model-registry.js';
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  clearLearnedCeilings,
  getLearnedCeiling,
} from '../llm/output-limits.js';
import { clearLearnedTokenFields } from '../llm/output-limit-recovery.js';

interface MaxTokensRequest extends LLMRequest {
  maxTokens: number;
}

const request: LLMRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  apiKey: 'test-key',
};

afterEach(() => {
  vi.unstubAllGlobals();
  // Both caches live for the whole PROCESS; leaving either populated fails a
  // later test file for a reason that is not in it.
  clearLearnedCeilings();
  clearLearnedTokenFields();
});

async function captureRequestBody(
  provider: LLMProvider,
  currentRequest: LLMRequest = request,
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response('{"error":"stop after capture"}', {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );

  for await (const _event of provider.stream(currentRequest)) {
    break;
  }

  if (!body) throw new Error('Provider did not issue a request');
  return body;
}

describe('provider output limits', () => {
  it('defaults OpenAI output tokens to 64000', async () => {
    const body = await captureRequestBody(new OpenAIProvider());

    expect(body.max_tokens).toBe(64_000);
  });

  it('defaults Google output tokens to 64000', async () => {
    const body = await captureRequestBody(new GoogleProvider());

    expect(body).toHaveProperty('generationConfig.maxOutputTokens', 64_000);
  });

  it('defaults Anthropic output tokens to 64000', async () => {
    const body = await captureRequestBody(new AnthropicProvider());

    expect(body.max_tokens).toBe(64_000);
  });

  it.each([
    ['OpenAI', new OpenAIProvider(), 'max_tokens'],
    ['Google', new GoogleProvider(), 'generationConfig.maxOutputTokens'],
    ['Anthropic', new AnthropicProvider(), 'max_tokens'],
  ])('lets maxTokens override the %s default', async (_name, provider, path) => {
    const configuredRequest: MaxTokensRequest = { ...request, maxTokens: 7_000 };
    const body = await captureRequestBody(provider, configuredRequest);

    expect(body).toHaveProperty(path, 7_000);
  });
});

describe('provider model metadata output defaults', () => {
  it.each([
    ['OpenAI', new OpenAIProvider(), { data: [{ id: 'gpt-4-test' }] }],
    [
      'Google',
      new GoogleProvider(),
      {
        models: [{
          name: 'models/gemini-test',
          supportedGenerationMethods: ['generateContent'],
        }],
      },
    ],
    ['Anthropic', new AnthropicProvider(), { data: [{ id: 'claude-test' }] }],
  ])('uses 64000 for %s when model output metadata is absent', async (_name, provider, payload) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    );

    const models = await provider.listModels('test-key');

    expect(models[0]?.maxOutputTokens).toBe(64_000);
  });
});

// ---------------------------------------------------------------------------
// Per-model clamping, the token-field dialect, and the thinking invariant.
//
// Everything below is a request that ships an HTTP 400 today. A 400 inside
// `runAgentLoop` ends the turn with a raw provider string in the transcript and
// nothing retries, so each of these is a run that simply fails.
// ---------------------------------------------------------------------------

describe('per-model output ceilings', () => {
  it('case 21: Anthropic clamps AUTO down to a small model\'s real ceiling', async () => {
    const body = await captureRequestBody(new AnthropicProvider(), {
      ...request,
      model: 'claude-3-5-haiku-20241022',
    });

    expect(body.max_tokens).toBe(8_192);
  });

  it('case 23: Google clamps AUTO down to the gemini-1.5 ceiling', async () => {
    const body = await captureRequestBody(new GoogleProvider(), {
      ...request,
      model: 'gemini-1.5-pro',
    });

    expect(body).toHaveProperty('generationConfig.maxOutputTokens', 8_192);
  });

  it('leaves an unknown (proxy) model at the product default', async () => {
    // Unknown must NOT be treated as small: a pessimistic default would halve
    // the output of every proxy user, silently.
    const body = await captureRequestBody(new OpenAIProvider(), {
      ...request,
      model: 'my-llm-v3',
    });

    expect(body.max_tokens).toBe(64_000);
  });
});

describe('OpenAI token-field dialect', () => {
  it('case 22: the reasoning family gets max_completion_tokens and no temperature', async () => {
    const body = await captureRequestBody(new OpenAIProvider(), {
      ...request,
      model: 'o1',
      temperature: 0.7,
    });

    expect(body.max_completion_tokens).toBe(64_000);
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('temperature');
  });

  it('leaves a normal chat model on max_tokens, temperature included', async () => {
    const body = await captureRequestBody(new OpenAIProvider(), {
      ...request,
      model: 'gpt-4o',
      temperature: 0.7,
    });

    expect(body.max_tokens).toBe(16_384);
    expect(body.temperature).toBe(0.7);
    expect(body).not.toHaveProperty('max_completion_tokens');
  });
});

describe('Anthropic extended thinking', () => {
  it('case 24: xhigh keeps max_tokens strictly greater than budget_tokens', async () => {
    // THE guaranteed-400 regression: xhigh is 65536 and the default cap is
    // 64000, so before this every single xhigh request was rejected.
    const body = await captureRequestBody(new AnthropicProvider(), {
      ...request,
      model: 'claude-sonnet-4-5-20250929',
      thinkingLevel: 'xhigh',
    });

    const thinking = body.thinking as { budget_tokens: number };
    expect(typeof body.max_tokens).toBe('number');
    expect(body.max_tokens as number).toBeGreaterThan(thinking.budget_tokens);
    expect(thinking.budget_tokens).toBe(59_904);
  });

  it('leaves a budget that already fits exactly as the caller asked', async () => {
    const body = await captureRequestBody(new AnthropicProvider(), {
      ...request,
      model: 'claude-sonnet-4-5-20250929',
      thinkingLevel: 'high',
    });

    expect(body).toHaveProperty('thinking.budget_tokens', 32_768);
    expect(body.max_tokens).toBe(64_000);
  });
});

describe('listModels and the learned-ceiling cache', () => {
  function stubModelsResponse(payload: unknown): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })),
    );
  }

  it('case 25: Google records the ceiling it was actually told', async () => {
    stubModelsResponse({
      models: [{
        name: 'models/gemini-1.5-flash',
        outputTokenLimit: 8_192,
        supportedGenerationMethods: ['generateContent'],
      }],
    });

    await new GoogleProvider().listModels('test-key');

    expect(getLearnedCeiling('google', 'gemini-1.5-flash')).toEqual({
      ceiling: 8_192,
      source: 'discovery',
    });
  });

  it('case 25: Anthropic and OpenAI record NOTHING — neither API reports a ceiling', async () => {
    // Asserting knowledge we do not have is how `claude-3-5-haiku` ends up with
    // a "discovered" 64000 that outranks its correct table entry of 8192.
    stubModelsResponse({ data: [{ id: 'claude-3-5-haiku-20241022' }] });
    await new AnthropicProvider().listModels('test-key');
    expect(getLearnedCeiling('anthropic', 'claude-3-5-haiku-20241022')).toBeUndefined();

    stubModelsResponse({ data: [{ id: 'gpt-4o' }] });
    await new OpenAIProvider().listModels('test-key');
    expect(getLearnedCeiling('openai', 'gpt-4o')).toBeUndefined();
  });

  it('maps Anthropic / OpenAI discovery through the static table instead', async () => {
    stubModelsResponse({ data: [{ id: 'claude-3-5-haiku-20241022' }] });
    const anthropic = await new AnthropicProvider().listModels('test-key');
    expect(anthropic[0]?.maxOutputTokens).toBe(8_192);

    stubModelsResponse({ data: [{ id: 'gpt-4o' }] });
    const openai = await new OpenAIProvider().listModels('test-key');
    expect(openai[0]?.maxOutputTokens).toBe(16_384);
  });
});

// ---------------------------------------------------------------------------
// `ModelRegistry.discoverModels` feeds the same cache one level up, which is
// where the invariant above is easiest to lose: the adapters refuse to assert a
// ceiling they were never told, and the registry must not launder that refusal
// back into an assertion on their behalf.
// ---------------------------------------------------------------------------

describe('ModelRegistry discovery and the learned-ceiling cache', () => {
  function fakeProvider(id: string, models: ModelInfo[]): LLMProvider {
    return {
      id,
      displayName: id,
      defaultBaseUrl: 'https://example.invalid',
      stream: () => { throw new Error('not used'); },
      complete: () => Promise.reject(new Error('not used')) as Promise<AssistantMessage>,
      listModels: async () => models,
    } as LLMProvider;
  }

  function model(id: string, provider: string, maxOutputTokens: number): ModelInfo {
    return {
      id,
      name: id,
      provider,
      contextWindow: 128_000,
      maxOutputTokens,
      supportsThinking: false,
      supportsTools: true,
      supportsImages: false,
      // Required on `ModelInfo`; zeroes because nothing in this file prices a
      // request (todo-plan-followthrough W3).
      cost: { input: 0, output: 0 },
    };
  }

  function registryWith(providerId: string, models: ModelInfo[]): ModelRegistry {
    const providers = new ProviderRegistry();
    providers.register(fakeProvider(providerId, models));
    return new ModelRegistry(providers);
  }

  it('records a ceiling the provider genuinely reported', async () => {
    await registryWith('proxy', [model('small-llm', 'proxy', 4_096)])
      .discoverModels('proxy', 'test-key');

    expect(getLearnedCeiling('proxy', 'small-llm')).toEqual({
      ceiling: 4_096,
      source: 'discovery',
    });
  });

  it('does NOT record the product default, which is the "we were told nothing" value', async () => {
    // Anthropic and OpenAI `listModels` fall back to the default for any model
    // outside the static table. Recording it at `'discovery'` rank would turn
    // "unknown" into "capped at 64000" — silently clamping an explicit larger
    // request against a proxy, and outranking the static table while doing it.
    await registryWith('proxy', [model('unknown-llm', 'proxy', DEFAULT_MAX_OUTPUT_TOKENS)])
      .discoverModels('proxy', 'test-key');

    expect(getLearnedCeiling('proxy', 'unknown-llm')).toBeUndefined();
  });
});
