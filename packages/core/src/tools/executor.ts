/**
 * Tool System — Tool Executor
 *
 * Orchestrates the full lifecycle of a tool invocation:
 *   1. Tool lookup from registry
 *   2. Parameter validation against JSON Schema
 *   3. Timeout wrapping via AbortController
 *   4. Execution with merged AbortSignal
 *   5. Output truncation
 *   6. Error capture into ToolResult
 */

import type { ToolRegistry } from './registry.js';
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolProgressUpdate,
  ToolResult,
} from './types.js';
import { ToolParamValidator, ToolValidationError } from './validator.js';
import { errorResult } from './helpers.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Options for configuring the ToolExecutor. */
export interface ToolExecutorOptions {
  /** Default per-tool execution timeout in milliseconds. Defaults to 120_000 (2 minutes). */
  defaultTimeout?: number;

  /** Per-tool timeout overrides, keyed by tool name. */
  timeoutOverrides?: Record<string, number>;

  /** Maximum size (in bytes) of combined text output before truncation. Defaults to 100_000 (100 KB). */
  maxOutputSize?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_SIZE = 100_000;
const TRUNCATION_SUFFIX = '\n... [truncated]';

/** Sentinel symbol used to identify timeout aborts vs external aborts. */
const TIMEOUT_REASON = Symbol('tool-timeout');

// ---------------------------------------------------------------------------
// ToolExecutor
// ---------------------------------------------------------------------------

/**
 * Executes tool calls with validation, timeout management,
 * output truncation, and comprehensive error handling.
 */
export class ToolExecutor {
  private readonly validator = new ToolParamValidator();
  private readonly defaultTimeout: number;
  private readonly timeoutOverrides: Record<string, number>;
  private readonly maxOutputSize: number;

  constructor(
    private readonly registry: ToolRegistry,
    options: ToolExecutorOptions = {},
  ) {
    this.defaultTimeout = options.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
    this.timeoutOverrides = options.timeoutOverrides ?? {};
    this.maxOutputSize = options.maxOutputSize ?? DEFAULT_MAX_OUTPUT_SIZE;
  }

  /**
   * Execute a tool call end-to-end.
   *
   * Never throws — all errors are captured as error ToolResults.
   *
   * @param toolCallId - The LLM-generated tool call ID.
   * @param toolName   - Name of the tool to execute.
   * @param rawArgs    - Raw parameter object from the LLM.
   * @param signal     - Optional external AbortSignal for cancellation.
   * @param onProgress - Optional progress callback forwarded to the tool.
   */
  async execute(
    toolCallId: string,
    toolName: string,
    rawArgs: Record<string, unknown>,
    signal?: AbortSignal,
    onProgress?: (update: ToolProgressUpdate) => void,
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();

    // 1. Look up tool in registry.
    const tool = this.registry.get(toolName);
    if (!tool) {
      return this.buildResult(
        toolCallId,
        toolName,
        errorResult(`Tool "${toolName}" not found`),
        startTime,
      );
    }

    // 2. Detect malformed JSON from the LLM provider (streaming truncation).
    if (rawArgs.__parse_error) {
      return this.buildResult(
        toolCallId,
        toolName,
        errorResult(
          'Tool call failed: the LLM returned incomplete JSON for the parameters ' +
          '(likely hit the max_tokens limit mid-generation). ' +
          'Please retry by writing the content in smaller pieces or reducing output size.',
        ),
        startTime,
      );
    }

    // 3. Validate parameters.
    let validatedParams: Record<string, unknown>;
    try {
      validatedParams = await this.validator.validate(tool.parameters, rawArgs);
    } catch (err) {
      if (err instanceof ToolValidationError) {
        return this.buildResult(
          toolCallId,
          toolName,
          errorResult(`Invalid parameters: ${err.message}`),
          startTime,
        );
      }
      return this.buildResult(
        toolCallId,
        toolName,
        errorResult(`Parameter validation error: ${err instanceof Error ? err.message : String(err)}`),
        startTime,
      );
    }

    // 4. Set up timeout and merged abort signal.
    const timeoutMs = this.timeoutOverrides[toolName] ?? this.defaultTimeout;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(TIMEOUT_REASON), timeoutMs);

