import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LLMRequest, Message } from '@aragon-agent/core';
import { DEFAULT_CONFIG, type CliConfig } from '../config/schema.js';
import { resolveFastTier } from '../fast/resolve.js';
import { Compactor } from '../compaction/compactor.js';

const COMPACTION_DELTA = JSON.stringify({ schemaVersion: 2, additions: [{
  section: 'facts', text: 'The assistant supplied the earlier response.',
  sources: [{ messageId: 'g1:m1', role: 'assistant', excerpt: 'aaaa' }],
}] });

const runtimeRoot = resolve('../../.agentmesh/profile-runtime-tests');
mkdirSync(runtimeRoot, { recursive: true });
const directory = mkdtempSync(`${runtimeRoot}/case-`);
process.env.ARAGON_HOME = directory;
const { AgentController } = await import('../agent/controller.js');
const { loadConfig, makeGetApiKey } = await import('../config/load.js');
const { getConfigPath, writeConfigFile } = await import('../config/store.js');
const controllers: InstanceType<typeof AgentController>[] = [];
beforeEach(() => { rmSync(getConfigPath(), { force: true }); });
afterAll(() => {
  controllers.forEach((controller) => controller.dispose());
  rmSync(directory, { recursive: true, force: true });
});

function controller() {
  const live = loadConfig({ cwd: process.cwd() });
  live.skills.enabled = false;
  live.team.enabled = false;
  live.fast.enabled = false;
  live.compaction.enabled = false;
  const instance = new AgentController(live, {});
  controllers.push(instance);
  return instance;
}

function config(): CliConfig {
  return {
    ...structuredClone(DEFAULT_CONFIG), provider: 'openai', model: 'same-model',
    baseUrl: 'https://main.example/v1',
    fast: { ...DEFAULT_CONFIG.fast, enabled: true, provider: 'openai',
      model: 'same-model', baseUrl: '' },
    modelProfiles: { version: 1, mainId: 'a', fastId: 'b', entries: [
      { id: 'a', name: 'Main', provider: 'openai', model: 'same-model',
        baseUrl: 'https://main.example/v1', apiKey: 'main-secret' },
      { id: 'b', name: 'Fast', provider: 'openai', model: 'same-model',
        baseUrl: null, apiKey: 'fast-secret' },
    ] },
  } as unknown as CliConfig;
}

describe('模型配置运行时角色隔离', () => {
  it('绑定默认地址的快速模型不继承主网关，并以 fast 角色检查密钥', () => {
    const hasKey = vi.fn(() => true);
    const tier = resolveFastTier(config(), hasKey);
    expect(tier.ok && tier.ref.baseUrl).toBeUndefined();
    expect(hasKey).toHaveBeenCalledWith('openai', 'fast');
  });

  it('相同模型名的压缩失败阶梯仍切换到主地址和主密钥', async () => {
    const cfg = config();
    const requests: LLMRequest[] = [];
    const messages: Message[] = Array.from({ length: 12 }, (_, i) => [
      { role: 'user' as const, content: `question ${i} ${'q'.repeat(2000)}`, timestamp: i },
      { role: 'assistant' as const, content: [{ type: 'text' as const,
        text: 'a'.repeat(4000) }] },
    ]).flat();
    const compactor = new Compactor({
      getConfig: () => cfg, hasKey: () => true,
      getApiKey: (_id, role) => role === 'fast' ? 'fast-secret' : 'main-secret',
      getMessages: () => messages, getSystemPrompt: () => '',
      getModelInfoFor: () => ({ id: 'same-model', name: 'Model', provider: 'openai',
        contextWindow: 200000, maxOutputTokens: 16000, supportsTools: true,
        supportsThinking: false, supportsImages: false, cost: { input: 0, output: 0 } }),
      isPricedModel: () => false, emit: () => {}, notify: () => {},
      onPressure: () => {},
      complete: async (_id, request) => {
        requests.push(request);
        if (requests.length === 1) throw new Error('temporary failure');
        return { role: 'assistant', content: [{ type: 'text', text: COMPACTION_DELTA }] };
      },
    });
    const outcome = await compactor.compact({ messages, messageCount: messages.length, turnIndex: 1,
      trigger: 'overflow', systemPrompt: '', signal: new AbortController().signal,
      model: { providerId: cfg.provider, modelId: cfg.model, baseUrl: cfg.baseUrl } });
    expect(outcome.action).toBe('replace');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.apiKey)).toEqual(['fast-secret', 'main-secret']);
    expect(requests.map((request) => request.baseUrl))
      .toEqual([undefined, 'https://main.example/v1']);
  });
});

