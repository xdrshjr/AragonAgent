# Changelog

All notable changes to `@argon-agent/core` are documented here.

## Unreleased

### Added

- **Skill system (pure-logic half).** New `src/skills/` module and a `./skills`
  subpath export: `SkillRegistry`, `parseFrontmatter`,
  `validateSkillFrontmatter`, `validateStagedSkill`, `renderSkillCatalog`,
  `renderSkillBody`, `renderSkillInvocation`, `applySkillArguments`,
  `suggestSkillNames`, `sanitizeForPromptBlock`, `createSkillTool`, and the
  `SKILL_*` budget constants. The root runtime surface grows from 33 to 56
  value exports; see `API.md`.
- **`rankCatalogRecords(records, { usage, now })`** — orders the Level 1 catalog
  by scope, then by usage recency and frequency, using integer buckets so the
  result stays byte-reproducible. Invariant: called without a usage map it is
  element-for-element identical to `catalogRecords()`, which is what keeps every
  existing catalog snapshot valid.
- **`createSkillFindTool(deps)` / `renderSkillFindResults(query, matched, opts)`**
  — the `skill_find` tool and its rendering, for reaching skills that did not fit
  in the catalog. Searches only the injected registry: no network, no
  `activation: manual` skills, and an explicit refusal to invent an install
  source when nothing matches. Same sanitisation and byte budget discipline as
  the catalog (`SKILL_FIND_MAX_BYTES`).
- Types `SkillIntegrity`, `SkillUsageStat`, `SkillUsageMap`, `SkillFindOptions`;
  `SkillRecord.integrity`; optional `SkillManifestSource.resolvedRef` and
  `SkillManifest.updatedAt` / `previousVersion` (additive — the manifest schema
  version is deliberately unchanged so an older CLI still reads them).
- All filesystem access goes through the injected `SkillHost` port, so the
  package still imports no `node:*` builtin outside the one grandfathered
  `node:crypto` in `llm/providers/google.ts`.

### Changed

- `no-host-coupling.test.ts` now also asserts that **no** file under `src/`
  imports a `node:*` builtin, with a single documented allowlist entry and a
  self-check so the assertion cannot pass vacuously. This guarantee was
  previously assumed but never actually checked.
- Added a repository-level PowerShell release workflow that versions, verifies,
  and publishes Core before the dependent CLI, with dry-run rollback and
  partial-release resume support.

### Security

- Every span of third-party text is passed through `sanitizeForPromptBlock()`
  before it is concatenated into a tagged prompt block. Without it a skill
  description containing `</available_skills>` could close the block and have
  the text after it read as top-level system-prompt instructions.
- All skill budgets are measured in UTF-8 **bytes**. A character-based budget
  is ~3x under-counted for CJK text, which pushed results past `ToolExecutor`'s
  100 000-byte ceiling and truncated the closing tag off the block.

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
