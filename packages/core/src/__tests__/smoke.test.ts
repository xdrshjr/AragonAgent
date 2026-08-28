/**
 * Smoke test for the extracted @aragon-agent/core package (AC7).
 *
 * Verifies that:
 *  - the `AragonAgent` alias is exported and is the same class as `Agent`;
 *  - the key barrel symbols are present (guards against shim/barrel drift);
 *  - an AragonAgent can be constructed with a dummy tool and exposes it via state.
 */

import { describe, it, expect } from 'vitest';
import {
  Agent,
  AragonAgent,
  getProviderRegistry,
  initProviders,
  streamLLM,
  completeLLM,
  ProviderRegistry,
  ToolRegistry,
  ToolExecutor,
  MessageManager,
  defineTool,
  textResult,
  errorResult,
  THINKING_BUDGET,
} from '../index.js';

describe('@aragon-agent/core smoke', () => {
  it('exports AragonAgent as an alias of Agent', () => {
    expect(typeof AragonAgent).toBe('function');
    expect(AragonAgent).toBe(Agent);
  });

  it('exposes the expected barrel symbols', () => {
    for (const sym of [
      getProviderRegistry,
      initProviders,
      streamLLM,
      completeLLM,
      ProviderRegistry,
      ToolRegistry,
      ToolExecutor,
      MessageManager,
      defineTool,
      textResult,
      errorResult,
    ]) {
      expect(sym).toBeDefined();
    }
    expect(THINKING_BUDGET).toBeDefined();
  });

  it('constructs an AragonAgent with a dummy tool', () => {
    initProviders();

    // THE GENERIC IS EXPLICIT, and it has to be: annotating `execute`'s `params`
    // made `defineTool` infer `AgentTool<{ text: string }>`, which is not
    // assignable to `AgentConfig.tools`'s `AgentTool<Record<string, unknown>>[]`
    // — a tool that accepts fewer payloads than the registry may hand it. The
    // fixture is what was wrong; `AgentConfig` is not (W3 / D-15).
    const dummyTool = defineTool<Record<string, unknown>>({
      name: 'echo',
      label: 'Echo',
      description: 'Echoes its input back.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async execute(_id, params) {
        return textResult(String(params.text ?? ''));
      },
    });

    const agent = new AragonAgent({
      systemPrompt: 'You are a test agent.',
      model: { providerId: 'anthropic', modelId: 'test-model' },
      tools: [dummyTool],
      providerRegistry: getProviderRegistry(),
      getApiKey: () => 'test-key',
    });

    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.tools.map((t) => t.name)).toContain('echo');
    expect(agent.state.systemPrompt).toBe('You are a test agent.');
  });

  it('errorResult marks results as errors', () => {
    const result = errorResult('boom');
    expect(result.isError).toBe(true);
  });
});