describe('设置事务真实 controller 接线', () => {
  it('首次只绑定快角色时保留主启动连接，并在最后解绑后继续限制启动密钥目标', () => {
    const instance = controller();
    const live = loadConfig({ provider: 'openai', model: 'startup',
      baseUrl: 'https://startup.example', apiKey: 'startup-key' });
    instance.applyModelSettingsSnapshot(instance.prepareModelSettingsSnapshot(live));
    const draft = instance.createModelSettingsDraft();
    draft.profiles = { ...config().modelProfiles!, mainId: null };
    draft.activateRoles = ['fast'];
    expect(instance.saveModelSettings(draft).ok).toBe(true);
    expect(instance.getConfig().baseUrl).toBe('https://startup.example');
    expect(makeGetApiKey(instance.getConfig())('openai')).toBe('startup-key');
    expect(makeGetApiKey(instance.getConfig(), 'fast')('openai')).toBe('fast-secret');
    instance.setModel('openai', 'resumed', 'https://resumed.example');
    const unbind = instance.createModelSettingsDraft();
    unbind.profiles!.fastId = null;
    unbind.activateRoles = ['fast'];
    expect(instance.saveModelSettings(unbind).ok).toBe(true);
    expect(makeGetApiKey(instance.getConfig())('openai')).not.toBe('startup-key');
  });

  it('真实 App 设置选择保存后关闭弹层，下一次解析使用新角色凭据', async () => {
    const React = await import('react');
    const { render } = await import('ink-testing-library');
    const { App } = await import('../ui/App.js');
    writeConfigFile({ ...DEFAULT_CONFIG, modelProfiles: config().modelProfiles });
    const instance = controller();
    const view = render(React.createElement(App, {
      controller: instance, version: 'test', initialOverlay: 'settings',
    }));
    const key = async (value: string) => {
      view.stdin.write(value);
      await new Promise((done) => setTimeout(done, 80));
    };
    try {
      await vi.waitFor(() => expect(view.lastFrame()).toContain('Main profile'));
      await key('\r');
      await key('\u001b[B');
      await key('\u001b[B');
      await key('\r');
      await key('\u0013');
      expect(instance.getConfig().modelProfiles?.mainId).toBe('b');
      expect(makeGetApiKey(instance.getConfig())('openai')).toBe('fast-secret');
      expect(view.lastFrame()).not.toContain('Manage profiles');
      expect(view.lastFrame()).not.toContain('fast-secret');
    } finally { view.unmount(); }
  });

  it('写入并激活主快方案，同时保持消息与旧式候选', () => {
    const instance = controller();
    const history: Message[] = [{ role: 'user', content: 'keep history', timestamp: 0 }];
    instance.replaceMessages(history);
    const draft = instance.createModelSettingsDraft();
    draft.profiles = config().modelProfiles;
    draft.activateRoles = ['main', 'fast'];
    expect(instance.saveModelSettings(draft)).toMatchObject({ ok: true, persisted: true });
    const live = instance.getConfig();
    expect(live.provider).toBe('openai');
    expect(live.fast.baseUrl).toBe('');
    expect(makeGetApiKey(live)('openai')).toBe('main-secret');
    expect(makeGetApiKey(live, 'fast')('openai')).toBe('fast-secret');
    expect(instance.getMessages()).toEqual(history);
    const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(saved.provider).toBe(DEFAULT_CONFIG.provider);
    expect(saved.modelProfiles.entries).toHaveLength(2);
  });

  it('后台 review 未结束、磁盘冲突或普通 setter 修改时拒绝覆盖', () => {
    const instance = controller();
    const draft = instance.createModelSettingsDraft();
    draft.patch = { theme: 'warm' };
    const busy = vi.spyOn(instance, 'getFastStatus').mockReturnValue({
      ...instance.getFastStatus(), snapshot: { ...instance.getFastStatus().snapshot, inFlight: true },
    });
    expect(instance.saveModelSettings(draft)).toMatchObject({ code: 'busy', persisted: false });
    busy.mockRestore();
    instance.setTheme('cool');
    expect(instance.saveModelSettings(draft)).toMatchObject({ code: 'conflict' });
    const fresh = instance.createModelSettingsDraft();
    writeConfigFile({ ...DEFAULT_CONFIG, theme: 'light' });
    expect(instance.saveModelSettings(fresh)).toMatchObject({ code: 'conflict' });
    expect(instance.getConfig().theme).toBe('cool');
  });

  it('核心应用故障在已提交后阻断新请求，不重复写盘', async () => {
    const instance = controller();
    const draft = instance.createModelSettingsDraft();
    draft.patch = { theme: 'warm' };
    vi.spyOn(instance, 'applyModelSettingsSnapshot').mockImplementationOnce(() => {
      throw new Error('sensitive details');
    });
    expect(instance.saveModelSettings(draft)).toMatchObject({
      ok: false, persisted: true, status: 'saved_apply_failed',
    });
    expect(instance.areModelSettingsBlocked()).toBe(true);
    expect(instance.preflight().ok).toBe(false);
    expect(await instance.prompt('blocked')).toMatchObject({ status: 'not-started' });
    expect(JSON.parse(readFileSync(getConfigPath(), 'utf8')).theme).toBe('warm');
  });

  it('普通设置和名称编辑保留启动覆盖；显式重新选择才清除覆盖', () => {
    const instance = controller();
    const profiles = config().modelProfiles!;
    writeConfigFile({ ...DEFAULT_CONFIG, modelProfiles: profiles });
    const live = loadConfig({ provider: 'openai', baseUrl: 'https://override.example',
      apiKey: 'override-key' });
    instance.applyModelSettingsSnapshot(instance.prepareModelSettingsSnapshot(live));
    const draft = instance.createModelSettingsDraft();
    draft.patch = { theme: 'warm' };
    draft.profiles!.entries[0]!.name = 'Rename only';
    expect(instance.saveModelSettings(draft).ok).toBe(true);
    expect(instance.getConfig().baseUrl).toBe('https://override.example');
    expect(makeGetApiKey(instance.getConfig())('openai')).toBe('override-key');
    const activate = instance.createModelSettingsDraft();
    activate.activateRoles = ['main'];
    expect(instance.saveModelSettings(activate).ok).toBe(true);
    expect(instance.getConfig().baseUrl).toBe('https://main.example/v1');
    expect(makeGetApiKey(instance.getConfig())('openai')).toBe('main-secret');
  });

  it('拒绝隐式解绑专属账户，损坏 reload 保留 live', () => {
    const instance = controller();
    const draft = instance.createModelSettingsDraft();
    draft.profiles = config().modelProfiles;
    draft.activateRoles = ['main', 'fast'];
    expect(instance.saveModelSettings(draft).ok).toBe(true);
    const previous = instance.getConfig();
    expect(instance.saveModelSettingsPatch({ model: 'new' }))
      .toMatchObject({ ok: false, code: 'profile_key_required' });
    writeFileSync(getConfigPath(), '{"private-key":');
    expect(instance.reloadModelSettings()).toMatchObject({ ok: false, code: 'read_failed' });
    expect(instance.getConfig()).toBe(previous);
  });
});

