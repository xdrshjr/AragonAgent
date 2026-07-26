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
// ArgonAgent — published brand alias of the engine's `Agent` class.
// The original `Agent` name is preserved above; consumers may use either.
// ---------------------------------------------------------------------------

export { Agent as ArgonAgent } from './engine/agent.js';
