# `@aragon-agent/core` — Public API contract

> Human-readable companion to the machine-checked snapshot in
> `src/__tests__/public-api.test.ts`. The test freezes the set of **runtime
> (value)** exports; this document additionally records the **type** exports for
> readers. **Three-sync discipline:** any change to the public surface must update
> `src/index.ts`, the `EXPECTED` list in `public-api.test.ts`, and this file (plus
> `CHANGELOG.md`).
>
> All symbols are re-exported from the package root (`@aragon-agent/core`). The
> "Subpath" column also notes the dedicated `exports` entry where one exists.

## Runtime (value) exports — 85

| Symbol | Kind | Subpath | Purpose |
| --- | --- | --- | --- |
| `Agent` | class | `.` | Core agentic execution engine (LLM loop + tools + steering + watchdog). |
| `AragonAgent` | class (alias) | `.` | Published brand alias of `Agent`; identical class. |
| `MessageManager` | class | `.` | Owns the ordered conversation message history. |
| `MessageQueueManager` | class | `.` | Steering (high-priority) + follow-up (low-priority) message queues. |
| `IdleWatchdog` | class | `.` | Aborts the agent when no events arrive within the idle timeout. |
| `findSafeCutIndices` | fn | `.` | Every index at which a history may be split without stranding a tool call. Pure. |
| `planCompaction` | fn | `.` | The largest safe cut leaving `keepRecentTurns` turns, or `null`. Pure. |
| `relieveTail` | fn | `.` | Clip oversized `tool_result` bodies inside a retained tail until a history fits. Structure-preserving, so `validateHistory` still passes. Pure. |
| `validateHistory` | fn | `.` | Structural gate: refuses an orphan `tool_result`, an unclosed `tool_call`, an empty array, or a history that grew. |
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
| `DEFAULT_MAX_OUTPUT_TOKENS` | const | `.` | `64000` — the product default output cap. THE single source of truth. |
| `MIN_MAX_OUTPUT_TOKENS` | const | `.` | `256` — below this a turn cannot produce a usable tool call. |
| `SAFE_FALLBACK_MAX_OUTPUT_TOKENS` | const | `.` | `8192` — used when recovery cannot parse a real ceiling. |
| `ABSOLUTE_MAX_OUTPUT_TOKENS` | const | `.` | `200000` — sanity bound on a hand-edited config value. |
| `THINKING_HEADROOM_TOKENS` | const | `.` | `4096` — margin for Anthropic's `max_tokens > budget_tokens`. |
| `CONTEXT_SAFETY_MARGIN_TOKENS` | const | `.` | `1024` — slack for the deliberately crude prompt estimate. |
| `resolveOutputTokens` | fn | `.` | Resolve the cap for one request. See *Output token limits* below. |
| `staticCeilingFor` | fn | `.` | The statically known ceiling for a `provider:model`, or `undefined`. |
| `learnModelCeiling` | fn | `.` | Record a ceiling; a lower-ranked source never overwrites a higher one. |
| `getLearnedCeiling` | fn | `.` | Read the learned ceiling + its source. |
| `clearLearnedCeilings` | fn | `.` | Test hook. Required in `afterEach` for any test that learns. |
| `estimatePromptTokens` | fn | `.` | ~4 chars/token guard rail. Not an accounting function. |
| `CHARS_PER_TOKEN` | const | `.` | `4` — the constant `estimatePromptTokens` divides by. Exported so a host budgeting a compaction digest cannot grow a second copy. |
| `classifyOutputLimitFailure` | fn | `.` | Decide whether a 400 was about the output cap, and how. |
| `sendWithOutputLimitRecovery` | fn | `.` | Send, and on an output-limit 400 repair and send **once** more. |
| `learnTokenField` | fn | `.` | Memoize `max_tokens` vs `max_completion_tokens` for a model. |
| `getLearnedTokenField` | fn | `.` | Read the memoized token-field dialect. |
| `clearLearnedTokenFields` | fn | `.` | Test hook. Required in `afterEach` for any test that memoizes. |
| `RETRY_LIMITS` | const | `.` | Structural bounds on retry: `hardMaxRetries` 20, `absoluteMaxDelayMs` 120 000, `retryAfterCeilingMs` 60 000, `minDelayMs` 100. |
| `DEFAULT_RETRY_POLICY` | const | `.` | 10 retries, 1 s → 30 s equal-jittered ladder, 240 s budget, mid-stream restart on. |
| `isRetryableError` | fn | `.` | `RetryDecision` for one failure. Checks `signal.aborted` **first** — see *Retry* below. |
| `computeBackoffDelay` | fn | `.` | The wait before retry `n` (1-based). Equal jitter; `Retry-After` is a floor. |
| `parseRetryAfterMs` | fn | `.` | `Retry-After` / `x-ratelimit-reset-after` / two `anthropic-ratelimit-*-reset` headers → ms. |
| `withRetry` | fn | `.` | Wrap any `AsyncIterableIterator<StreamEvent>` with the retry ladder. Installed by `ProviderRegistry.stream()`. |
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

