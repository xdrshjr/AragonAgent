# Changelog

All notable changes to `@argon-agent/core` are documented here.

## 0.1.0

Initial extraction of the ArgonAgent engine from the AragonMesh code base
(`server/agent-core/`) into a standalone, publishable package.

- Zero-coupling agent engine: LLM provider adapters (Anthropic, OpenAI,
  Google), streaming, provider registry, model registry.
- Tool system: typed tool definitions, registry, JSON-Schema validator (with
  built-in fallback), executor.
- Engine: multi-turn agent loop, message manager, steering queue, idle
  watchdog.
- Optional isolated-vm CodeAct sandbox (lazy-loaded).
- Adds the `ArgonAgent` export as an alias of the `Agent` class.

Publish-readiness (still part of the unreleased `0.1.0`):

- Added `publishConfig.access:"public"` (required for scoped public publish),
  a `prepublishOnly` build guard, and a package-directory `LICENSE`.
- `files` now ships `CHANGELOG.md` alongside `dist`.
- Added `typesVersions` so consumers on the legacy `moduleResolution:"node"`
  can resolve the subpath type declarations.
- Declared `sideEffects:false` (the barrel is pure re-exports) to aid
  downstream tree-shaking.
- Added discovery metadata: `keywords` / `author` / `repository` / `homepage`
  / `bugs`.
- Added a compile-checked `examples/minimal.ts` usage sample (not shipped in the
  tarball).

Reuse-verification harness (still part of the unreleased `0.1.0`):

- Added `examples/consumer-smoke/run.mjs` + the `verify:dist` script: runs the
  built `dist/` like an external consumer (Node package self-referencing →
  `exports` map → `dist/`), driving `ArgonAgent` end-to-end with an offline stub
  provider and asserting every `exports` subpath resolves at runtime.
- Added a public-API contract snapshot (`src/__tests__/public-api.test.ts` +
  `API.md`) that freezes the runtime export surface against silent drift.
- Added a `no-host-coupling` guard test that forbids host-repo imports
  (`@server/`, `@shared/`, `@/`, out-of-package `../../../`) and legacy-brand
  leakage on the public surface.
- Added a publish guard: `scripts/check-publishable.mjs` (wired into
  `prepublishOnly`) hard-blocks publishing while the `<ORG>` placeholder remains
  in `package.json`, and `scripts/stamp-org.mjs` replaces it in one command.
