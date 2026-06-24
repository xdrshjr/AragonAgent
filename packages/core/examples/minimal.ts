/**
 * @argon-agent/core — minimal, type-checked usage example.
 *
 * This file is NOT shipped in the published tarball (it lives outside the
 * `files` whitelist) and it never touches the network. Its sole purpose is to
 * be a compile-checked reference for third-party consumers: it imports the
 * package exactly the way a downstream project would — by the published package
 * name `@argon-agent/core` (not a relative `src/` path) — so a clean
 * `tsc --noEmit` proves the public API surface, the `exports` map, and the
 * `typesVersions` map all resolve correctly.
 *
 * Run the check from the package directory, AFTER `npm run build` (the import
 * resolves to `dist/*.d.ts`):
 *
 *   npm run build
 *   npx tsc -p tsconfig.examples.json --noEmit
 */

import {
  ArgonAgent,
  defineTool,
  textResult,
  getProviderRegistry,
  initProviders,
  type AgentConfig,
  type AgentTool,
  type ModelRef,
} from '@argon-agent/core';

// 1. Define a dummy tool with the `defineTool` helper. Tools handed to the
//    agent use the default `Record<string, unknown>` param shape (so they are
//    assignable to `AgentConfig.tools`); validate/narrow the params inside
//    `execute`. The body returns a `ToolResult` via `textResult`.
const greetTool: AgentTool = defineTool({
  name: 'greet',
  label: 'Greeter',
  description: 'Greets the user by name.',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
  },
  async execute(_toolCallId, params) {
    const name = typeof params.name === 'string' ? params.name : 'world';
    return textResult(`Hello, ${name}!`);
  },
});

// 2. Register the built-in LLM providers (Anthropic / OpenAI / Google) into the
//    default registry. This is an in-memory, no-network call.
initProviders();

// 3. Describe which model to talk to.
const model: ModelRef = {
  providerId: 'anthropic',
  modelId: 'claude-sonnet-4-6',
};

// 4. Supply the API key however your app stores it. Returning `undefined` for
//    an unknown provider is valid; the engine surfaces a clear error at run
//    time. (Kept as a closure so this example needs no Node globals.)
const apiKeys: Record<string, string | undefined> = {
  anthropic: undefined, // e.g. read from your secrets manager / env at runtime
};

// 5. Assemble the agent configuration and construct the agent.
const config: AgentConfig = {
  systemPrompt: 'You are a helpful coding agent.',
  model,
  tools: [greetTool],
  providerRegistry: getProviderRegistry(),
  getApiKey: (providerId) => apiKeys[providerId],
};

const agent = new ArgonAgent(config);

// 6. Subscribe to lifecycle events. The full transcript is available on the
//    terminal `agent_end` event.
const unsubscribe = agent.subscribe((event) => {
  if (event.type === 'agent_end') {
    void event.messages;
  }
});

// NOTE: `agent.prompt(...)` is intentionally NOT executed at import time — this
// example is compile-only and must never make a network request. The wrapper
// below shows the call shape without running it.
export async function run(): Promise<void> {
  await agent.prompt('Greet the world.');
  unsubscribe();
}
