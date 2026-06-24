/**
 * Smoke test for the extracted @argon-agent/core package (AC7).
 *
 * Verifies that:
 *  - the `ArgonAgent` alias is exported and is the same class as `Agent`;
 *  - the key barrel symbols are present (guards against shim/barrel drift);
 *  - an ArgonAgent can be constructed with a dummy tool and exposes it via state.
 */

import { describe, it, expect } from 'vitest';
import {
  Agent,
  ArgonAgent,
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

describe('@argon-agent/core smoke', () => {
  it('exports ArgonAgent as an alias of Agent', () => {
    expect(typeof ArgonAgent).toBe('function');
    expect(ArgonAgent).toBe(Agent);
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

  it('constructs an ArgonAgent with a dummy tool', () => {
    initProviders();

    const dummyTool = defineTool({
      name: 'echo',
      label: 'Echo',
      description: 'Echoes its input back.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      async execute(_id, params: { text: string }) {
        return textResult(params.text);
      },
    });

    const agent = new ArgonAgent({
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
