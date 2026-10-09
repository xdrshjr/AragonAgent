import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '../llm/providers/anthropic.js';
import { GoogleProvider } from '../llm/providers/google.js';
import { OpenAIProvider } from '../llm/providers/openai.js';
import { clearLearnedCeilings, getLearnedCeiling, learnModelCeiling } from '../llm/output-limits.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearLearnedCeilings();
});

describe.each([
  { name: 'Google', Provider: GoogleProvider },
  { name: 'Anthropic', Provider: AnthropicProvider },
  { name: 'OpenAI', Provider: OpenAIProvider },
])('$name discovery cancellation', ({ Provider }) => {
  it('skips discovery when the owning session is already cancelled', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(new Provider().listModels('test', undefined, controller.signal)).resolves.toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('aborts an in-flight fetch when the session is cancelled', async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = options.signal ?? undefined;
      requestSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const controller = new AbortController();
    const pending = new Provider().listModels('test', undefined, controller.signal);
    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).resolves.toEqual([]);
  });

  it('removes its timeout after discovery completes', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [], models: [] }))));
    await new Provider().listModels('test');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts an unresponsive endpoint within the discovery timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const pending = new Provider().listModels('test');
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

const cases = [
  {
    name: 'Google', provider: () => new GoogleProvider(), cursor: 'pageToken',
    page: (id: string, next?: unknown) => ({ models: [{ name: `models/${id}`,
      inputTokenLimit: 262144, supportedGenerationMethods: ['generateContent'] }], nextPageToken: next }),
  },
  {
    name: 'Anthropic', provider: () => new AnthropicProvider(), cursor: 'after_id',
    page: (id: string, next?: unknown) => ({ data: [{ id, max_input_tokens: 262144 }],
      has_more: next !== undefined, last_id: next }),
  },
];

describe.each(cases)('$name model discovery pagination', ({ provider, cursor, page }) => {
  it('retrieves context metadata on later pages while keeping cursors on the configured endpoint', async () => {
    const token = 'https://other.test/path?key=foreign&cursor=2';
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page('first', token))))
      .mockResolvedValueOnce(new Response(JSON.stringify(page('active'))));
    vi.stubGlobal('fetch', fetcher);
    const models = await provider().listModels('test-key', 'https://gateway.test/custom');
    expect(models.map((model) => model.id)).toEqual(['first', 'active']);
    expect(models[1]).toMatchObject({ contextWindow: 262144, contextWindowSource: 'api' });
    const first = new URL(String(fetcher.mock.calls[0]![0]));
    const second = new URL(String(fetcher.mock.calls[1]![0]));
    expect(second.origin).toBe(first.origin);
    expect(second.pathname).toBe(first.pathname);
    expect(second.searchParams.get(cursor)).toBe(token);
    expect(fetcher.mock.calls[1]![1]).toEqual(fetcher.mock.calls[0]![1]);
  });

  it.each(['http', 'network', 'json'])('preserves earlier metadata on later %s failure', async (failure) => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page('first', 'next'))));
    if (failure === 'network') fetcher.mockRejectedValueOnce(new Error('offline'));
    else fetcher.mockResolvedValueOnce(failure === 'http'
      ? new Response('', { status: 503 }) : new Response('{'));
    vi.stubGlobal('fetch', fetcher);
    expect((await provider().listModels('test')).map((model) => model.id)).toEqual(['first']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stops when a cursor cycles', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(page('first', 'repeat'))));
    vi.stubGlobal('fetch', fetcher);
    await provider().listModels('test');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([12, {}, ''])('ignores malformed or empty cursor %s', async (cursorValue) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(page('first', cursorValue))));
    vi.stubGlobal('fetch', fetcher);
    expect((await provider().listModels('test')).map((model) => model.id)).toEqual(['first']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds the number of pages and shares one timeout across requests', async () => {
    let index = 0;
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(page(`model-${index++}`, `next-${index}`))));
    vi.stubGlobal('fetch', fetcher);
    await provider().listModels('test');
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(20);
    const firstSignal = fetcher.mock.calls[0]![1].signal;
    expect(firstSignal).toBeInstanceOf(AbortSignal);
    expect(fetcher.mock.calls.every((call) => call[1].signal === firstSignal)).toBe(true);
  });
});

it('does not learn Google output ceilings from earlier pages after caller cancellation', async () => {
  let started!: () => void;
  const secondPageStarted = new Promise<void>((resolve) => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'models/custom',
      inputTokenLimit: 262144, outputTokenLimit: 8192, supportedGenerationMethods: ['generateContent'] }],
    nextPageToken: 'next' })))
    .mockImplementationOnce((_url: unknown, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      started();
    })));
  const controller = new AbortController();
  const pending = new GoogleProvider().listModels('test', undefined, controller.signal);
  await secondPageStarted;
  learnModelCeiling('google', 'custom', 65536, 'discovery');
  controller.abort();
  await expect(pending).resolves.toEqual([]);
  expect(getLearnedCeiling('google', 'custom')?.ceiling).toBe(65536);
});