const { ProviderRegistry } = await import('@aragon-agent/core');
const { FastWiring } = await import('../fast/wiring.js');
const { TeamRuntime } = await import('../team/runtime.js');
const { createChildContextManager } = await import('../compaction/child.js');
type AgentEvent = import('@aragon-agent/core').AgentEvent;
type ModelRef = import('@aragon-agent/core').ModelRef;
type ModelRole = import('../config/model-profiles.js').ModelRole;

function roleKey(cfg: CliConfig) {
  return (id: string, role: ModelRole = 'main') => makeGetApiKey(cfg, role)(id);
}

function fastHarness(cfg: CliConfig) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const getApiKey = roleKey(cfg);
  const wiring = new FastWiring({
    getConfig: () => cfg, getApiKey,
    hasKey: (id, role) => Boolean(getApiKey(id, role)),
    isPricedModel: () => false,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    complete: async () => { throw new Error('评审不应调用主 transport'); },
    steer: () => {}, isRunning: () => true, isAbortRequested: () => false,
    userSteerCount: () => 0, clearAllQueues: () => {}, notify: () => {},
    onPromptChanged: () => {},
  });
  return { wiring, emit: (event: AgentEvent) => listeners.forEach((listener) => listener(event)) };
}

function compactionHistory(): Message[] {
  return Array.from({ length: 12 }, (_, index): Message[] => [
    { role: 'user', content: `问题 ${index} ${'q'.repeat(2000)}`, timestamp: index },
    { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(4000) }] },
  ]).flat();
}