## Blocking on a human — `pauseIdleWatchdog` / `resumeIdleWatchdog` / `toolTimeoutOverrides`

These three members exist for one situation: a tool that cannot finish until a
person answers. They are **instance methods and a config field, not module-level
exports**, so the `EXPECTED` list in `public-api.test.ts` is unaffected.

| Member | Signature | Notes |
| --- | --- | --- |
| `Agent.pauseIdleWatchdog()` | `(): void` | Suspend the idle watchdog. Idempotent. A paused watchdog also swallows `kick()`, so an event arriving mid-wait cannot re-arm it. |
| `Agent.resumeIdleWatchdog()` | `(): void` | Resume it, restarting the idle window from now. Idempotent. Always call from a `finally`. |
| `AgentConfig.timeouts.toolTimeoutOverrides` | `Record<string, number>` | Per-tool ceiling in ms, keyed by tool name; forwarded to `ToolExecutor.timeoutOverrides`. |

The host, not the engine, is the only party that can know a human is being
waited on: from inside the loop that call looks like an ordinary long-running
tool, and aborting it after `idleTimeout` is correct for a wedged network call
and wrong for a person reading a plan.

**The single most surprising fact about `toolTimeoutOverrides`, and the one that
makes it useless on its own:** `ToolExecutor` expresses a timeout by calling
`controller.abort(TIMEOUT_REASON)` on the context signal and then *continuing to
`await`* the tool's promise. There is no `Promise.race` anywhere in
`executor.ts`. A tool that never observes `context.signal` is therefore never
timed out — the number here changes nothing for it, silently. Any tool that must
honour a ceiling has to subscribe explicitly:

```ts
async execute(id, params, ctx) {
  return new Promise((resolve) => {
    const settle = (value) => { /* idempotent */ resolve(value); };
    ctx.signal?.addEventListener('abort', () => settle(cancelledResult), { once: true });
    // ...start the real work, settle when it finishes...
  });
}
```

Pausing the watchdog removes the *other* ceiling, so the two changes are one
mechanism: pause without a signal-aware tool means the run has no ceiling at all
and wedges until the process is killed.

## Output token limits — `resolveOutputTokens` and one-shot recovery

Sending a generous `max_tokens` unconditionally is only safe for models whose
ceiling is at least that generous. Anthropic, OpenAI and Google all answer an
over-large cap with an HTTP 400, and a 400 inside the agent loop ends the turn.
So **`DEFAULT_MAX_OUTPUT_TOKENS` is the ambition and the model's real ceiling is
the law**, with the gap closed silently rather than by a failed run.

Four ranked ceiling sources feed one resolver:

```
learned-from-error  >  discovery (API-reported)  >  static table  >  64000
```

`resolveOutputTokens({ providerId, modelId, requested?, modelLimits?, thinkingBudget?, estimatedPromptTokens? })`
applies them in this order, and this order is normative:

1. `ceiling = learned ?? modelLimits.maxOutputTokens ?? staticCeilingFor(...)`.
2. The ambition is `requested ?? 64000`. **AUTO never exceeds the product
   default**, even on a model that would allow 100000 — on OpenAI the cap is
   charged against the context window. An explicit `requested` may exceed 64000
   up to the ceiling; that is the caller's decision.
