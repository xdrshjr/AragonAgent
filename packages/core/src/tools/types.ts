/**
 * Tool System — Core Type Definitions
 *
 * Defines the AgentTool interface and related types.
 * Parameters use standard JSON Schema 7.
 */

// ---------------------------------------------------------------------------
// JSON Schema 7 (minimal subset for tool parameter definitions)
// ---------------------------------------------------------------------------

/**
 * A JSON Schema 7 object used to describe tool parameters.
 *
 * This is intentionally a structural subset — it covers the shapes
 * actually used in tool parameter definitions (object schemas with
 * typed properties) while remaining compatible with full JSON Schema 7
 * validators such as ajv.
 */
export interface JSONSchema7 {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  items?: JSONSchema7 | JSONSchema7[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  additionalProperties?: boolean | JSONSchema7;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  format?: string;
  oneOf?: JSONSchema7[];
  anyOf?: JSONSchema7[];
  allOf?: JSONSchema7[];
  not?: JSONSchema7;
  if?: JSONSchema7;
  then?: JSONSchema7;
  else?: JSONSchema7;
  /** Allow arbitrary additional keywords for full JSON Schema 7 compat. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool Result Types
// ---------------------------------------------------------------------------

/** A single content block within a tool result. */
export type ToolResultContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };

/** The result returned by a tool execution. */
export interface ToolResult {
  content: ToolResultContent[];
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Tool Execution Context
// ---------------------------------------------------------------------------

/** Progress information emitted by long-running tools. */
export interface ToolProgressUpdate {
  message?: string;
  percentage?: number;
  detail?: unknown;
}

/**
 * Execution context passed to every tool invocation.
 * Provides cancellation signaling and progress reporting.
 */
export interface ToolExecutionContext {
  /** AbortSignal for cooperative cancellation (timeout + external abort). */
  signal?: AbortSignal;
  /** Optional callback for reporting incremental progress. */
  onProgress?: (update: ToolProgressUpdate) => void;
  /**
   * WHY the signal fired, set by `ToolExecutor` on THIS object at abort time,
   * before the tool's own `abort` listener runs.
   *
   * The executor already distinguishes the two — its `TIMEOUT_REASON` symbol is
   * module-private and carried on `controller.signal.reason` — but a tool cannot
   * read it, because the symbol is not exported and must not be (the runtime
   * export surface is frozen by `public-api.test.ts`). Publishing the CAUSE
   * rather than the symbol keeps that surface unchanged while letting a tool
   * write an honest footer: a command killed by the 180 s ceiling and one the
   * user interrupted with Esc want different words, and only one of them should
   * be advised to retry with a background launch.
   *
   * A FIELD ON AN EXISTING INTERFACE, so no new exported name appears. A tool
   * that ignores it behaves exactly as it does today.
   */
  abortCause?: 'timeout' | 'external';
}

// ---------------------------------------------------------------------------
// Tool Execute Function
// ---------------------------------------------------------------------------

/**
 * The function signature every tool must implement.
 *
 * @param toolCallId - Unique identifier for this tool invocation (from the LLM).
 * @param params     - Validated parameters matching the tool's JSON Schema.
 * @param context    - Execution context with signal and progress callback.
 */
export type ToolExecuteFn<TParams = Record<string, unknown>> = (
  toolCallId: string,
  params: TParams,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

// ---------------------------------------------------------------------------
// AgentTool Interface
// ---------------------------------------------------------------------------

/**
 * A self-contained tool that can be registered in the ToolRegistry,
 * exposed to LLMs as a callable function, and optionally bridged
 * into the CodeAct sandbox.
 */
export interface AgentTool<TParams = Record<string, unknown>> {
  /** Unique tool identifier (used in LLM tool_use calls). */
  name: string;

  /** Human-readable display label (UI and logs). */
  label: string;

  /** Description injected into the LLM's tool definition. */
  description: string;

  /** JSON Schema 7 describing the tool's parameters. */
  parameters: JSONSchema7;

  /** The tool's execution function. */
  execute: ToolExecuteFn<TParams>;

  /** Optional classification tags for filtering (e.g. 'filesystem', 'network'). */
  tags?: string[];

  /**
   * Whether this tool should be exposed as a bridged async function
   * inside the CodeAct JS sandbox. Defaults to false.
   */
  bridgeable?: boolean;

  /**
   * The function name used in the CodeAct sandbox when bridged.
   * Defaults to the tool's `name` if not specified.
   * Example: name='read_file', bridgeName='readFile'
   */
  bridgeName?: string;
}

// ---------------------------------------------------------------------------
// Tool Definition (LLM-facing, provider-agnostic)
// ---------------------------------------------------------------------------

/**
 * A minimal, provider-agnostic tool definition suitable for passing
 * to any LLM provider adapter.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema7;
}

// ---------------------------------------------------------------------------
// Tool Registry Event Types
// ---------------------------------------------------------------------------

/** Events emitted by ToolRegistry when tools are added or removed. */
export type ToolRegistryEvent =
  | { type: 'registered'; tool: AgentTool }
  | { type: 'unregistered'; name: string };

// ---------------------------------------------------------------------------
// Tool Execution Result (returned by ToolExecutor)
// ---------------------------------------------------------------------------

/**
 * Extended result from ToolExecutor.execute() that includes metadata
 * about the execution (timing, tool identification, error status).
 */
export interface ToolExecutionResult {
  result: ToolResult;
  /** Wall-clock duration in milliseconds. */
  duration: number;
  /** Whether the execution resulted in an error. */
  isError: boolean;
  /** The name of the tool that was executed. */
  toolName: string;
  /** The tool call ID from the LLM. */
  toolCallId: string;
}