async function compactChild(cfg: CliConfig, model: ModelRef, role: ModelRole) {
  const requests: LLMRequest[] = [];
  const messages = compactionHistory();
  const getApiKey = roleKey(cfg);
  const manager = createChildContextManager({
    label: 'worker', model, role, getMessages: () => messages,
    getSystemPrompt: () => '', onCompacted: () => {},
  }, {
    getConfig: () => cfg, getApiKey,
    hasKey: (id, selectedRole) => Boolean(getApiKey(id, selectedRole)),
    getModelInfoFor: (ref) => ({
      id: ref.modelId, provider: ref.providerId, name: 'Model', contextWindow: 200000,
      maxOutputTokens: 16000, supportsTools: true, supportsThinking: false,
      supportsImages: false, cost: { input: 0, output: 0 },
    }),
    isPricedModel: () => false, onUsage: () => {},
    complete: async (_id, request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error('首次压缩失败');
      return { role: 'assistant', content: [{ type: 'text', text: COMPACTION_DELTA }] };
    },
  });
  const outcome = await manager.compact({
    messages, messageCount: messages.length, turnIndex: 1, trigger: 'overflow',
    systemPrompt: '', model, signal: new AbortController().signal,
  });
  return { requests, outcome };
}

describe('真实运行时请求使用角色对应账户', () => {
  it('FastWiring 的 reviewer 在主快模型同名时仍固定使用 fast 凭据', async () => {
    const cfg = config();
    cfg.fast.review = true;
    cfg.fast.reviewEveryTurns = 1;
    const requests: LLMRequest[] = [];
    const transport = vi.spyOn(ProviderRegistry.prototype, 'complete')
      .mockImplementation(async (_id, request) => {
        requests.push(request);
        return { role: 'assistant', content: [{ type: 'text', text: 'OK' }] };
      });
    const { wiring, emit } = fastHarness(cfg);
    try {
      emit({ type: 'agent_start' });
      emit({ type: 'turn_start' });
      emit({ type: 'turn_end', usage: { inputTokens: 0, outputTokens: 0 }, message: {
        role: 'assistant', content: [{ type: 'tool_call', toolCallId: 'read',
          toolName: 'read_file', args: {} }],
      } });
      emit({ type: 'tool_execution_end', toolCallId: 'read', toolName: 'read_file',
        result: { content: [] }, isError: false, duration: 1 });
      await vi.waitFor(() => expect(wiring.snapshot().inFlight).toBe(false));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ model: 'same-model', apiKey: 'fast-secret' });
      expect(requests[0]!.baseUrl).toBeUndefined();
    } finally {
      wiring.dispose();
      transport.mockRestore();
    }
  });

  it('TeamRuntime 子代理始终使用主模型凭据（主代理对等）', async () => {
    // The fast tier is LIVE and resolvable, and still no child is routed
    // to it: a delegation is never a downgrade, and the fast role reaches
    // children only through per-child reviews and compaction summaries.
    const cfg = config();
    const { wiring } = fastHarness(cfg);
    const requests: LLMRequest[] = [];
    const roles: ModelRole[] = [];
    const registry = new ProviderRegistry({ retryPolicy: null });
    registry.register({
      id: 'openai', displayName: '测试适配器', defaultBaseUrl: 'https://unused.example',
      async *stream(request) {
        requests.push(request);
        yield { type: 'done', message: { role: 'assistant',
          content: [{ type: 'text', text: '任务完成' }] },
          usage: { inputTokens: 1, outputTokens: 1 } };
      },
      complete: async () => ({ role: 'assistant', content: [] }),
      listModels: async () => [],
    });
    const runtime = new TeamRuntime({
      getConfig: () => cfg, providerRegistry: registry, getCwd: () => process.cwd(),
      getMode: () => 'build', getApiKey: roleKey(cfg),
      contextManagerFor: (request) => { roles.push(request.role!); return undefined; },
    });
    try {
      const outcome = await runtime.dispatch([{ label: 'worker', description: '检查',
        prompt: '返回摘要', readOnly: true }], 1);
      expect(outcome.runs[0]!.phase).toBe('done');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.apiKey).toBe('main-secret');
      expect(requests[0]!.baseUrl).toBe('https://main.example/v1');
      expect(roles).toEqual(['main']);
    } finally {
      runtime.dispose();
      wiring.dispose();
    }
  });

  it('快子任务压缩回退自身时保留 fast 角色和默认地址，不继承主网关', async () => {
    const { requests, outcome } = await compactChild(config(), {
      providerId: 'openai', modelId: 'same-model',
    }, 'fast');
    expect(outcome.action).toBe('replace');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.apiKey)).toEqual(['fast-secret', 'fast-secret']);
    expect(requests.map((request) => request.baseUrl)).toEqual([undefined, undefined]);
  });

  it('子任务覆盖连接后，旧式 fast 候选仍从 lead 继承网关', async () => {
    const cfg = config();
    cfg.modelProfiles = undefined;
    cfg.fast.provider = '';
    cfg.apiKeys.openai = 'shared-secret';
    const { requests, outcome } = await compactChild(cfg, {
      providerId: 'openai', modelId: 'child-model', baseUrl: 'https://child.example/v1',
    }, 'main');
    expect(outcome.action).toBe('replace');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.baseUrl))
      .toEqual(['https://main.example/v1', 'https://child.example/v1']);
    expect(requests.map((request) => request.model)).toEqual(['same-model', 'child-model']);
    expect(requests.map((request) => request.apiKey)).toEqual(['shared-secret', 'shared-secret']);
  });

  it('压缩回退自身缺少密钥时不借用首次 fast 请求的专属密钥', async () => {
    const cfg = config();
    cfg.modelProfiles!.entries[0]!.apiKey = null;
    cfg.apiKeys = {};
    const { requests, outcome } = await compactChild(cfg, {
      providerId: 'openai', modelId: cfg.model, baseUrl: cfg.baseUrl,
    }, 'main');
    expect(outcome.action).toBe('keep');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.apiKey).toBe('fast-secret');
    expect(requests[0]!.baseUrl).toBeUndefined();
  });
});

