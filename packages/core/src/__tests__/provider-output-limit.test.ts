import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMProvider, LLMRequest } from '../llm/provider.js';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import { GoogleProvider } from '../llm/providers/google.js';
import { OpenAIProvider } from '../llm/providers/openai.js';

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
