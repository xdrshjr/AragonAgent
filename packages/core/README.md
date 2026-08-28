# @aragon-agent/core

The publishable **AragonAgent** engine: a zero-coupling, dependency-injected
TypeScript agent runtime.

## Requirements

- **Node.js ≥ 18** — the engine relies on the global `fetch` / `AbortController`
  built into Node 18+.
- **ESM-only** — this package ships as native ES modules (`"type": "module"`).
  Consume it with `import`; it cannot be `require()`-d from CommonJS.
- **Optional native deps** — `ajv` and `isolated-vm` are `optionalDependencies`:
  the package works without them (a built-in validator fallback is used, and the
  sandbox modules are lazy-loaded). Install `isolated-vm` only if you use the
  `@aragon-agent/core/sandbox/*` CodeAct sandbox.

## Install

```bash
npm install @aragon-agent/core
# optional — only if you use the isolated-vm CodeAct sandbox:
npm install isolated-vm
```

`ajv` and `isolated-vm` are **optional dependencies**:

- `ajv` — used by the tool param validator when present; a built-in fallback
  validator is used otherwise.
- `isolated-vm` — used only by the `@aragon-agent/core/sandbox/*` modules, which
  are lazy-loaded and never imported from the package root (`isolated-vm` is
  incompatible with some embedded V8 runtimes such as Electron's).

## Usage

```ts
import { AragonAgent, getProviderRegistry, initProviders } from '@aragon-agent/core';

initProviders();

const agent = new AragonAgent({
  systemPrompt: 'You are a coding agent.',
  model: { providerId: 'anthropic', modelId: 'claude-...', baseUrl: '...' },
  tools: [],
  providerRegistry: getProviderRegistry(),
  getApiKey: () => process.env.ANTHROPIC_API_KEY,
});

await agent.prompt('Hello');
```

`AragonAgent` is an alias of the engine's `Agent` class.

A complete, type-checked version of this snippet (a dummy tool + provider setup
+ agent construction) lives in [`examples/minimal.ts`](./examples/minimal.ts).
It is compile-only (never hits the network) and is not part of the published
tarball.

## Entry points

| Import path                      | Contents                                  |
| -------------------------------- | ----------------------------------------- |
| `@aragon-agent/core`              | Full barrel (engine, LLM, tools, types).  |
| `@aragon-agent/core/llm/types`    | LLM message / streaming / model types.    |
| `@aragon-agent/core/llm/providers`| Provider registry + `streamLLM`/`completeLLM`. |
| `@aragon-agent/core/tools/types`  | Tool system types.                        |
| `@aragon-agent/core/tools/helpers`| `textResult` / `errorResult` / `defineTool`. |
| `@aragon-agent/core/sandbox/*`    | Optional isolated-vm CodeAct sandbox.     |

## Build

```bash
npm run build   # tsc → dist/*.js + *.d.ts
npm test        # vitest (smoke + public-api contract + no-host-coupling guard)
```

## Verifying reuse

`npm test` and `examples/minimal.ts` only prove the package **compiles**. To
prove the built `dist/` can actually be **run** by an external consumer:

```bash
npm run verify:dist   # build dist/, then run examples/consumer-smoke/run.mjs
```

`run.mjs` imports this package **by its own name** (`@aragon-agent/core`) via
Node's *package self-referencing*, so Node resolves it through
`package.json#exports` → `./dist/index.js` — the same `(exports map + NodeNext +
.js extension)` path that an external project's `npm install @aragon-agent/core`
hits, **without** placing the package in `node_modules`. It injects an offline
stub LLM provider, runs one `AragonAgent.prompt()` turn end-to-end (zero network),
and asserts the `exports` subpaths all resolve at runtime. Success prints
`[consumer-smoke] OK`.

For the unambiguous "another project installs and reuses it" check (which also
covers running **without** the optional `ajv` / `isolated-vm` deps), see the
pack-into-a-fresh-project golden verification in
[`examples/consumer-smoke/README.md`](./examples/consumer-smoke/README.md).

The runtime public-API surface is frozen by `src/__tests__/public-api.test.ts`
and documented for humans in [`API.md`](./API.md); a `no-host-coupling` test
keeps the package free of host-repo imports and legacy brand leakage.

## Publishing

This package is published to the public npm registry. Run the release from the
**package directory** so the package-level `prepublishOnly` hook fires and a
fresh `dist/` is built:

```bash
cd packages/core
npm run build                 # produce dist/
npm pack --dry-run --json     # inspect the tarball file list (no upload)
npm publish                   # publishConfig.access:"public" is baked in
```

(From the repo root you can equivalently run `npm publish -w packages/core`.)

Notes:

- **`publishConfig.access` is set to `"public"`**, so no `--access public` flag
  is needed — scoped packages would otherwise default to restricted/private.
- **The publishing account must own the `@aragon-agent` npm scope/org** before
  the first publish. Even with `access:"public"`, publishing under a scope you
  do not own fails with 403/404. Create the `@aragon-agent` org on npmjs (or
  switch to a scope your account owns and rename the package accordingly).
- **`files` is the load-bearing whitelist.** The repo's `.gitignore` ignores
  `dist/`, but npm's `files: ["dist", "CHANGELOG.md"]` takes precedence and
  ships the built output. Do not "simplify" the `files` field away, or the
  published tarball will be empty. `npm pack --dry-run --json` should always
  list `dist/index.js`.
- Repository metadata points to
  `https://github.com/xdrshjr/AragonAgent`.

  If the repository moves, use the helper script or update
  `repository` / `homepage` / `bugs` before publishing:

  ```bash
  node scripts/stamp-org.mjs <org>     # or: ARAGON_REPO_ORG=<org> node scripts/stamp-org.mjs
  node scripts/check-publishable.mjs   # exits non-zero if the placeholder remains in package.json
  ```

  `prepublishOnly` runs `check-publishable.mjs` before the build, so any publish
  attempt with an unstamped placeholder is hard-blocked automatically.

## License

MIT.
