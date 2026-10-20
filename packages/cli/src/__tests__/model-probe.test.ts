import { describe, expect, it, vi, afterEach } from 'vitest';
import { LLMError, type LLMProvider, type ModelInfo } from '@aragon-agent/core';
import { createModelProbe, endpointHost, resolveDraftKey,
  type ProbeRequest } from '../agent/model-probe.js';
import { PROBE_LIMITS } from '../agent/model-probe-limits.js';
import { profileEndpointSummary } from '../ui/overlays/ModelProfilePicker.js';

const KEY = 'sk-probe-secret-0001';
const BASE = 'https://gateway.example/v1';

function info(id: string, contextWindow = 200_000,
  source: 'api' | 'fallback' = 'api'): ModelInfo {
  return { id, name: id, provider: 'anthropic', contextWindow, contextWindowSource: source,
    maxOutputTokens: 8192, supportsThinking: true, supportsTools: true, supportsImages: true,
    cost: { input: 1, output: 2 } } as ModelInfo;
}

interface FakeOptions {
  models?: ModelInfo[];
  listDelayMs?: number;
  onList?: (signal?: AbortSignal) => Promise<ModelInfo[]>;
  onComplete?: (request: { maxTokens?: number; signal?: AbortSignal }) =>
    Promise<{ role: 'assistant'; content: unknown[] }>;
}

function fakeProvider(options: FakeOptions = {}): LLMProvider {
  return {
    id: 'anthropic',
    displayName: 'Anthropic',
    defaultBaseUrl: 'https://api.anthropic.com',
    // eslint-disable-next-line require-yield
    stream: async function* () { /* not used by the probe */ },
    complete: async (request: { maxTokens?: number; signal?: AbortSignal }) => (options.onComplete
      ? options.onComplete(request) as never
      : { role: 'assistant', content: [{ type: 'text', text: 'OK' }],
        usage: { inputTokens: 18, outputTokens: 4 } }),
    listModels: async (_key: string, _base?: string, signal?: AbortSignal) => {
      if (options.onList) return options.onList(signal);
      if (options.listDelayMs) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.listDelayMs));
      }
      return options.models ?? [info('claude-sonnet-4-5-20250929')];
    },
  } as unknown as LLMProvider;
}

function registryOf(provider: LLMProvider | undefined) {
  return { get: (id: string) => (id === provider?.id ? provider : undefined) };
}

const request = (over: Partial<ProbeRequest> = {}): ProbeRequest => ({ provider: 'anthropic',
  model: 'claude-sonnet-4-5-20250929', baseUrl: null, apiKey: KEY, ...over });

afterEach(() => { vi.useRealTimers(); });

describe('零网络守卫', () => {
  it('无适配器时不发请求', async () => {
    const listModels = vi.fn();
    const probe = createModelProbe({ registry: { get: () => undefined } });
    const outcome = await probe.test(request());
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('unsupported_provider');
    expect(outcome.latencyMs).toBe(0);
    expect(listModels).not.toHaveBeenCalled();
  });
  it('没有 key 时不发请求，也没有网络', async () => {
    const listModels = vi.fn(async () => []);
    const provider = fakeProvider();
    provider.listModels = listModels;
    const probe = createModelProbe({ registry: registryOf(provider) });
    const outcome = await probe.test(request({ apiKey: null }));
    expect(outcome.kind).toBe('missing_key');
    expect(listModels).not.toHaveBeenCalled();
  });
  it('base URL 形状不合法时不发请求', async () => {
    const listModels = vi.fn(async () => []);
    const provider = fakeProvider();
    provider.listModels = listModels;
    const probe = createModelProbe({ registry: registryOf(provider) });
    const outcome = await probe.test(request({ baseUrl: 'https://user:pw@host/?q=1' }));
    expect(outcome.kind).toBe('invalid_base_url');
    expect(listModels).not.toHaveBeenCalled();
  });
  it('missing_key 先于 invalid_base_url 判定', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider()) });
    const outcome = await probe.test(request({ apiKey: '', baseUrl: 'not a url' }));
    expect(outcome.kind).toBe('missing_key');
  });
});

