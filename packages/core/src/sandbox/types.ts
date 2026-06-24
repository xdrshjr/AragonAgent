/**
 * CodeAct Sandbox — Type Definitions
 *
 * Interfaces for the isolated-vm JavaScript sandbox execution environment.
 * The sandbox enables CodeAct-style code execution: LLM-generated JavaScript
 * runs in a V8 Isolate with bridged tool access, console capture, and HTTP.
 */

import type { AgentTool } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Sandbox Configuration
// ---------------------------------------------------------------------------

/** Configuration for creating an IsolatedVmSandbox instance. */
export interface SandboxConfig {
  /** V8 Isolate memory limit in megabytes. Default: 128. */
  memoryLimitMB?: number;

  /** Default execution timeout in milliseconds. Default: 30_000. */
  defaultTimeout?: number;

  /** Tools to bridge into the sandbox as callable async functions. */
  tools?: AgentTool[];

  /**
   * Allowed hostnames for the HTTP bridge (fetch).
   * An empty array (default) means all HTTP requests are blocked.
   */
  allowedHosts?: string[];

  /** Pre-injected global variables available in the sandbox. */
  globals?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Execution Options & Results
// ---------------------------------------------------------------------------

/** Per-invocation options for CodeActSandbox.execute(). */
export interface ExecuteOptions {
  /** Execution timeout in milliseconds. Overrides SandboxConfig.defaultTimeout. */
  timeout?: number;

  /** AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
}

/** The result of a single code execution in the sandbox. */
export interface ExecuteResult {
  /** The serialized return value of the code (JSON string), or undefined on error / void. */
  returnValue?: string;

  /** Console output entries collected during execution, in chronological order. */
  consoleOutput: ConsoleEntry[];

  /** Error information if the execution failed. Absent on success. */
  error?: {
    name: string;
    message: string;
    stack?: string;
  };

  /** Wall-clock execution duration in milliseconds. */
  duration: number;

  /** Tool calls made during execution via the tool bridge. */
  toolCalls: SandboxToolCall[];
}

// ---------------------------------------------------------------------------
// Console Capture
// ---------------------------------------------------------------------------

/** A single captured console output entry. */
export interface ConsoleEntry {
  level: 'log' | 'warn' | 'error' | 'info';
  args: string[];
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Tool Call Record
// ---------------------------------------------------------------------------

/** Record of a single tool invocation made from within the sandbox. */
export interface SandboxToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
  /** Duration of the tool execution in milliseconds. */
  duration: number;
}

// ---------------------------------------------------------------------------
// Sandbox Interface
// ---------------------------------------------------------------------------

/**
 * The primary sandbox interface for executing JavaScript code in an
 * isolated V8 environment with bridged tool access.
 *
 * Lifecycle:
 *   1. Construct with config (lazy — no Isolate created yet)
 *   2. Call execute() — Isolate + Context created on first call
 *   3. Variables persist across execute() calls within the same Context
 *   4. Call reset() to clear all state (new Context, re-inject bridges)
 *   5. Call dispose() when done to release the V8 Isolate
 */
export interface CodeActSandbox {
  /** Execute JavaScript code in the sandbox. */
  execute(code: string, options?: ExecuteOptions): Promise<ExecuteResult>;

  /** Reset sandbox state: destroy current Context, create a fresh one, re-inject bridges. */
  reset(): Promise<void>;

  /** Dispose the sandbox and release the underlying V8 Isolate. */
  dispose(): void;

  /** Whether this sandbox has been disposed. All calls after disposal will throw. */
  get isDisposed(): boolean;
}
