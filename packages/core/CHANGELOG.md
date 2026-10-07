# Changelog

All notable changes to `@aragon-agent/core` are documented here. Entries at
`0.1.x` and earlier refer to the package by its former name, `@argon-agent/core`
— those releases really were published under that name, so they are left as they
were written.

## Unreleased

### Added

- **Steering 精确接收回执。** `Agent.steer(text, id?)` 兼容原单参数调用，
  历史接收后发出 `steering_accepted`，只确认当前批次的 ID；新增类型
  `SteeringMessage` 和 `SteeringAcceptedEvent`，无新增运行时导出。
  `drainSteeringItems()` 与原 `drainSteering()` 共用一个队列。
  接收早于异步压缩，未执行工具先补齐 skipped 结果；无工具响应在结束前再次检查
  steering，避免流式输出期间提交的消息滞留。回执仅代表历史接收，不代表回答完成。

- **Tail relief — the last rung of the compaction ladder.** `relieveTail` joins
  the root barrel with `TailReliefOptions` and `TailReliefResult` (85 → 86
  runtime exports), and `compaction_end` gains an optional `tailRelief` field.

  Every existing rung operates on the HEAD of a history. When the RETAINED tail
  is what does not fit — a few turns carrying several 100 KB tool results — each
  of them reports success or "nothing to drop" while the conversation stays
  un-sendable. `relieveTail` clips oversized `tool_result` bodies in place,
  oldest first, and stops as soon as the projection is under budget.

  It is **structure-preserving by construction**: no message is removed, no
  `toolCallId` is touched, no role changes, so a history that passed
  `validateHistory` before still passes after. That is what makes it safe to run
  on an already-spliced history, and it is why relief clips rather than drops.
  Every clip is announced in the text the model reads, at the exact place the
  data was removed, through a `marker` callback the host supplies — this package
  owns no glyphs.

  `compaction_end.tailRelief` is optional, so a subscriber that does not know
  about it is unaffected.

- **Context compaction — one injected port, and the engine refuses a bad
  splice.** `AgentConfig.contextManager?: ContextManager` is called at every turn
  boundary (after the steering drain, before `turn_start`). When it says so, the
  engine hands it a **copy** of the history, adopts whatever comes back — and
  validates it first.

  `findSafeCutIndices`, `planCompaction` and `validateHistory` join the root
  barrel, along with `CHARS_PER_TOKEN`, which was module-private (81 → 85 runtime
  exports). Two new `AgentEvent` members, `compaction_start` and
  `compaction_end`, carry the story; a consumer with a `default` branch is
  unaffected.

  **The mechanism is here; the policy is the host's.** This package holds a
  `ModelRef` and never a `ModelInfo`, so the threshold, the summarizer, the
  prompt and the failure ladder are all decisions on the other side of the port.

  Four properties are load-bearing and each is asserted by a test:

  - **Off is free.** With no `contextManager` the checkpoint is one `if` against
    an absent field — no promise allocation, no events, no behaviour change.
  - **The engine validates and may refuse.** An orphan `tool_result`, an unclosed
    `tool_call`, an empty array or a history that grew is not adopted; the run
    continues on the original and `compaction_end` reports
    `invalid_history: <reason>`. An orphan `tool_result` is an unrecoverable 400
    on Anthropic, so a host bug must not be able to produce one.
  - **The call cannot hang the run.** `compaction_start` pauses the idle
    watchdog, so the engine races `compact()` against the run's signal **and** a
    120 s ceiling of its own, and emits `compaction_end` from a `finally` — which
    is what resumes the watchdog. A non-settling promise, an ignored signal or a
    malformed return value each degrade to "compaction did not happen".
  - **The host gets a copy.** `ctx.messages` is a shallow copy, so a host that
    splices it in place cannot corrupt engine state before the gate sees it.

  **`compaction` is now a legitimate word in the engine**, which makes RT-4's
  original claim ("no history-trimming API exists") false by design. That guard
  now asserts the narrower and more useful thing: history shrinks in exactly one
  place, and that place goes through `validateHistory`. The skill digest's
  `force=true` escape hatch — added for a *truncated* earlier copy — covers a
  *compacted-away* one unchanged, and is pinned by a test.

