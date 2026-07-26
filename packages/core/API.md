# `@argon-agent/core` — Public API contract

> Human-readable companion to the machine-checked snapshot in
> `src/__tests__/public-api.test.ts`. The test freezes the set of **runtime
> (value)** exports; this document additionally records the **type** exports for
> readers. **Three-sync discipline:** any change to the public surface must update
> `src/index.ts`, the `EXPECTED` list in `public-api.test.ts`, and this file (plus
> `CHANGELOG.md`).
>
> All symbols are re-exported from the package root (`@argon-agent/core`). The
> "Subpath" column also notes the dedicated `exports` entry where one exists.

## Runtime (value) exports — 56

| Symbol | Kind | Subpath | Purpose |
| --- | --- | --- | --- |
| `Agent` | class | `.` | Core agentic execution engine (LLM loop + tools + steering + watchdog). |
| `ArgonAgent` | class (alias) | `.` | Published brand alias of `Agent`; identical class. |
| `MessageManager` | class | `.` | Owns the ordered conversation message history. |
| `MessageQueueManager` | class | `.` | Steering (high-priority) + follow-up (low-priority) message queues. |
| `IdleWatchdog` | class | `.` | Aborts the agent when no events arrive within the idle timeout. |
| `THINKING_BUDGET` | const | `.`, `./llm/types` | Maps `ThinkingLevel` → Anthropic `budget_tokens`. |
| `LLMError` | class | `.` | Structured provider error (type + retryable + status). |
| `classifyHttpError` | fn | `.` | Map an HTTP status + body to an `LLMError`. |
| `wrapFetchError` | fn | `.` | Wrap a network/fetch failure into an `LLMError`. |
| `parseSSEStream` | fn | `.` | Parse a `text/event-stream` body into `SSEEvent`s. |
| `consumeStream` | fn | `.` | Drain a `StreamEvent` iterator into a final `AssistantMessage`. |
| `ProviderRegistry` | class | `.`, `./llm/providers` | Registry of `LLMProvider`s keyed by `provider.id`; `stream`/`complete` helpers. |
| `initProviders` | fn | `.`, `./llm/providers` | Create a registry pre-populated with the built-in providers. |
| `getProviderRegistry` | fn | `.`, `./llm/providers` | Get (lazily create) the global singleton registry. |
| `setProviderRegistry` | fn | `.`, `./llm/providers` | Replace the global singleton registry (DI / testing seam). |
| `streamLLM` | fn | `.`, `./llm/providers` | Stream via the singleton registry (pi-ai `streamSimple` replacement). |
| `completeLLM` | fn | `.`, `./llm/providers` | Non-streaming completion via the singleton registry. |
| `AnthropicProvider` | class | `.` | Built-in Anthropic provider adapter. |
| `OpenAIProvider` | class | `.` | Built-in OpenAI provider adapter. |
| `GoogleProvider` | class | `.` | Built-in Google provider adapter. |
| `ModelRegistry` | class | `.` | In-memory registry of `ModelInfo` metadata. |
| `getModelRegistry` | fn | `.` | Get the global singleton model registry. |
| `setModelRegistry` | fn | `.` | Replace the global singleton model registry. |
| `textResult` | fn | `.`, `./tools/helpers` | Build a successful text `ToolResult`. |
| `errorResult` | fn | `.`, `./tools/helpers` | Build an error `ToolResult` (`isError:true`). |
| `imageResult` | fn | `.`, `./tools/helpers` | Build a base64 image `ToolResult`. |
| `multiResult` | fn | `.`, `./tools/helpers` | Build a multi-block `ToolResult`. |
| `defineTool` | fn | `.`, `./tools/helpers` | Builder that creates a typed `AgentTool` from a config object. |
| `ToolRegistry` | class | `.` | Registry of `AgentTool`s; emits add/remove events. |
| `ToolParamValidator` | class | `.` | Validate tool params against JSON Schema (ajv when present, fallback otherwise). |
| `ToolValidationError` | class | `.` | Error thrown on tool parameter validation failure. |
| `formatValidationErrors` | fn | `.` | Format `ValidationError[]` into a readable string. |
| `ToolExecutor` | class | `.` | Execute a tool by name with timeout + validation. |
| `SkillRegistry` | class | `.`, `./skills` | In-memory skill table: precedence, shadowing, session activation. |
| `parseFrontmatter` | fn | `.`, `./skills` | Strict-subset YAML frontmatter parser for `SKILL.md`. Returns `null`, never throws. |
| `validateSkillFrontmatter` | fn | `.`, `./skills` | Frontmatter contract check → `SkillValidationIssue[]` with stable codes. |
| `validateStagedSkill` | fn | `.`, `./skills` | Pre-install safety check (zip-slip, symlinks, size / count / depth caps). |
| `renderSkillCatalog` | fn | `.`, `./skills` | Level 1 `<available_skills>` block. `''` when nothing is eligible. |
| `renderSkillBody` | fn | `.`, `./skills` | Level 2 payload for the `skill` tool result. |
| `renderSkillInvocation` | fn | `.`, `./skills` | User message produced by a `/<skill-name>` command. |
| `renderSkillFindResults` | fn | `.`, `./skills` | `skill_find` result block; falls back to an explicit "do not invent a source" refusal on zero matches. |
| `rankCatalogRecords` | fn | `.`, `./skills` | Catalog order: scope first, then usage recency/frequency. Without a usage map, identical to `catalogRecords`. |
| `applySkillArguments` | fn | `.`, `./skills` | `$ARGUMENTS` / `$1..$9` / `$$` substitution. |
| `suggestSkillNames` | fn | `.`, `./skills` | "Did you mean" candidates for an unknown skill name. |
| `sanitizeForPromptBlock` | fn | `.`, `./skills` | Neutralize untrusted text before it enters a tagged prompt block. Idempotent. |
| `createSkillTool` | fn | `.`, `./skills` | Build the `skill` (Level 2) `AgentTool` from a registry + a `loadBody` port. |
| `createSkillFindTool` | fn | `.`, `./skills` | Build the `skill_find` `AgentTool`. Searches the injected registry only — never the network. |
| `SKILL_CATALOG_MAX_BYTES` | const | `.`, `./skills` | Level 1 block ceiling (UTF-8 **bytes**). |
| `SKILL_BODY_MAX_BYTES` | const | `.`, `./skills` | SKILL.md body ceiling inside a tool result (bytes). |
| `SKILL_RESULT_MAX_BYTES` | const | `.`, `./skills` | Whole-result ceiling, kept below `ToolExecutor`'s 100 000-byte cap. |
| `ALWAYS_SKILLS_MAX_BYTES` | const | `.`, `./skills` | Combined ceiling for `activation: always` bodies (bytes). |
| `SKILL_MD_MAX_BYTES` | const | `.`, `./skills` | Largest `SKILL.md` the scanner will read. |
| `SKILL_DESC_LINE_MAX` | const | `.`, `./skills` | Per-entry description cap in the catalog (characters). |
| `SKILL_FILES_MAX` | const | `.`, `./skills` | Max entries listed in `<skill_files>`. |
| `SKILL_FIND_MAX_BYTES` | const | `.`, `./skills` | `skill_find` result-block ceiling (UTF-8 **bytes**). |
| `SKILL_NAME_PATTERN` | const | `.`, `./skills` | Kebab-case validity regex for a skill name. |