3. Clamp to the ceiling (`clampedBy: 'ceiling'`).
4. On OpenAI only, and only when `modelLimits.contextWindow` and
   `estimatedPromptTokens` are both supplied, keep
   `max_tokens + prompt <= context - 1024` (`clampedBy: 'context'`).
5. Clamp to `ABSOLUTE_MAX_OUTPUT_TOKENS` (`clampedBy: 'absolute'`).
6. Keep Anthropic's `max_tokens > thinking.budget_tokens`: raise the cap if the
   ceiling allows, otherwise lower the budget, and return
   `thinkingBudget: 0` — meaning **omit the `thinking` block entirely** — when
   even the 1024 floor will not fit.
7. Floor at `MIN_MAX_OUTPUT_TOKENS`.

The function is pure apart from reading the learned map, never throws, and never
returns `NaN`, `0` or a negative.

`sendWithOutputLimitRecovery` wraps the `fetch` so a provider that disagrees with
all four sources is obeyed rather than surfaced:

- A 2xx returns immediately with its body **unread** — a streaming response must
  reach the SSE parser intact.
- Otherwise the body is read **exactly once** and handed back as
  `RecoveryAttempt.bodyText`. Callers must pass that on instead of calling
  `response.text()` again, which throws `TypeError: Body is unusable`.
- On an output-limit 400 the request is repaired and sent **once** more — never a
  loop — and what was learned (`ceiling`, or the token-field dialect) is recorded
  for the rest of the process. A second failure surfaces unchanged.

Both learned maps are process-scoped and never persisted. **Any test that
populates one MUST clear it in `afterEach`**, or a learned 8192 leaks into the
next test file and fails it for a reason that is not in that file.

## Retry & exponential backoff — `withRetry`, and it is ON BY DEFAULT

`ProviderRegistry.stream()` wraps every provider stream in `withRetry`, and
`ProviderRegistry.complete()` routes through `stream()`. A registry built with no
options therefore retries a transient failure up to **10 times** with an
increasing, equal-jittered interval (1 s → 2 → 4 → 8 → 16 → 30 s, capped) under a
**240 s** wall-clock budget from the first failure.

```ts
// Opt out entirely — byte-identical to a pre-retry build.
const registry = initProviders({ retryPolicy: null });

// Or tune it, and change it live.
registry.setRetryPolicy({ ...DEFAULT_RETRY_POLICY, maxRetries: 3 });
```

**What is retried:** `rate_limit` (429), `overloaded` (529), `server_error`
(5xx), `network_error` (DNS/TLS/ECONNRESET), `timeout` (408). **What is not:**
`auth_error`, `invalid_request`, `context_overflow`, `unknown`. The taxonomy is
`LLMError.retryable`, read **structurally** rather than through `instanceof`.

Four properties worth knowing before relying on this:

- **An abort is never a retry.** `wrapFetchError` marks an `AbortError`
  `retryable: true`, so `isRetryableError` checks `signal.aborted` **first**. An
  aborted request yields no further event of any kind — in particular no `error`,
  so nothing fabricates a network failure out of a user pressing Esc.
- **`Retry-After` is a floor, not a replacement.** A `Retry-After: 1` on the
  ninth retry does not undo eight retries of backoff. A value above
  `RETRY_LIMITS.retryAfterCeilingMs` (60 s) is **not waited out**: the error is
  surfaced immediately, carrying the provider's own number.
- **A restart after content has streamed is supported and announced.** When an
  attempt had already forwarded content, `withRetry` emits `stream_restart` with
  `discardedToolCallIds` so the consumer can rewind its view. Engine history is
  provably clean at that point (`messageManager.push` only runs on `done`). Set
  `onPartialStream: false` to refuse the whole path.
- **The wait pauses the idle watchdog.** `Agent` pauses on `retry_scheduled` and
  resumes on `retry_attempt`, so a 30 s backoff is not mistaken for a wedged
  call. `IdleWatchdog.stop()` clears `paused`, so an abort mid-wait cannot leave
  the next run deaf.

