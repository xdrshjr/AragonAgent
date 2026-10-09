import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentController } from '../agent/controller.js';
import { DEFAULT_CONFIG, DEFAULT_SKILLS_RUNTIME, type CliConfig } from '../config/schema.js';

const controllers: AgentController[] = [];

function setup(key = 'first') {
  const config = {
    ...DEFAULT_CONFIG, cwd: process.cwd(), color: true, unicode: true, submitCount: 0,
    startInPlanMode: false, skillsRuntime: DEFAULT_SKILLS_RUNTIME,
    provider: 'openai', model: 'custom', baseUrl: 'https://gateway.test/v1',
    skills: { ...DEFAULT_CONFIG.skills, enabled: false },
    compaction: { ...DEFAULT_CONFIG.compaction, enabled: false },
    team: { ...DEFAULT_CONFIG.team, enabled: false },
    fast: { ...DEFAULT_CONFIG.fast, enabled: false },
    apiKeys: { openai: key },
  } as CliConfig;
  const controller = new AgentController(config);
  controllers.push(controller);
  return controller;
}

function metadata(window: number) {
  return new Response(JSON.stringify({ data: [{ id: 'custom', context_length: window }] }));
}

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model metadata request lifetime', () => {
  it.each(['openai', 'anthropic', 'google'])('aborts the actual %s metadata fetch during disposal', async (provider) => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init.signal!;
      requestSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const controller = setup();
    controller.setModel(provider, 'custom', 'https://gateway.test/v1');
    controller.setApiKey(provider, 'test');
    const pending = controller.refreshModelMetadata();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    controller.dispose();
    expect(requestSignal?.aborted).toBe(true);
    await pending;
    expect(controller.getModelRegistry().getContextWindow(provider, 'custom', 'https://gateway.test/v1')
      .contextWindowSource).toBe('fallback');
  });

  it('reuses the same cancellation scope for repeated refreshes and aborts it on disposal', async () => {
    const controller = setup();
    const discover = vi.spyOn(controller.getModelRegistry(), 'discoverModels').mockResolvedValue([]);
    await controller.refreshModelMetadata();
    await controller.refreshModelMetadata();
    const first = discover.mock.calls[0]![3]!;
    expect(first).toBeInstanceOf(AbortSignal);
    expect(discover.mock.calls[1]![3]).toBe(first);
    expect(first.aborted).toBe(false);
    controller.dispose();
    expect(first.aborted).toBe(true);
    await controller.refreshModelMetadata();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('cancels the old endpoint lookup and gives the new endpoint a live signal', async () => {
    const controller = setup();
    const discover = vi.spyOn(controller.getModelRegistry(), 'discoverModels').mockResolvedValue([]);
    await controller.refreshModelMetadata();
    const first = discover.mock.calls[0]![3]!;
    controller.setModel('openai', 'custom', 'https://new.test/v1');
    expect(first.aborted).toBe(true);
    expect(discover.mock.calls[1]![2]).toBe('https://new.test/v1');
    expect(discover.mock.calls[1]![3]!.aborted).toBe(false);
  });

  it('cancels existing metadata and prevents another lookup when settings are blocked', async () => {
    const controller = setup();
    const discover = vi.spyOn(controller.getModelRegistry(), 'discoverModels').mockResolvedValue([]);
    await controller.refreshModelMetadata();
    const first = discover.mock.calls[0]![3]!;
    controller.blockModelSettingsRequests();
    expect(first.aborted).toBe(true);
    await controller.refreshModelMetadata();
    expect(discover).toHaveBeenCalledTimes(1);
  });
});

describe('model metadata credential lifecycle', () => {
  it('invalidates the visible limit and discovers again when setApiKey rotates credentials', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockResolvedValueOnce(metadata(1000000))
      .mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const controller = setup();
    await controller.refreshModelMetadata();
    expect(controller.getContextUsage().window).toBe(1000000);

    controller.setApiKey('openai', 'second');
    expect(controller.getContextUsage().windowKnown).toBe(false);
    finish(metadata(64000));
    await vi.waitFor(() => expect(controller.getContextUsage().window).toBe(64000));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![1].headers.Authorization).toBe('Bearer second');
  });

  it('starts discovery immediately after a previously missing key is supplied', async () => {
    const fetch = vi.fn().mockResolvedValue(metadata(64000));
    vi.stubGlobal('fetch', fetch);
    const controller = setup('');
    await controller.refreshModelMetadata();
    expect(fetch).not.toHaveBeenCalled();

    controller.setApiKey('openai', 'second');
    await vi.waitFor(() => expect(controller.getContextUsage().window).toBe(64000));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not restore old metadata when a removed key has an outstanding lookup', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const controller = setup();
    const pending = controller.refreshModelMetadata();

    controller.setApiKey('openai', '');
    finish(metadata(1000000));
    await pending;
    expect(controller.getContextUsage().windowKnown).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
