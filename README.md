# ArgonAgent

A zero-coupling TypeScript agent engine, extracted from AragonMesh's "JR Agent"
core so it can be reused across projects and published to the public registry.

ArgonAgent provides the full agentic LLM execution loop:

- **LLM provider adapters** — Anthropic, OpenAI, Google, with a pluggable
  provider registry and streaming (`streamLLM` / `completeLLM`).
- **Tool system** — typed tool definitions, a registry, a JSON-Schema validator
  (uses `ajv` when available, falls back to a built-in validator), and an
  executor with per-tool timeouts.
- **Engine** — multi-turn agent loop, message management, a steering/follow-up
  queue, and an idle watchdog.
- **Optional sandbox** — an `isolated-vm` based JavaScript CodeAct sandbox
  (lazy-loaded; `isolated-vm` is an optional dependency).

The engine is **dependency-injected**: you supply the provider registry, an
API-key resolver, the tool list, and the model reference. It holds no database,
no persistence, and no framework coupling.

## Layout

This repository is an npm-workspaces mono-repo:

```
argon-agent-core/
  package.json            # workspaces root (private)
  tsconfig.base.json      # shared compiler options (ES2022 / NodeNext / strict)
  packages/
    core/                 # @argon-agent/core — the publishable engine
```

## Quick start

```ts
import { ArgonAgent, getProviderRegistry, initProviders } from '@argon-agent/core';

initProviders();

const agent = new ArgonAgent({
  systemPrompt: 'You are a coding agent.',
  model: { providerId: 'anthropic', modelId: 'claude-...', baseUrl: '...' },
  tools: [],
  providerRegistry: getProviderRegistry(),
  getApiKey: () => process.env.ANTHROPIC_API_KEY,
});

await agent.prompt('Hello');
```

`ArgonAgent` is an alias of the engine's `Agent` class — both are exported.

## Build & test

```bash
npm install
npm run build        # builds every package (tsc → dist)
npm test             # runs each package's test suite
```

## Publishing

`@argon-agent/core` is published from its own package directory, not from the
workspace root. See [`packages/core/README.md`](./packages/core/README.md#publishing)
for the full release procedure (`cd packages/core && npm publish`, or
`npm publish -w packages/core` from the root).

## License

MIT — see [LICENSE](./LICENSE).