**Not covered, deliberately:** a half-open connection — a socket that stops
delivering bytes with neither FIN nor RST. It produces no event, so `withRetry`
never wakes; the idle watchdog aborts the run instead. A per-attempt stall timer
is not a safe fix at this layer, because Anthropic's `ping` frames are swallowed
by the adapter, making a long extended-thinking pause indistinguishable from a
dead socket at the `StreamEvent` layer.

**The singleton diverges.** `streamLLM` / `completeLLM` resolve through
`getProviderRegistry()`, which builds its registry with `initProviders()` and no
arguments. They therefore always carry `DEFAULT_RETRY_POLICY` and do **not**
observe a policy installed on a registry you constructed yourself. For one policy
everywhere: `setProviderRegistry(initProviders({ retryPolicy }))` once at startup.

## Context compaction — `AgentConfig.contextManager`

A long agentic run fills the model's context window and then dies with a 400. The
engine's answer is one **injected port**: at every turn boundary — after the
steering drain, before `turn_start` — it asks a `ContextManager` whether to
compact, and if so hands it a copy of the history and adopts whatever comes back.

**The mechanism is here; the policy is yours.** This package has no `ModelInfo`
and deliberately does not learn one, so the threshold, which model summarizes,
what the summary asks for and what happens on failure are all decisions on your
side of the port.

```ts
const agent = new Agent({
  /* ... */
  contextManager: {
    // SYNCHRONOUS, cheap, side-effect free. Called once per turn.
    shouldCompact: (probe) => occupancy(probe.lastUsage) >= 0.9,
    // Only called when the predicate said yes.
    compact: async (ctx) => ({
      action: 'replace',
      mode: 'summarized',
      messages: [anchor, summaryBlock, ...ctx.messages.slice(cutIndex)],
      summary,
    }),
  },
});
```

| Guarantee | Detail |
| --- | --- |
| **Off is free** | Omit `contextManager` and the checkpoint is one `if` against an absent field. No promise allocation, no events, no behaviour change. |
| **The engine validates and may refuse** | `validateHistory` runs on every proposed replacement. An orphan `tool_result`, an unclosed `tool_call`, an empty array or a history that grew is **not adopted**; the run continues on the original and `compaction_end` says why. A host bug degrades to "compaction did not happen", never to an un-sendable conversation. |
| **You get a copy, not the live array** | `ctx.messages` is a shallow copy. Mutating it cannot corrupt engine state. |
| **The call is bounded** | `compaction_start` pauses the idle watchdog, so the engine races `compact()` against `ctx.signal` **and** a 120 s hard ceiling of its own. A non-settling promise resolves to `reason: 'manager_timeout'`; an abort resolves to `reason: 'aborted'`. Neither can hang the run, and neither depends on the host honouring the signal. |
| **A malformed outcome degrades** | A `compact()` that resolves with `undefined`, or a `replace` with no `messages` array, reports `reason: 'manager_bad_outcome'` and changes nothing. |
| **`compaction_end` is always emitted** | From a `finally`, on every exit path, because it is what **resumes** the watchdog. |

`shouldCompact` is synchronous on purpose: an async port would put a microtask
tick and a promise allocation on every turn of every run for a decision that is
`false` more than 99 % of the time.

The four pure helpers — `findSafeCutIndices`, `planCompaction`,
`relieveTail`, `validateHistory` — are exported so a host can plan a cut with the
same rules the engine validates against. `relieveTail` is the last rung of the
host's ladder: when the RETAINED tail alone exceeds the window, it clips
oversized `tool_result` bodies in place, oldest first, announcing each clip in
the text the model reads. It changes no role, no id and no message count, so a
history that passed `validateHistory` before still passes after — which is what
makes it safe to run on an already-spliced history. Relief is reported back on
`compaction_end.tailRelief`. `validateHistory` in particular is public so a host
that splices the history while the agent is **idle** (where there is no loop, and
therefore no gate) can honour the same refusal.

`AgentConfig.timeouts.compactionHardTimeout` exists only so the ceiling is
testable in under two minutes. It is not a policy knob: the point of the ceiling
is that it does not depend on the host being correct.

## Type-only exports (not seen by `Object.keys`; documented here)