- **`llm/retry.ts` — retry with exponential backoff, ON BY DEFAULT.**
  `RETRY_LIMITS`, `DEFAULT_RETRY_POLICY`, `isRetryableError`,
  `computeBackoffDelay`, `parseRetryAfterMs` and `withRetry` are exported from the
  root barrel (75 → 81 runtime exports). `ProviderRegistry.stream()` wraps every
  provider stream, so the agent loop, every subagent and `ProviderRegistry`
  itself inherit retry with no call-site changes.

  A transient failure — 429, 529, 5xx, DNS/TLS/ECONNRESET, 408 — is now retried
  up to **10 times** with an increasing, equal-jittered interval
  (1 s → 2 → 4 → 8 → 16 → 30 s, capped at 30 s per wait) under a **240 s**
  wall-clock budget measured from the first failure. `auth_error`,
  `invalid_request`, `context_overflow` and `unknown` are never retried: ten
  retries of a bad API key is three minutes of looking broken.

  A user abort is never retried, and this is the load-bearing detail:
  `wrapFetchError` marks an `AbortError` `retryable: true`, so
  `isRetryableError` reads `signal.aborted` **before** `err.retryable`. An
  aborted request yields no further event of any kind — in particular no `error`
  — so nothing fabricates a network failure out of Esc.

  `Retry-After` (and `x-ratelimit-reset-after` /
  `anthropic-ratelimit-requests-reset` / `anthropic-ratelimit-input-tokens-reset`)
  is honoured as a **floor**, never a replacement, and a value above 60 s is
  surfaced immediately rather than waited out.

- **Three new `StreamEvent` variants** — `RetryScheduledEvent`,
  `RetryAttemptEvent`, `StreamRestartEvent`. Additive: `consumeStream` ignores
  anything that is not `done`/`error`, and a consumer with a `default` branch is
  unaffected. `retry_scheduled` carries `resumeAt` (an absolute instant) rather
  than a tick stream, so a UI owns its own clock.

- **`ProviderRegistry` holds a policy.** New `ProviderRegistryOptions`,
  `setRetryPolicy(policy | null)` and `getRetryPolicy()`;
  `initProviders(options?)` forwards them. `undefined` means the product default,
  an explicit `null` means opt out.

- **`LLMError` gains a 7th optional field `retryAfterMs`**, and
  `classifyHttpError` an optional 4th parameter `headers?: Headers`. Both
  additive; every existing call site compiles unchanged.

- **`Agent` pauses its idle watchdog across a backoff.** A 30 s wait would
  otherwise be read as a wedged call and abort the run at `idleTimeout`.

- **`llm/output-limits.ts` — one authority for the output-token cap.**
  `DEFAULT_MAX_OUTPUT_TOKENS` (64000), `MIN_MAX_OUTPUT_TOKENS`,
  `SAFE_FALLBACK_MAX_OUTPUT_TOKENS`, `ABSOLUTE_MAX_OUTPUT_TOKENS`,
  `THINKING_HEADROOM_TOKENS`, `CONTEXT_SAFETY_MARGIN_TOKENS`,
  `resolveOutputTokens`, `staticCeilingFor`, `learnModelCeiling`,
  `getLearnedCeiling`, `clearLearnedCeilings` and `estimatePromptTokens` are all
  exported from the root barrel. The three provider adapters no longer carry
  private copies of the default; they resolve through this module.

  The resolver treats the default as an *ambition* and the model's real ceiling
  as the law, ranking four sources — learned-from-error > discovery > a static
  per-model table > the product default — so an over-large cap is clamped instead
  of becoming an HTTP 400 that ends the run. It also reconciles Anthropic's
  `max_tokens > thinking.budget_tokens` invariant, which `--thinking xhigh` broke
  on every request.

- **`llm/output-limit-recovery.ts` — one-shot self-healing.**
  `classifyOutputLimitFailure`, `sendWithOutputLimitRecovery`, `learnTokenField`,
  `getLearnedTokenField` and `clearLearnedTokenFields`. A 400 that names an
  output-limit problem is repaired and re-sent **once** — never a loop — and what
  was learned is remembered for the rest of the process. A 2xx is returned with
  its body untouched, so streaming is unaffected. OpenAI's reasoning family,
  which rejects `max_tokens` in favour of `max_completion_tokens`, is handled by
  a heuristic plus this memo.

- **`LLMRequest.modelLimits?: { maxOutputTokens?, contextWindow? }`** — optional
  caller-supplied metadata. Supplying `contextWindow` enables the
  `max_tokens + prompt <= context` guard on OpenAI. Every existing caller
  compiles unchanged.

### Changed

- **BEHAVIOUR CHANGE — retry is on by default for embedders.** A failing call
  that used to end immediately can now take up to ~3 minutes to fail. The budget
  bounds it; `initProviders({ retryPolicy: null })` or `setRetryPolicy(null)`
  restores the old behaviour exactly, and `maxRetries: 0` short-circuits the
  wrapper so the opted-out path is byte-identical.

- **BEHAVIOUR CHANGE — a truncated stream is now a loud error instead of a
  silent success.** All three adapters used to end their SSE loop by
  *unconditionally* yielding `done` with whatever had accumulated. A stream
  closed gracefully mid-answer — a proxy idle cut, a load-balancer timeout, an
  HTTP/2 GOAWAY, `[DONE]` never arriving — therefore surfaced as **success
  carrying a truncated answer**, which no layer above the adapter could tell from
  a real one. Each adapter now tracks its own terminal sentinel
  (`message_stop` / `[DONE]` **or** a `finish_reason` / a chunk carrying
  `finishReason`) and yields a retryable `network_error` when the stream ends
  without it. Consequences:

  - the mid-answer disconnection case is now retried and recovered;
  - `ProviderRegistry.complete()` / `provider.complete()` change from returning a
    partial `AssistantMessage` to **throwing** for a truncated stream;
  - an **abort** is explicitly excluded and still yields `done`, and an empty but
    complete turn is still a success.

  This is deliberately **not** behind the retry switch: an adapter that reports a
  truncated stream honestly should do so whether or not retry is enabled.