    // Propagate external signal to our controller.
    const externalAbortHandler = () => {
      controller.abort(signal?.reason ?? new Error('aborted'));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timeoutId);
        return this.buildResult(
          toolCallId,
          toolName,
          errorResult('Execution aborted before start'),
          startTime,
        );
      }
      signal.addEventListener('abort', externalAbortHandler, { once: true });
    }

    // 5. Execute the tool.
    let result: ToolResult;
    try {
      const context: ToolExecutionContext = {
        signal: controller.signal,
        onProgress,
      };

      result = await tool.execute(toolCallId, validatedParams, context);
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        const isTimeout = controller.signal.reason === TIMEOUT_REASON;
        result = errorResult(
          isTimeout
            ? `Tool "${toolName}" timed out after ${timeoutMs}ms`
            : `Tool "${toolName}" was aborted`,
        );
      } else {
        const message = err instanceof Error ? err.message : String(err);
        result = errorResult(`Tool "${toolName}" threw an error: ${message}`);
      }
    } finally {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', externalAbortHandler);
      }
    }

    // 6. Truncate output if necessary.
    result = this.truncateResult(result);

    return this.buildResult(toolCallId, toolName, result, startTime);
  }

  // -----------------------------------------------------------------------
  // Internal Helpers
  // -----------------------------------------------------------------------

  /**
   * Truncate text content blocks that exceed `maxOutputSize` bytes.
   */
  private truncateResult(result: ToolResult): ToolResult {
    let totalSize = 0;

    for (const block of result.content) {
      if (block.type === 'text') {
        totalSize += Buffer.byteLength(block.text, 'utf-8');
      }
    }

    if (totalSize <= this.maxOutputSize) {
      return result;
    }

    // Rebuild content with truncated text blocks.
    let remainingBudget = this.maxOutputSize;
    const truncatedContent = result.content.map((block) => {
      if (block.type !== 'text') return block;

      const blockSize = Buffer.byteLength(block.text, 'utf-8');
      if (blockSize <= remainingBudget) {
        remainingBudget -= blockSize;
        return block;
      }

      // Truncate this block.
      if (remainingBudget <= 0) {
        return { type: 'text' as const, text: TRUNCATION_SUFFIX };
      }

      // Find a safe character boundary to cut at.
      const truncated = truncateUtf8(block.text, remainingBudget);
      remainingBudget = 0;
      return { type: 'text' as const, text: truncated + TRUNCATION_SUFFIX };
    });

    return {
      content: truncatedContent,
      isError: result.isError,
    };
  }

  /**
   * Build a ToolExecutionResult with computed duration and error flag.
   */
  private buildResult(
    toolCallId: string,
    toolName: string,
    result: ToolResult,
    startTime: number,
  ): ToolExecutionResult {
    return {
      result,
      duration: Date.now() - startTime,
      isError: result.isError === true,
      toolName,
      toolCallId,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Check whether an error is an AbortError (from AbortController.abort()).
 */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return true;
  if (err instanceof Error && err.name === 'AbortError') return true;
  return false;
}

/**
 * Truncate a UTF-8 string to fit within `maxBytes`, respecting
 * character boundaries.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;

  // Slice the buffer and decode — Node handles incomplete multibyte
  // sequences by replacing them, which is acceptable here.
  const sliced = buf.subarray(0, maxBytes);
  // Decode, stripping any replacement character at the end.
  let result = sliced.toString('utf-8');
  // Remove trailing replacement character if the slice broke a multibyte char.
  if (result.endsWith('\uFFFD')) {
    result = result.slice(0, -1);
  }
  return result;
}