| Type | Subpath | Notes |
| --- | --- | --- |
| `ContentPart`, `TextContentPart`, `ImageContentPart` | `.`, `./llm/types` | Multimodal user-message content parts. |
| `ContentBlock`, `TextBlock`, `ThinkingBlock`, `ToolCallBlock` | `.`, `./llm/types` | Assistant message body blocks. |
| `Message`, `UserMessage`, `AssistantMessage`, `ToolResultMessage` | `.`, `./llm/types` | Conversation message union + members. |
| `StopReason` | `.`, `./llm/types` | `end_turn` / `tool_use` / `max_tokens` / `stop_sequence`. |
| `TokenUsage` | `.`, `./llm/types` | Input / output / cache token counts + optional cost. |
| `ThinkingLevel` | `.`, `./llm/types` | `off`…`xhigh` extended-thinking levels. |
| `StreamEvent` + members (`TextDeltaEvent`, `ThinkingStartEvent`, `ThinkingDeltaEvent`, `ToolCallStartEvent`, `ToolCallDeltaEvent`, `ToolCallEndEvent`, `DoneEvent`, `ErrorEvent`, `RetryScheduledEvent`, `RetryAttemptEvent`, `StreamRestartEvent`) | `.`, `./llm/types` | Provider-agnostic streaming events. `TextDeltaEvent.delta`; `DoneEvent.{message,usage}`. The three `retry*` / `stream_restart` members are produced only by `withRetry`; a consumer that ignores unknown types is unaffected. |
| `RetryPolicy`, `RetryDecision`, `WithRetryOptions` | `.` | Retry policy shape, the classification result (`retry` + a machine `reason`), and `withRetry`'s injectable clock / sleep / random. |
| `ProviderRegistryOptions` | `.`, `./llm/providers` | `{ retryPolicy?: RetryPolicy \| null }`. Absent = the product default; explicit `null` = opt out. |
| `ToolDefinition`, `JSONSchema` | `.`, `./llm/types` | LLM-facing tool schema. |
| `ModelInfo`, `ModelCost` | `.`, `./llm/types` | Model metadata + pricing. |
| `LLMProvider`, `LLMRequest`, `LLMErrorType` | `.` | Provider interface + request shape + error taxonomy. `LLMRequest.maxTokens` is an ambition (clamped per model); `LLMRequest.modelLimits?: { maxOutputTokens?, contextWindow? }` is optional caller-supplied metadata. |
| `OutputLimitInput`, `OutputLimitResolution`, `CeilingSource` | `.` | Input / output of `resolveOutputTokens`; `catalog \| discovery \| error` ceiling provenance. |
| `OutputLimitFailure`, `RecoveryAttempt`, `RecoveryOptions`, `TokenField` | `.` | Recovery classification, its result (carrying the already-consumed `bodyText`), its options, and the wire name of the cap field. |
| `SSEEvent` | `.` | Parsed server-sent event. |
| `JSONSchema7`, `ToolResultContent`, `ToolResult`, `ToolProgressUpdate`, `ToolExecutionContext`, `ToolExecuteFn`, `AgentTool`, `AgentToolDefinition`, `ToolRegistryEvent`, `ToolExecutionResult` | `.`, `./tools/types` | Tool-system types. (`AgentToolDefinition` = `ToolDefinition` from `tools/types`.) |
| `DefineToolConfig` | `.`, `./tools/helpers` | Config object accepted by `defineTool`. |
| `ToolRegistryListener` | `.` | Listener signature for `ToolRegistry` events. |
| `ValidationError` | `.` | `{ path, message }` validation failure detail. |
| `ToolExecutorOptions` | `.` | Options for `ToolExecutor`. |
| `AgentEvent` + members (`AgentStartEvent`, `AgentEndEvent`, `TurnStartEvent`, `TurnEndEvent`, `SteeringAcceptedEvent`, `MessageUpdateEvent`, `ToolExecutionStartEvent`, `ToolExecutionEndEvent`, `CodeExecutionStartEvent`, `CodeExecutionEndEvent`, `CompactionStartEvent`, `CompactionEndEvent`), `AgentEventListener` | `.` | 引擎通过 `Agent.subscribe` 发出生命周期事件。`steering_accepted` 表示带 ID 的 steering 已写入历史；详见下方源兼容说明。两个 `compaction_*` 成员仅在注入 `contextManager` 时发出。 |
| `SteeringMessage` | `.` | 只读 `text: string` 与可选只读 `id?: string`，由 `drainSteeringItems()` 返回；仅类型导出。 |
| `ContextManager`, `CompactionProbe`, `CompactionContext`, `CompactionOutcome`, `CompactionTrigger` | `.` | The injected compaction port. See *Context compaction* below. |
| `CompactionPlan`, `HistoryCheck`, `PlanCompactionOptions`, `ValidateHistoryOptions` | `.` | Results and options of the three pure mechanics functions. |
| `AgentConfig`, `AgentState` | `.` | Agent constructor config + readonly state view. `AgentConfig.timeouts.toolTimeoutOverrides?: Record<string, number>` — see *Blocking on a human* below. |
| `ModelRef` | `.` | `{ providerId, modelId, baseUrl? }` model reference. |
| `CodeActSandbox`, `CodeActResult` | `.` | CodeAct sandbox interface + result (impl lazy-loaded). |
| `SandboxConfig`, `ExecuteOptions`, `ExecuteResult`, `ConsoleEntry`, `SandboxToolCall` | `./sandbox/*` | Sandbox types. The sandbox **implementation** is NOT re-exported from the root (`isolated-vm` is incompatible with some embedded V8 runtimes); import `@aragon-agent/core/sandbox/*` directly and lazily when needed. |
| `SkillScope`, `SkillActivation` | `.`, `./skills` | `bundled \| user \| project \| env`; `auto \| always \| manual`. |
| `SkillFrontmatter`, `SkillRecord`, `SkillFileRef` | `.`, `./skills` | Parsed frontmatter, the in-memory skill record, and a bundled-file reference. |
| `SkillHost` | `.`, `./skills` | The injected filesystem port. Every method MAY THROW; callers own the try/catch. This is what keeps core free of `node:*`. |
| `SkillManifest` | `.`, `./skills` | Parsed `.aragon-skill.json` (provenance + per-file sha256). |
| `SkillValidationIssue` | `.`, `./skills` | `{ level, code, message }`; the codes are a stable public surface. |
| `SkillCatalogOptions`, `SkillBodyOptions`, `SkillFindOptions` | `.`, `./skills` | Render options for Level 1 / Level 2 / `skill_find`. |
| `SkillIntegrity` | `.`, `./skills` | `unverified \| ok \| modified` — how `SKILL.md` compares to the copy recorded at install. |
| `SkillUsageStat`, `SkillUsageMap` | `.`, `./skills` | `{ useCount, lastUsedAt }` per skill name, used to rank the catalog. Local only. |

