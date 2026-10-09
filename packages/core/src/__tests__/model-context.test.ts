import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRegistry } from '../llm/model-registry.js';
import { initProviders } from '../llm/providers/index.js';
import { OpenAIProvider } from '../llm/providers/openai.js';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import { GoogleProvider } from '../llm/providers/google.js';

afterEach(() => vi.unstubAllGlobals());

function respond(body: unknown) {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('provider context metadata', () => {
  it.each(['context_length', 'context_window', 'max_input_tokens'])('reads OpenAI-compatible %s', async (field) => {
    respond({ data: [{ id: 'vendor/custom', [field]: 262144 }] });
    const [model] = await new OpenAIProvider().listModels('test', 'https://gateway.test/v1');
    expect(model).toMatchObject({ contextWindow: 262144, contextWindowSource: 'api' });
  });

  it('uses an OpenRouter endpoint limit before the general model limit', async () => {
    respond({ data: [{ id: 'vendor/custom', context_length: 1000000,
      top_provider: { context_length: 200000 } }] });
    expect((await new OpenAIProvider().listModels('test'))[0]?.contextWindow).toBe(200000);
  });

  it('reads Anthropic max_input_tokens', async () => {
    respond({ data: [{ id: 'claude-custom', max_input_tokens: 1000000 }] });
    expect((await new AnthropicProvider().listModels('test'))[0])
      .toMatchObject({ contextWindow: 1000000, contextWindowSource: 'api' });
  });

  it('reads Google inputTokenLimit', async () => {
    respond({ models: [{ name: 'models/custom', inputTokenLimit: 1048576,
      supportedGenerationMethods: ['generateContent'] }] });
    expect((await new GoogleProvider().listModels('test'))[0])
      .toMatchObject({ contextWindow: 1048576, contextWindowSource: 'api' });
  });

  it.each([undefined, 0, -1, '1000000', 1.5])('does not promote invalid metadata %s to a known window', async (value) => {
    respond({ data: [{ id: 'custom', context_length: value }] });
    expect((await new OpenAIProvider().listModels('test'))[0])
      .toMatchObject({ contextWindowSource: 'fallback' });
  });
});

describe('context resolution', () => {
  it.each([
    ['openai', 'gpt-5', 400000],
    ['openai', 'gpt-5.1', 400000],
    ['openai', 'gpt-5.2', 400000],
    ['openai', 'gpt-5.4', 1050000],
    ['openai', 'gpt-5.4-mini', 400000],
    ['openai', 'gpt-5-mini', 400000],
    ['openai', 'gpt-5.3-codex', 400000],
    ['openai', 'openai/gpt-4.1-2025-04-14', 1047576],
    ['anthropic', 'claude-sonnet-4-5', 200000],
    ['anthropic', 'claude-sonnet-4-6', 1000000],
    ['anthropic', 'claude-opus-4-6', 1000000],
    ['openai', 'anthropic/claude-sonnet-4-5', 200000],
    ['google', 'gemini-2.5-pro', 1048576],
    ['google', 'gemini-2.5-flash', 1048576],
  ])('resolves catalog context for %s/%s without knowing its price', (provider, id, window) => {
    expect(new ModelRegistry().getContextWindow(provider, id))
      .toEqual({ contextWindow: window, contextWindowSource: 'catalog' });
  });

  it('does not guess a future model family', () => {
    expect(new ModelRegistry().getContextWindow('openai', 'gpt-99'))
      .toEqual({ contextWindow: 128000, contextWindowSource: 'fallback' });
  });

  it('does not relabel a registered runtime placeholder as catalog knowledge', () => {
    const registry = new ModelRegistry();
    registry.registerBuiltinModels('custom', [registry.buildRuntimeModel('custom', 'alias')]);
    expect(registry.getContextWindow('custom', 'alias').contextWindowSource).toBe('fallback');
  });

  it('resolves a Google models/ prefixed ID against discovered metadata', async () => {
    respond({ models: [{ name: 'models/custom', inputTokenLimit: 999999,
      supportedGenerationMethods: ['generateContent'] }] });
    const registry = new ModelRegistry(initProviders());
    await registry.discoverModels('google', 'test');
    expect(registry.getContextWindow('google', 'models/custom'))
      .toEqual({ contextWindow: 999999, contextWindowSource: 'api' });
  });

  it('does not confuse object prototype keys with catalog models', () => {
    expect(new ModelRegistry().getContextWindow('openai', 'constructor').contextWindowSource).toBe('fallback');
  });

  it('uses discovery for the requested endpoint, without changing pricing or other endpoints', async () => {
    const fetcher = respond({ data: [{ id: 'gpt-4o', context_length: 64000 }] });
    const registry = new ModelRegistry(initProviders());
    await registry.discoverModels('openai', 'test', 'https://a.test/v1');
    expect(registry.getContextWindow('openai', 'gpt-4o', 'https://a.test/v1/'))
      .toEqual({ contextWindow: 64000, contextWindowSource: 'api' });
    expect(registry.getContextWindow('openai', 'gpt-4o', 'https://b.test/v1').contextWindow).toBe(128000);
    expect(registry.getModel('openai', 'gpt-4o')?.cost.input).toBe(2.5);
    await registry.discoverModels('openai', 'test', 'https://a.test/v1/');
    expect(fetcher).toHaveBeenCalledTimes(1);
    registry.clearCache();
    expect(registry.getContextWindow('openai', 'gpt-4o', 'https://a.test/v1').contextWindowSource).toBe('catalog');
  });

  it('does not replace a catalog window with an API placeholder', async () => {
    respond({ data: [{ id: 'gpt-5' }] });
    const registry = new ModelRegistry(initProviders());
    await registry.discoverModels('openai', 'test');
    expect(registry.getContextWindow('openai', 'gpt-5').contextWindow).toBe(400000);
  });

  it('shares concurrent discovery requests', async () => {
    const fetcher = respond({ data: [] });
    const registry = new ModelRegistry(initProviders());
    await Promise.all([registry.discoverModels('openai', 'test'), registry.discoverModels('openai', 'test')]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not restore invalidated metadata when an old request finishes', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { finish = r; })));
    const registry = new ModelRegistry(initProviders());
    const pending = registry.discoverModels('openai', 'test');
    registry.clearCache('openai');
    finish(new Response(JSON.stringify({ data: [{ id: 'custom', context_length: 900000 }] })));
    await pending;
    expect(registry.getContextWindow('openai', 'custom').contextWindowSource).toBe('fallback');
  });

  it('clearing another provider does not discard this pending lookup', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { finish = r; })));
    const registry = new ModelRegistry(initProviders());
    const pending = registry.discoverModels('openai', 'test');
    registry.clearCache('google');
    finish(new Response(JSON.stringify({ data: [{ id: 'custom', context_length: 900000 }] })));
    await pending;
    expect(registry.getContextWindow('openai', 'custom').contextWindow).toBe(900000);
  });

  it('does not cache a cancelled lookup or let it replace a new lookup', async () => {
    let finish!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((r) => { finish = r; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'custom', context_length: 64000 }] }))));
    const registry = new ModelRegistry(initProviders());
    const abort = new AbortController();
    const old = registry.discoverModels('openai', 'test', undefined, abort.signal);
    abort.abort();
    const current = registry.discoverModels('openai', 'test');
    finish(new Response(JSON.stringify({ data: [{ id: 'custom', context_length: 900000 }] })));
    await Promise.all([old, current]);
    expect(registry.getContextWindow('openai', 'custom').contextWindow).toBe(64000);
  });
});