describe('resolveDraftKey 三种凭据模式', () => {
  it('keep 取原档案的 key，再回落到共享 key', () => {
    expect(resolveDraftKey({ credentialMode: 'keep', draftKey: '', existingKey: 'saved',
      sharedKey: 'shared' })).toBe('saved');
    expect(resolveDraftKey({ credentialMode: 'keep', draftKey: '', existingKey: null,
      sharedKey: 'shared' })).toBe('shared');
  });
  it('replace 只用输入值', () => {
    expect(resolveDraftKey({ credentialMode: 'replace', draftKey: ' typed ', existingKey: 'saved',
      sharedKey: 'shared' })).toBe('typed');
    expect(resolveDraftKey({ credentialMode: 'replace', draftKey: '   ', existingKey: 'saved',
      sharedKey: 'shared' })).toBeNull();
  });
  it('shared 只用共享 key', () => {
    expect(resolveDraftKey({ credentialMode: 'shared', draftKey: 'typed', existingKey: 'saved',
      sharedKey: 'shared' })).toBe('shared');
    expect(resolveDraftKey({ credentialMode: 'shared', draftKey: 'typed', existingKey: 'saved' }))
      .toBeNull();
  });
});

describe('成功路径与列表的从属关系', () => {
  it('真往返成功时给出耗时、回复与用量', async () => {
    let clock = 0;
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => { clock += 812; return { role: 'assistant',
        content: [{ type: 'text', text: 'OK' }], usage: { inputTokens: 18, outputTokens: 4 } }; },
    })), now: () => clock });
    const outcome = await probe.test(request());
    expect(outcome.ok).toBe(true);
    expect(outcome.latencyMs).toBe(812);
    expect(outcome.reply).toBe('OK');
    expect(outcome.usage).toEqual({ inputTokens: 18, outputTokens: 4 });
    expect(outcome.availableModels).toBe(1);
    expect(outcome.modelListed).toBe(true);
  });
  it('列表为空但 completion 成功时仍然 ok（网关不实现 /models）', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider({ models: [] })) });
    const outcome = await probe.test(request());
    expect(outcome.ok).toBe(true);
    expect(outcome.availableModels).toBe(0);
  });
  it('列表比裁决慢时不计入裁决，availableModels 缺省', async () => {
    let clock = 0;
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      listDelayMs: 50,
      onComplete: async () => { clock += 200; return { role: 'assistant',
        content: [{ type: 'text', text: 'OK' }] }; },
    })), now: () => clock });
    const outcome = await probe.test(request());
    expect(outcome.ok).toBe(true);
    expect(outcome.latencyMs).toBeLessThan(1000);
    expect(outcome.availableModels).toBeUndefined();
  });
  it('没有填模型时只列模型并返回可达数量', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider()) });
    const outcome = await probe.test(request({ model: '' }));
    expect(outcome.ok).toBe(true);
    expect(outcome.availableModels).toBe(1);
  });
  it('列表同步抛错时仍然以 completion 为裁决（列表无否决权）', async () => {
    const provider = fakeProvider();
    // 适配器在第一个 await 之前抛错：没有这一层兜底，整个探测会被列表带崩。
    provider.listModels = (() => { throw new Error('list exploded'); }) as never;
    const probe = createModelProbe({ registry: registryOf(provider) });
    const outcome = await probe.test(request());
    expect(outcome.ok).toBe(true);
    expect(outcome.availableModels).toBeUndefined();
  });
});