> **Units.** Every skill budget named `*_BYTES` is measured with
> `Buffer.byteLength`, never `String.length`. `ToolExecutor` truncates at
> 100 000 **bytes**, so a character-based budget silently triples for CJK text
> and gets cut mid-tag.
>
> The `./skills` subpath additionally exposes internals the CLI needs
> (`renderAlwaysSkills`, `normalizeFrontmatter`, `checkStagedPath`,
> `byteLength`, `truncateToBytes`, the staging/archive limits) without widening
> the frozen root surface.

## Type-only exports (not seen by `Object.keys`; documented here)

| Type | Subpath | Notes |
| --- | --- | --- |
| `ContentPart`, `TextContentPart`, `ImageContentPart` | `.`, `./llm/types` | Multimodal user-message content parts. |
| `ContentBlock`, `TextBlock`, `ThinkingBlock`, `ToolCallBlock` | `.`, `./llm/types` | Assistant message body blocks. |
| `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage` | `.`, `./llm/types` | Conversation message union + members. |
| `StopReason` | `.`, `./llm/types` | `end_turn` / `tool_use` / `max_tokens` / `stop_sequence`. |
| `TokenUsage` | `.`, `./llm/types` | Input / output / cache token counts + optional cost. |
| `ThinkingLevel` | `.`, `./llm/types` | `off`…`xhigh` extended-thinking levels. |
| `StreamEvent` + members (`TextDeltaEvent`, `ThinkingStartEvent`, `ThinkingDeltaEvent`, `ToolCallStartEvent`, `ToolCallDeltaEvent`, `ToolCallEndEvent`, `DoneEvent`, `ErrorEvent`) | `.`, `./llm/types` | Provider-agnostic streaming events. `TextDeltaEvent.delta`; `DoneEvent.{message,usage}`. |
| `ToolDefinition`, `JSONSchema` | `.`, `./llm/types` | LLM-facing tool schema. |
| `ModelInfo`, `ModelCost` | `.`, `./llm/types` | Model metadata + pricing. |
| `LLMProvider`, `LLMRequest`, `LLMErrorType` | `.` | Provider interface + request shape + error taxonomy. |
| `SSEEvent` | `.` | Parsed server-sent event. |
| `JSONSchema7`, `ToolResultContent`, `ToolResult`, `ToolProgressUpdate`, `ToolExecutionContext`, `ToolExecuteFn`, `AgentTool`, `AgentToolDefinition`, `ToolRegistryEvent`, `ToolExecutionResult` | `.`, `./tools/types` | Tool-system types. (`AgentToolDefinition` = `ToolDefinition` from `tools/types`.) |
| `DefineToolConfig` | `.`, `./tools/helpers` | Config object accepted by `defineTool`. |
| `ToolRegistryListener` | `.` | Listener signature for `ToolRegistry` events. |
| `ValidationError` | `.` | `{ path, message }` validation failure detail. |
| `ToolExecutorOptions` | `.` | Options for `ToolExecutor`. |
| `AgentEvent` + members (`AgentStartEvent`, `AgentEndEvent`, `TurnStartEvent`, `TurnEndEvent`, `MessageUpdateEvent`, `ToolExecutionStartEvent`, `ToolExecutionEndEvent`, `CodeExecutionStartEvent`, `CodeExecutionEndEvent`), `AgentEventListener` | `.` | Engine lifecycle events emitted via `Agent.subscribe`. |
| `AgentConfig`, `AgentState` | `.` | Agent constructor config + readonly state view. |
| `ModelRef` | `.` | `{ providerId, modelId, baseUrl? }` model reference. |
| `CodeActSandbox`, `CodeActResult` | `.` | CodeAct sandbox interface + result (impl lazy-loaded). |
| `SandboxConfig`, `ExecuteOptions`, `ExecuteResult`, `ConsoleEntry`, `SandboxToolCall` | `./sandbox/*` | Sandbox types. The sandbox **implementation** is NOT re-exported from the root (`isolated-vm` is incompatible with some embedded V8 runtimes); import `@argon-agent/core/sandbox/*` directly and lazily when needed. |
| `SkillScope`, `SkillActivation` | `.`, `./skills` | `bundled \| user \| project \| env`; `auto \| always \| manual`. |
| `SkillFrontmatter`, `SkillRecord`, `SkillFileRef` | `.`, `./skills` | Parsed frontmatter, the in-memory skill record, and a bundled-file reference. |
| `SkillHost` | `.`, `./skills` | The injected filesystem port. Every method MAY THROW; callers own the try/catch. This is what keeps core free of `node:*`. |
| `SkillManifest` | `.`, `./skills` | Parsed `.argon-skill.json` (provenance + per-file sha256). |
| `SkillValidationIssue` | `.`, `./skills` | `{ level, code, message }`; the codes are a stable public surface. |
| `SkillCatalogOptions`, `SkillBodyOptions`, `SkillFindOptions` | `.`, `./skills` | Render options for Level 1 / Level 2 / `skill_find`. |
| `SkillIntegrity` | `.`, `./skills` | `unverified \| ok \| modified` — how `SKILL.md` compares to the copy recorded at install. |
| `SkillUsageStat`, `SkillUsageMap` | `.`, `./skills` | `{ useCount, lastUsedAt }` per skill name, used to rank the catalog. Local only. |