- **HTTP 408 is now `errorType: 'timeout'`, `retryable: true`** (it used to fall
  into `unknown` / non-retryable).

- **`ProviderRegistry.complete()` now routes through `this.stream()`** instead of
  `provider.complete()`. Behaviour-preserving — all three adapters implement
  `complete` as exactly `consumeStream(this.stream(request))` — except that the
  registry's version is now the retrying one.

- `ModelRegistry.buildRuntimeModel` defaults `maxOutputTokens` to
  `DEFAULT_MAX_OUTPUT_TOKENS` rather than a private `16384`, the built-in
  Anthropic catalog entries carry their real ceilings, and `registerDefaults` /
  `discoverModels` seed the shared ceiling cache. `listModels` on the Anthropic
  and OpenAI adapters now maps through the static table instead of asserting the
  product default for every model — neither API reports an output ceiling, and
  claiming otherwise outranked the correct value for every small model.

### Notes

- **`streamLLM` / `completeLLM` diverge from a registry you build yourself.**
  They resolve through `getProviderRegistry()`, which lazily calls
  `initProviders()` with no arguments, so they always carry
  `DEFAULT_RETRY_POLICY` and do not observe a policy installed elsewhere. For one
  policy everywhere, call `setProviderRegistry(initProviders({ retryPolicy }))`
  once at startup.

- **A half-open connection is still not covered** (no FIN, no RST). It produces
  no event, so `withRetry` never wakes and the idle watchdog aborts the run. A
  per-attempt stall timer is not safe at this layer: Anthropic's `ping` frames
  are swallowed by the adapter, so a long extended-thinking pause and a dead
  socket look identical at the `StreamEvent` layer.

## 0.3.0

### Added

- **`Agent.pauseIdleWatchdog()` / `Agent.resumeIdleWatchdog()`** — suspend and
  restart the idle watchdog around a tool that blocks on a human. Both are
  idempotent, and a paused watchdog also swallows `kick()`, so an event arriving
  mid-wait cannot silently re-arm it. Always pair them in a `try/finally`: a
  throw inside the wait must not leave the watchdog disarmed for the rest of the
  run. The host is the only party that can know a person is being waited on —
  from inside the loop that call is indistinguishable from a wedged network
  request.

- **`AgentConfig.timeouts.toolTimeoutOverrides?: Record<string, number>`** —
  per-tool ceilings keyed by tool name, forwarded to `ToolExecutor`'s existing
  `timeoutOverrides`. This is pure wiring of a capability the executor already
  had and that was unreachable through `Agent`.

  Read this before relying on it: `ToolExecutor` expresses a timeout by aborting
  `context.signal` and then *continuing to await* the tool's promise — there is
  no `Promise.race`. A tool that never observes `context.signal` is therefore
  never timed out, and the number set here is inert for it, with no error
  anywhere. See *Blocking on a human* in `API.md`.

### Fixed

- `IdleWatchdog.stop()` now clears the paused flag. Without it a run aborted
  while paused would leave the watchdog deaf for every subsequent run, because
  `start()` goes through `kick()` and `kick()` returns early while paused.

### Notes

- **No change to the export surface.** The two new members are instance methods
  and the third is a config field, so `src/index.ts` and the `EXPECTED` list in
  `public-api.test.ts` are untouched.

## 0.2.0

### Breaking

- **The package is renamed `@argon-agent/core` → `@aragon-agent/core`.** The
  brand was always meant to be *Aragon*, matching AragonMesh; the missing `a`
  was a typo that reached the registry. `@argon-agent/core` is deprecated and
  receives no further releases.

  Every subpath keeps its shape — only the scope changes:

  ```diff
  - import { Agent } from '@argon-agent/core';
  + import { Agent } from '@aragon-agent/core';
  - import type { LlmMessage } from '@argon-agent/core/llm/types';
  + import type { LlmMessage } from '@aragon-agent/core/llm/types';
  ```

- **The exported alias `ArgonAgent` is now `AragonAgent`.** It remains an alias
  of `Agent`, which is unchanged — code importing `Agent` needs no edit.

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
- **Release tooling for the scope change.** `npm run verify:brand` derives the
  list of files that would enter the tarball from `npm pack --dry-run --json`
  and refuses the release if any of them still mentions the old brand — README
  included, with only the four documented exceptions. It runs inside
  `publish-latest.ps1` and cannot be skipped. `npm run preflight` answers "would
  a real publish succeed?" before any version file is touched, and
  `npm run verify:published` checks afterwards that the registry really serves
  the renamed package, README and repository link included.

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
