/**
 * Agent core — barrel export.
 *
 * This is the single entry point for importing agent-core functionality.
 * Other tasks will expand this file as more modules are added (engine, tools,
 * sandbox).
 */

// ---------------------------------------------------------------------------
// LLM types
// ---------------------------------------------------------------------------

export type {
  // Content
  ContentPart,
  TextContentPart,
  ImageContentPart,
  ContentBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,

  // Messages
  Message,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  StopReason,

  // Token usage
  TokenUsage,

  // Thinking
  ThinkingLevel,

  // Streaming
  StreamEvent,
  TextDeltaEvent,
  ThinkingStartEvent,
  ThinkingDeltaEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  DoneEvent,
  ErrorEvent,
  RetryScheduledEvent,
  RetryAttemptEvent,
  StreamRestartEvent,

  // Tools
  ToolDefinition,
  JSONSchema,

  // Models
  ModelInfo,
  ModelCost,
} from './llm/types.js';

export { THINKING_BUDGET } from './llm/types.js';

// ---------------------------------------------------------------------------
// LLM provider interface & errors
// ---------------------------------------------------------------------------

export type {
  LLMProvider,
  LLMRequest,
  LLMErrorType,
} from './llm/provider.js';

export {
  LLMError,
  classifyHttpError,
  wrapFetchError,
} from './llm/provider.js';

// ---------------------------------------------------------------------------
// Output-token limits — the authority for "how many tokens may this model
// produce". Every adapter resolves through here; nothing else spells 64000.
// ---------------------------------------------------------------------------

export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  SAFE_FALLBACK_MAX_OUTPUT_TOKENS,
  ABSOLUTE_MAX_OUTPUT_TOKENS,
  THINKING_HEADROOM_TOKENS,
  CONTEXT_SAFETY_MARGIN_TOKENS,
  resolveOutputTokens,
  staticCeilingFor,
  learnModelCeiling,
  getLearnedCeiling,
  clearLearnedCeilings,
  estimatePromptTokens,
  // Promoted from module-private for the compaction digest's budget arithmetic
  // (context-auto-compaction P2-3): two chars-per-token constants that must agree
  // and nothing checking that they do is how a budget and an estimate drift.
  CHARS_PER_TOKEN,
} from './llm/output-limits.js';

export type {
  OutputLimitInput,
  OutputLimitResolution,
  CeilingSource,
} from './llm/output-limits.js';

export {
  classifyOutputLimitFailure,
  sendWithOutputLimitRecovery,
  learnTokenField,
  getLearnedTokenField,
  clearLearnedTokenFields,
} from './llm/output-limit-recovery.js';

// ---------------------------------------------------------------------------
// Retry & exponential backoff — the authority for "a provider call failed, now
// what". Installed by default on `ProviderRegistry.stream()`; opt out with
// `initProviders({ retryPolicy: null })` or `setRetryPolicy(null)`.
//
// `normalizePolicy` and `decide` are deliberately NOT here: they are the
// implementation of the two entry points below, nobody outside the module has a
// reason to call them, and promoting them would add two symbols to the frozen
// public surface for nothing.
// ---------------------------------------------------------------------------

export {
  RETRY_LIMITS,
  DEFAULT_RETRY_POLICY,
  isRetryableError,
  computeBackoffDelay,
  parseRetryAfterMs,
  withRetry,
} from './llm/retry.js';

export type {
  RetryPolicy,
  RetryDecision,
  WithRetryOptions,
} from './llm/retry.js';

export type {
  OutputLimitFailure,
  RecoveryAttempt,
  RecoveryOptions,
  TokenField,
} from './llm/output-limit-recovery.js';

// ---------------------------------------------------------------------------
// Stream utilities
// ---------------------------------------------------------------------------

export type { SSEEvent } from './llm/stream-utils.js';

export {
  parseSSEStream,
  consumeStream,
} from './llm/stream-utils.js';

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

export {
  ProviderRegistry,
  initProviders,
  getProviderRegistry,
  setProviderRegistry,
  streamLLM,
  completeLLM,
} from './llm/providers/index.js';

export type { ProviderRegistryOptions } from './llm/providers/index.js';

// ---------------------------------------------------------------------------
// Individual providers (for direct use when needed)
// ---------------------------------------------------------------------------

export { AnthropicProvider } from './llm/providers/anthropic.js';
export { OpenAIProvider } from './llm/providers/openai.js';
export { GoogleProvider } from './llm/providers/google.js';

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

export {
  ModelRegistry,
  getModelRegistry,
  setModelRegistry,
} from './llm/model-registry.js';

// ---------------------------------------------------------------------------
// Tool system
// ---------------------------------------------------------------------------

export type {
  JSONSchema7,
  ToolResultContent,
  ToolResult,
  ToolProgressUpdate,
  ToolExecutionContext,
  ToolExecuteFn,
  AgentTool,
  ToolDefinition as AgentToolDefinition,
  ToolRegistryEvent,
  ToolExecutionResult,
} from './tools/types.js';

export {
  textResult,
  errorResult,
  imageResult,
  multiResult,
  defineTool,
} from './tools/helpers.js';

export type { DefineToolConfig } from './tools/helpers.js';

export { ToolRegistry } from './tools/registry.js';
export type { ToolRegistryListener } from './tools/registry.js';

export {
  ToolParamValidator,
  ToolValidationError,
  formatValidationErrors,
} from './tools/validator.js';
export type { ValidationError } from './tools/validator.js';