## Steering 接收与源兼容性

`Agent.steer(text, id?)` 仍支持原单参数调用；传入的可选 ID 是宿主生成的不透明关联值，
不会写入模型正文。相同正文可以携带不同 ID，Core 不按文本合并。
`MessageQueueManager.drainSteering(): string[]` 保留原行为；新增的
`drainSteeringItems(): SteeringMessage[]` 与它排空同一 FIFO，不能分别消费两份消息。

引擎将当前批次全部同步写入历史后，发出一次
`{ type: 'steering_accepted', ids: readonly string[] }`，仅包含该批次有 ID 的条目。
回执代表历史已接收，**不代表模型请求成功或回答完成**。无 ID 的消息照常接收，
不会产生空回执。新增事件成员及 `SteeringMessage` 均只扩展类型表面，没有新增运行时导出；
穷尽处理 `AgentEvent` 的 TypeScript 调用方需增加对应分支。

接收发生于回合顶部、工具批次开始前及工具之间。回合顶部接收早于异步上下文压缩，
因此压缩期间新入队的消息不属于此前回执；无工具响应结束前仍会检查新消息。
工具中途转向会先补齐尚未执行工具的 skipped 结果，保证下一次请求中的工具配对完整。
接收前已中断时消息保留在队列；回执监听者同步中断时，该批次已在历史中，不会重复入队。
`turn_start`、`turn_end`、`agent_end`、重试及定时器均不能替代精确 ID 回执。
