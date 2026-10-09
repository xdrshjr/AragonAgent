import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@aragon-agent/core';
import { Compactor } from '../compaction/compactor.js';
import { CompactionWiring, type CompactionWiringDeps } from '../compaction/wiring.js';
import { DEFAULT_COMPACTION_CONFIG, DEFAULT_FAST_CONFIG, type CliConfig } from '../config/schema.js';

function deps(source: ModelInfo['contextWindowSource'], priced: boolean): CompactionWiringDeps {
  const model: ModelInfo = {
    id: 'custom', name: 'Custom', provider: 'openai',
    contextWindow: 64_000, maxOutputTokens: 8_192,
    supportsThinking: false, supportsTools: true, supportsImages: false,
    cost: { input: 0, output: 0 },
    ...(source ? { contextWindowSource: source } : {}),
  };
  const config = {
    provider: 'openai', model: 'custom', contextWindow: null,
    fast: { ...DEFAULT_FAST_CONFIG }, compaction: { ...DEFAULT_COMPACTION_CONFIG },
  } as CliConfig;
  return {
    getConfig: () => config,
    hasKey: () => false,
    getApiKey: () => undefined,
    getModelInfoFor: () => model,
    isPricedModel: () => priced,
    getMessages: () => [{ role: 'user', content: 'hello', timestamp: 0 }],
    getSystemPrompt: () => '',
    notify: () => {},
  };
}

describe.each([
  ['API metadata without pricing', 'api', false, true],
  ['fallback metadata despite pricing', 'fallback', true, false],
  ['catalog metadata without pricing', 'catalog', false, true],
  ['legacy priced metadata', undefined, true, true],
  ['legacy unpriced metadata', undefined, false, false],
] as const)('private meters: %s', (_label, source, priced, known) => {
  it('reports window knowledge in standalone compactor pressure', () => {
    const compactor = new Compactor({
      ...deps(source, priced),
      emit: () => {},
      complete: async () => { throw new Error('unexpected model call'); },
    });
    expect(compactor.measure({})).toMatchObject({
      contextWindow: 64_000, windowKnown: known,
    });
  });

  it('reports window knowledge in the wiring snapshot', () => {
    const wiring = new CompactionWiring(deps(source, priced));
    try {
      expect(wiring.snapshot().pressure).toMatchObject({
        contextWindow: 64_000, windowKnown: known,
      });
    } finally { wiring.dispose(); }
  });
});