export { ToolExecutor } from './tools/executor.js';
export type { ToolExecutorOptions } from './tools/executor.js';

// ---------------------------------------------------------------------------
// Skills — progressive-disclosure skill system
//
// Pure logic only (D1): parsing, validation, registry, budgeting, rendering and
// the Level 2 tool factory. All filesystem / network / process work lives in the
// CLI and reaches this module through the injected `SkillHost` port, which is
// what keeps this package free of `node:*` imports.
// ---------------------------------------------------------------------------

export { SkillRegistry } from './skills/skill-registry.js';
export { parseFrontmatter } from './skills/frontmatter.js';
export { validateSkillFrontmatter, validateStagedSkill } from './skills/validate.js';
export {
  renderSkillCatalog,
  renderSkillBody,
  renderSkillInvocation,
  renderSkillFindResults,
  rankCatalogRecords,
  applySkillArguments,
  suggestSkillNames,
  sanitizeForPromptBlock,
} from './skills/disclosure.js';
export { createSkillTool } from './skills/skill-tool.js';
export { createSkillFindTool } from './skills/skill-find-tool.js';
// The turn-scoped tool ceiling (§5). Only the two entry points the host needs to
// decide and to judge a call; the alias tables and the rendering helpers stay on
// the `./skills` subpath, matching the existing split of this barrel.
export { computeToolPolicy, evaluateToolCall } from './skills/tool-policy.js';
export {
  // Every budget below is measured in UTF-8 BYTES (D19).
  SKILL_CATALOG_MAX_BYTES,
  SKILL_BODY_MAX_BYTES,
  SKILL_RESULT_MAX_BYTES,
  ALWAYS_SKILLS_MAX_BYTES,
  SKILL_MD_MAX_BYTES,
  SKILL_DESC_LINE_MAX,
  SKILL_FILES_MAX,
  SKILL_FIND_MAX_BYTES,
  SKILL_NAME_PATTERN,
} from './skills/constants.js';

export type {
  SkillScope,
  SkillActivation,
  SkillFrontmatter,
  SkillRecord,
  SkillFileRef,
  SkillHost,
  SkillManifest,
  SkillValidationIssue,
  SkillCatalogOptions,
  SkillBodyOptions,
  SkillFindOptions,
  SkillIntegrity,
  SkillUsageStat,
  SkillUsageMap,
  SkillInvocationOptions,
  SkillPlatform,
  SkillPolicyView,
  SkillToolPolicyMode,
  ToolPolicyDecision,
  ToolPolicyInput,
  ToolPolicySource,
  ToolPolicyVerdict,
} from './skills/types.js';

// ---------------------------------------------------------------------------
// Agent event types
// ---------------------------------------------------------------------------

export type {
  AgentEvent,
  AgentEventListener,
  AgentStartEvent,
  AgentEndEvent,
  TurnStartEvent,
  TurnEndEvent,
  MessageUpdateEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
  CodeExecutionStartEvent,
  CodeExecutionEndEvent,
  CompactionStartEvent,
  CompactionEndEvent,
} from './types.js';

// ---------------------------------------------------------------------------
// Agent engine
// ---------------------------------------------------------------------------

export { Agent } from './engine/agent.js';
export type { AgentConfig, AgentState } from './engine/agent.js';
export type { ModelRef } from './engine/agent-loop.js';

// Re-export CodeActSandbox/CodeActResult from engine (which re-exports from sandbox)
export type { CodeActSandbox, CodeActResult } from './engine/agent-loop.js';
export { MessageManager } from './engine/message-manager.js';
export { MessageQueueManager } from './engine/steering.js';
export { IdleWatchdog } from './engine/watchdog.js';

// ---------------------------------------------------------------------------
// Context compaction (context-auto-compaction §4.1)
//
// THREE PURE FUNCTIONS AND FIVE TYPES. The mechanism is here; the policy — the
// threshold, the summarizer, the prompt, the failure ladder — belongs to the
// host, because this package has no `ModelInfo` and must not learn one (D-2).
//
// `validateHistory` is public for a specific reason: a host that splices while
// the agent is IDLE cannot reach the loop's own gate, and D-4 declares that gate
// unbypassable. Exporting it is what makes honouring D-4 on the manual path cost
// three lines instead of a second implementation.
// ---------------------------------------------------------------------------

export {
  findSafeCutIndices,
  planCompaction,
  relieveTail,
  validateHistory,
} from './engine/compaction.js';

export type {
  CompactionPlan,
  HistoryCheck,
  PlanCompactionOptions,
  TailReliefOptions,
  TailReliefResult,
  ValidateHistoryOptions,
} from './engine/compaction.js';

export type {
  ContextManager,
  CompactionProbe,
  CompactionContext,
  CompactionOutcome,
  CompactionTrigger,
} from './engine/context-manager.js';

// ---------------------------------------------------------------------------
// CodeAct Sandbox
// ---------------------------------------------------------------------------

export type {
  SandboxConfig,
  ExecuteOptions,
  ExecuteResult,
  ConsoleEntry,
  SandboxToolCall,
} from './sandbox/types.js';

// Sandbox exports are NOT re-exported here — isolated-vm is incompatible with Electron's V8.
// Import directly from './sandbox/*.js' when needed (lazy loading only).

// ---------------------------------------------------------------------------
// AragonAgent — published brand alias of the engine's `Agent` class.
// The original `Agent` name is preserved above; consumers may use either.
// ---------------------------------------------------------------------------

export { Agent as AragonAgent } from './engine/agent.js';
