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

## Runtime (value) exports — 33

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