describe('失败分类矩阵', () => {
  it('401 归为 auth 且文案含状态码', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => { throw new LLMError('unauthorized', 'anthropic', 'auth_error',
        false, 401); },
    })) });
    const outcome = await probe.test(request());
    expect(outcome.kind).toBe('auth');
    expect(outcome.detail).toBe('Key rejected by anthropic (HTTP 401).');
  });
  it('model 被拒时 complete 恰好一次并附加可达数', async () => {
    const complete = vi.fn(async () => {
      throw new LLMError('model: unknown model id', 'anthropic', 'invalid_request', false, 400);
    });
    const provider = fakeProvider();
    provider.complete = complete as never;
    const probe = createModelProbe({ registry: registryOf(provider) });
    const outcome = await probe.test(request({ model: 'ghost-model' }));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('model_not_found');
    expect(outcome.detail).toContain('ghost-model');
    expect(outcome.availableModels).toBe(1);
    expect(outcome.modelListed).toBe(false);
  });
  it('网络不可达时文案含 host 且不含路径', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => { throw new LLMError('fetch failed', 'anthropic', 'network_error',
        true); },
    })) });
    const outcome = await probe.test(request({ baseUrl: BASE }));
    expect(outcome.kind).toBe('network');
    expect(outcome.detail).toContain('gateway.example');
    expect(outcome.detail).not.toContain('/v1');
  });
  it('限流与不可用分别归类', async () => {
    const limited = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => { throw new LLMError('slow down', 'anthropic', 'rate_limit',
        true, 429); },
    })) });
    expect((await limited.test(request())).kind).toBe('rate_limit');
    const down = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => { throw new LLMError('boom', 'anthropic', 'server_error',
        true, 503); },
    })) });
    expect((await down.test(request())).kind).toBe('provider_unavailable');
  });
  it('非 LLMError 归为 unknown 且文案固定', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => { throw new Error('opaque'); },
    })) });
    const outcome = await probe.test(request());
    expect(outcome.kind).toBe('unknown');
    expect(outcome.detail).toBe('The provider failed in an unrecognized way.');
  });
  it('没有文本块时不算成功', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => ({ role: 'assistant', content: [] }),
    })) });
    expect((await probe.test(request())).ok).toBe(false);
  });
});

describe('信号优先于错误类型', () => {
  it('用户取消时不渲染成网络错误', async () => {
    const controller = new AbortController();
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: (req) => new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(
          new LLMError('aborted', 'anthropic', 'network_error', true)));
      }) as never,
    })) });
    const pending = probe.test(request({ signal: controller.signal }));
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('cancelled');
  });
  it('截止时间到点时是 timeout 且文案含秒数', async () => {
    vi.useFakeTimers();
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: (req) => new Promise((_resolve, reject) => {
        req.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }) as never,
    })) });
    const pending = probe.test(request());
    await vi.advanceTimersByTimeAsync(PROBE_LIMITS.testTimeoutMs + 50);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('timeout');
    expect(outcome.detail).toContain('20 s');
  });
});

describe('token 字段错误的一次修复', () => {
  it('400 命中输出上限分类时用 maxTokens 缺省重试恰好一次', async () => {
    const calls: Array<number | undefined> = [];
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async (req) => {
        calls.push(req.maxTokens);
        if (calls.length === 1) {
          throw new LLMError("unsupported parameter: 'max_tokens'", 'openai', 'invalid_request',
            false, 400);
        }
        return { role: 'assistant', content: [{ type: 'text', text: 'OK' }] };
      },
    })) });
    const outcome = await probe.test(request({ provider: 'anthropic' }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBeUndefined();
    expect(outcome.ok).toBe(true);
  });
  it('两次都被拒绝时按分类矩阵报告（AC-20）', async () => {
    const complete = vi.fn(async () => {
      throw new LLMError("unsupported parameter: 'max_tokens'", 'openai', 'invalid_request',
        false, 400);
    });
    const provider = fakeProvider();
    provider.complete = complete as never;
    const probe = createModelProbe({ registry: registryOf(provider) });
    const outcome = await probe.test(request());
    expect(complete).toHaveBeenCalledTimes(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('invalid_request');
  });
});