describe('设置事务故障与归一化回归', () => {
  it('关键设置应用失败后的手动压缩也不允许发起请求', async () => {
    const { CompactionWiring } = await import('../compaction/wiring.js');
    const compact = vi.spyOn(CompactionWiring.prototype, 'compactNow')
      .mockResolvedValue({ ok: false, reason: 'test_transport_called' });
    const live = loadConfig({ cwd: process.cwd() });
    live.skills.enabled = false;
    live.team.enabled = false;
    live.fast.enabled = false;
    live.compaction.enabled = true;
    const instance = new AgentController(live, {});
    controllers.push(instance);
    instance.blockModelSettingsRequests();
    try {
      expect(await instance.compactNow()).toEqual({ ok: false, reason: 'settings_restart_required' });
      expect(compact).not.toHaveBeenCalled();
    } finally { compact.mockRestore(); }
  });

  it('快配置隐式解绑同时检查 live 主网关，拒绝默认地址静默变成继承', () => {
    const profiles = config().modelProfiles!;
    profiles.mainId = null;
    profiles.entries[1]!.apiKey = null;
    writeConfigFile({ ...DEFAULT_CONFIG, provider: 'openai', baseUrl: null,
      apiKeys: { openai: 'shared-key' }, modelProfiles: profiles });
    const instance = controller();
    const live = loadConfig({ baseUrl: 'https://startup.example/v1' });
    instance.applyModelSettingsSnapshot(instance.prepareModelSettingsSnapshot(live));
    const previous = instance.getConfig();
    const bytes = readFileSync(getConfigPath());
    expect(instance.saveModelSettingsPatch({ fast: { model: 'new-fast-model' } }))
      .toMatchObject({ ok: false, persisted: false, code: 'legacy_conversion_unsupported' });
    expect(instance.getConfig()).toBe(previous);
    expect(readFileSync(getConfigPath())).toEqual(bytes);
  });

  it('显式切回自定义并修改 provider 时清除旧厂商地址', () => {
    writeConfigFile({ ...DEFAULT_CONFIG, provider: 'openai', baseUrl: 'https://old.example/v1',
      fast: { ...DEFAULT_CONFIG.fast, provider: 'openai', baseUrl: 'https://old-fast.example/v1' },
      modelProfiles: config().modelProfiles });
    const instance = controller();
    const draft = instance.createModelSettingsDraft();
    draft.profiles!.mainId = null;
    draft.profiles!.fastId = null;
    draft.activateRoles = ['main', 'fast'];
    draft.patch = { provider: 'google', fast: { provider: 'google' } };
    expect(instance.saveModelSettings(draft)).toMatchObject({ ok: true, persisted: true });
    expect(instance.getConfig().baseUrl).toBeUndefined();
    expect(instance.getConfig().fast.baseUrl).toBe('');
    const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(saved.baseUrl).toBeNull();
    expect(saved.fast.baseUrl).toBe('');
  });

  it('越界 fast 策略在磁盘与 live 同步钳制，同时保留未修改的环境策略', () => {
    writeConfigFile({ ...DEFAULT_CONFIG, thinkingLevel: 'off',
      fast: { ...DEFAULT_CONFIG.fast, model: 'disk-model' } });
    vi.stubEnv('ARAGON_THINKING', 'low');
    vi.stubEnv('ARAGON_FAST_MODEL', 'env-model');
    try {
      const instance = controller();
      expect(instance.getConfig().thinkingLevel).toBe('low');
      expect(instance.getConfig().fast.model).toBe('env-model');
      const draft = instance.createModelSettingsDraft();
      draft.patch = { fast: { reviewMaxPerSession: 5000 } };
      expect(instance.saveModelSettings(draft)).toMatchObject({ ok: true, persisted: true });
      const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
      expect(saved.fast.reviewMaxPerSession).toBe(500);
      expect(instance.getConfig().fast.reviewMaxPerSession).toBe(500);
      expect(saved.fast.model).toBe('disk-model');
      expect(instance.getConfig().fast.model).toBe('env-model');
      expect(saved.thinkingLevel).toBe('off');
      expect(instance.getConfig().thinkingLevel).toBe('low');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('显式更新主 provider 的共享密钥会清除对应启动密钥覆盖', () => {
    const profiles = config().modelProfiles!;
    profiles.entries[0]!.apiKey = null;
    writeConfigFile({ ...DEFAULT_CONFIG, provider: 'openai', model: 'same-model',
      apiKeys: { openai: 'old-shared-key' }, modelProfiles: profiles });
    const instance = controller();
    const overridden = loadConfig({ provider: 'openai', apiKey: 'startup-key' });
    instance.applyModelSettingsSnapshot(instance.prepareModelSettingsSnapshot(overridden));
    expect(makeGetApiKey(instance.getConfig())('openai')).toBe('startup-key');
    const draft = instance.createModelSettingsDraft();
    draft.patch = { apiKeys: { openai: 'new-shared-key' } };
    expect(instance.saveModelSettings(draft)).toMatchObject({ ok: true, persisted: true });
    expect(instance.getConfig().apiKeyOverride).toBeUndefined();
    expect(instance.getConfig().apiKeyOverrideTarget).toBeUndefined();
    expect(makeGetApiKey(instance.getConfig())('openai')).toBe('new-shared-key');
    expect(makeGetApiKey(instance.getConfig(), 'fast')('openai')).toBe('fast-secret');
    const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(saved.apiKeys.openai).toBe('new-shared-key');
    expect(JSON.stringify(saved)).not.toContain('startup-key');
  });

  it('真实 controller 写入失败时保留磁盘原字节和 live 对象', async () => {
    writeConfigFile({ ...DEFAULT_CONFIG, theme: 'cool' });
    const instance = controller();
    const previous = instance.getConfig();
    const revision = instance.getSettingsRevision();
    const bytes = readFileSync(getConfigPath());
    const draft = instance.createModelSettingsDraft();
    draft.patch = { theme: 'warm' };
    const store = await import('../config/store.js');
    const writer = vi.spyOn(store, 'writeConfigFile').mockImplementation(() => {
      throw new Error('注入磁盘写入失败');
    });
    const apply = vi.spyOn(instance, 'applyModelSettingsSnapshot');
    try {
      expect(instance.saveModelSettings(draft)).toMatchObject({
        ok: false, persisted: false, status: 'rejected', code: 'write_failed',
      });
      expect(writer).toHaveBeenCalledTimes(1);
      expect(apply).not.toHaveBeenCalled();
      expect(instance.getConfig()).toBe(previous);
      expect(instance.getSettingsRevision()).toBe(revision);
      expect(readFileSync(getConfigPath())).toEqual(bytes);
      expect(draft.patch.theme).toBe('warm');
    } finally {
      writer.mockRestore();
      apply.mockRestore();
    }
  });

  it('日志 effects 失败标记已保存待重启，但不阻断已应用完整模型的 core', () => {
    const instance = controller();
    const draft = instance.createModelSettingsDraft();
    draft.profiles = config().modelProfiles;
    draft.activateRoles = ['main', 'fast'];
    const effects = vi.spyOn(instance, 'applyModelSettingsEffects').mockImplementation(() => {
      throw new Error('注入日志重配置失败');
    });
    try {
      expect(instance.saveModelSettings(draft)).toMatchObject({
        ok: false, persisted: true, status: 'saved_apply_failed',
        code: 'apply_failed', restartRequired: true,
      });
      expect(effects).toHaveBeenCalledTimes(1);
      expect(instance.areModelSettingsBlocked()).toBe(false);
      expect(instance.preflight().ok).toBe(true);
      expect(instance.getConfig().model).toBe('same-model');
      expect(makeGetApiKey(instance.getConfig())('openai')).toBe('main-secret');
      const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
      expect(saved.modelProfiles.mainId).toBe('a');
      expect(saved.modelProfiles.fastId).toBe('b');
    } finally {
      effects.mockRestore();
    }
  });

  it('手工配置字段包含空白时，仅重命名仍使磁盘和 live 配置库一致归一化', () => {
    const profiles = config().modelProfiles!;
    profiles.entries[0]!.model = '  same-model  ';
    profiles.entries[0]!.baseUrl = '  https://main.example/v1  ';
    profiles.entries[0]!.apiKey = '  main-secret  ';
    profiles.entries[1]!.name = '   ';
    profiles.entries[1]!.baseUrl = '   ';
    writeConfigFile({ ...DEFAULT_CONFIG, modelProfiles: profiles });
    const instance = controller();
    const draft = instance.createModelSettingsDraft();
    draft.profiles!.entries[0]!.name = '  新名称  ';
    expect(instance.saveModelSettings(draft)).toMatchObject({ ok: true, persisted: true });
    const saved = JSON.parse(readFileSync(getConfigPath(), 'utf8'));
    expect(saved.modelProfiles.entries[0]).toMatchObject({ name: '新名称', model: 'same-model',
      baseUrl: 'https://main.example/v1', apiKey: 'main-secret' });
    expect(saved.modelProfiles.entries[1]).toMatchObject({ name: 'same-model', baseUrl: null });
    expect(instance.getConfig().modelProfiles).toEqual(saved.modelProfiles);
    expect(makeGetApiKey(instance.getConfig())('openai')).toBe('main-secret');
  });
});