describe('指纹', () => {
  it('同一目标稳定，换模型或换 key 立刻失效', () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider()) });
    const base = request().apiKey;
    const first = probe.targetFingerprint({ provider: 'anthropic', model: 'a',
      baseUrl: BASE, apiKey: base });
    expect(probe.targetFingerprint({ provider: 'anthropic', model: 'a', baseUrl: `${BASE}/`,
      apiKey: base })).toBe(first);
    expect(probe.targetFingerprint({ provider: 'anthropic', model: 'b', baseUrl: BASE,
      apiKey: base })).not.toBe(first);
    expect(probe.targetFingerprint({ provider: 'anthropic', model: 'a', baseUrl: BASE,
      apiKey: 'other-key' })).not.toBe(first);
    expect(first).not.toContain(base!);
    expect(probe.connectionFingerprint({ provider: 'anthropic', model: 'a', baseUrl: BASE,
      apiKey: null })).toContain('none');
  });
});

describe('不污染共享模型缓存', () => {
  it('探测只调用适配器，注册表的发现缓存保持为空', async () => {
    const cache = new Map<string, unknown>();
    const provider = fakeProvider();
    const discoverModules = vi.fn();
    const registry = { get: () => provider, discoveryCache: cache, discover: discoverModules };
    const probe = createModelProbe({ registry: registry as never });
    await probe.test(request());
    await probe.discover(request());
    expect(cache.size).toBe(0);
    expect(discoverModules).not.toHaveBeenCalled();
  });
});

describe('发现', () => {
  it('返回候选、总数与窗口来源', async () => {
    const listed = [info('api-model', 1_000_000, 'api'), info('plain', 200_000, 'fallback')];
    const probe = createModelProbe({ registry: registryOf(fakeProvider({ models: listed })) });
    const outcome = await probe.discover(request());
    expect(outcome.ok).toBe(true);
    expect(outcome.total).toBe(2);
    expect(outcome.models[0]).toEqual({ id: 'api-model', name: 'api-model',
      contextWindow: 1_000_000, supportsTools: true });
    // 窗口只有溯源为 api 时才上报；fallback 不上报（Anthropic 的 /v1/models 不报窗口）。
    expect(outcome.models[1]).toEqual({ id: 'plain', name: 'plain', supportsTools: true });
  });
  it('发现失败时带分类而不是空列表结论', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onList: async () => { throw new LLMError('nope', 'anthropic', 'auth_error', false, 401); },
    })) });
    const outcome = await probe.discover(request());
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('auth');
  });
  it('超过上限时截断到 400 条并保留真实总数（AC-18）', async () => {
    const listed = Array.from({ length: PROBE_LIMITS.maxListedModels + 1 },
      (_unused, at) => info(`model-${at}`));
    const probe = createModelProbe({ registry: registryOf(fakeProvider({ models: listed })) });
    const outcome = await probe.discover(request());
    expect(outcome.models).toHaveLength(PROBE_LIMITS.maxListedModels);
    expect(outcome.truncated).toBe(true);
    expect(outcome.total).toBe(PROBE_LIMITS.maxListedModels + 1);
  });
});

describe('文案纪律', () => {
  it('detail 不含 key 字面值', async () => {
    const probe = createModelProbe({ registry: registryOf(fakeProvider({
      onComplete: async () => { throw new LLMError(`${KEY} is invalid`, 'anthropic',
        'auth_error', false, 401); },
    })) });
    const outcome = await probe.test(request());
    expect(outcome.detail).not.toContain(KEY);
  });
  it('host 提取与页脚同一把尺子', () => {
    const cases = [null, '', BASE, 'https://gateway.example/a/b?x=1', 'not-a-url',
      'https://user:pw@gateway.example', 'https://gateway.example#frag'];
    for (const base of cases) {
      const summary = profileEndpointSummary(base);
      const host = endpointHost(base);
      if (summary === 'Default URL') expect(host).toBe('the provider');
      else if (summary === 'Invalid URL') expect(host).toBe('this endpoint');
      else expect(host).toBe(summary);
    }
  });
});
