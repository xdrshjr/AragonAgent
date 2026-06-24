/**
 * CodeAct Sandbox — IsolatedVmSandbox
 *
 * Primary implementation of the CodeActSandbox interface using the
 * `isolated-vm` package. Provides a memory-limited, time-limited V8
 * Isolate with bridged tool access, console capture, and HTTP fetch.
 *
 * Key design decisions:
 *   - Lazy initialization: the V8 Isolate is not created until first execute().
 *   - Variable persistence: the same Context is reused across execute() calls
 *     so variables defined in one call are available in subsequent calls.
 *   - reset() destroys the Context and re-creates it (clears all variables).
 *   - dispose() releases the Isolate entirely.
 */

import ivm from 'isolated-vm';
import type {
  CodeActSandbox,
  ExecuteOptions,
  ExecuteResult,
  SandboxConfig,
} from './types.js';
import { ConsoleCapture } from './console-capture.js';
import { ToolBridge } from './tool-bridge.js';
import { HttpBridge } from './http-bridge.js';
import type { AgentTool } from '../tools/types.js';

/** Default V8 Isolate memory limit (megabytes). */
const DEFAULT_MEMORY_LIMIT_MB = 128;

/** Default per-execution timeout (milliseconds). */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * IsolatedVmSandbox executes LLM-generated JavaScript code in an isolated
 * V8 environment with injected tool bridges, console capture, and HTTP access.
 */
export class IsolatedVmSandbox implements CodeActSandbox {
  private isolate: ivm.Isolate | null = null;
  private context: ivm.Context | null = null;
  private disposed = false;

  private readonly memoryLimitMB: number;
  private readonly defaultTimeout: number;
  private readonly tools: AgentTool[];
  private readonly allowedHosts: string[];
  private readonly globals: Record<string, unknown>;

  // Bridge instances — recreated on reset().
  private consoleCapture: ConsoleCapture | null = null;
  private toolBridge: ToolBridge | null = null;
  private httpBridge: HttpBridge | null = null;

  constructor(config: SandboxConfig = {}) {
    this.memoryLimitMB = config.memoryLimitMB ?? DEFAULT_MEMORY_LIMIT_MB;
    this.defaultTimeout = config.defaultTimeout ?? DEFAULT_TIMEOUT_MS;
    this.tools = config.tools ?? [];
    this.allowedHosts = config.allowedHosts ?? [];
    this.globals = config.globals ?? {};
  }

  // ---------------------------------------------------------------------------
  // CodeActSandbox interface
  // ---------------------------------------------------------------------------

  get isDisposed(): boolean {
    return this.disposed;
  }

  async execute(code: string, options?: ExecuteOptions): Promise<ExecuteResult> {
    this.assertNotDisposed();

    // Lazy initialization on first execute().
    if (!this.isolate) {
      await this.initialize();
    }

    // Honor AbortSignal if already aborted.
    if (options?.signal?.aborted) {
      return {
        consoleOutput: [],
        error: { name: 'AbortError', message: 'Execution aborted before start' },
        duration: 0,
        toolCalls: [],
      };
    }

    const timeout = options?.timeout ?? this.defaultTimeout;
    const startTime = Date.now();

    // Clear per-execution state.
    this.toolBridge!.clearToolCalls();

    // Wrap user code in an async IIFE for top-level await support.
    const wrappedCode = wrapCode(code);

    try {
      // Use context.eval with promise:true to support async code.
      const rawResult = await this.context!.eval(wrappedCode, {
        timeout,
        promise: true,
      });

      // Serialize the return value. Handle non-serializable values gracefully.
      let returnValue: string | undefined;
      if (rawResult !== undefined && rawResult !== null) {
        try {
          returnValue = typeof rawResult === 'string'
            ? rawResult
            : JSON.stringify(rawResult);
        } catch {
          returnValue = String(rawResult);
        }
      }

      return {
        returnValue,
        consoleOutput: this.consoleCapture!.drain(),
        duration: Date.now() - startTime,
        toolCalls: this.toolBridge!.getToolCalls(),
      };
    } catch (err) {
      const errorInfo = extractErrorInfo(err);
      return {
        consoleOutput: this.consoleCapture!.drain(),
        error: errorInfo,
        duration: Date.now() - startTime,
        toolCalls: this.toolBridge!.getToolCalls(),
      };
    }
  }

  async reset(): Promise<void> {
    this.assertNotDisposed();

    if (!this.isolate) {
      // Not yet initialized — nothing to reset.
      return;
    }

    // Release the current context.
    if (this.context) {
      this.context.release();
      this.context = null;
    }

    // Create a fresh context and re-inject all bridges.
    await this.createContextAndInjectBridges();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.context) {
      this.context.release();
      this.context = null;
    }
    if (this.isolate) {
      this.isolate.dispose();
      this.isolate = null;
    }

    this.consoleCapture = null;
    this.toolBridge = null;
    this.httpBridge = null;
  }

  // ---------------------------------------------------------------------------
  // Private — Initialization
  // ---------------------------------------------------------------------------

  /** Full lazy initialization: create Isolate, Context, and inject bridges. */
  private async initialize(): Promise<void> {
    this.isolate = new ivm.Isolate({ memoryLimit: this.memoryLimitMB });
    await this.createContextAndInjectBridges();
  }

  /**
   * Create a new Context within the existing Isolate and inject all
   * bridges (console, tools, HTTP, globals).
   */
  private async createContextAndInjectBridges(): Promise<void> {
    this.context = await this.isolate!.createContext();

    // --- Console capture ---
    this.consoleCapture = new ConsoleCapture();
    await this.consoleCapture.inject(this.context);

    // --- Tool bridge ---
    this.toolBridge = new ToolBridge(this.tools);
    await this.toolBridge.injectAll(this.context);

    // --- HTTP bridge ---
    this.httpBridge = new HttpBridge({ allowedHosts: this.allowedHosts });
    await this.httpBridge.inject(this.context);

    // --- Pre-injected globals ---
    await this.injectGlobals();
  }

  /** Validate that a name is a safe JavaScript identifier. */
  private static validateIdentifier(name: string): void {
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
      throw new Error(
        `Invalid global variable name "${name}": must be a valid JS identifier`,
      );
    }
  }

  /** Inject user-provided global variables into the sandbox context. */
  private async injectGlobals(): Promise<void> {
    const jail = this.context!.global;

    for (const [key, value] of Object.entries(this.globals)) {
      // SECURITY: Validate key is a safe identifier before interpolating into eval'd code.
      IsolatedVmSandbox.validateIdentifier(key);

      // Only primitive values and JSON-serializable objects can be transferred.
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        await jail.set(key, value);
      } else if (value === null || value === undefined) {
        await jail.set(key, value ?? null);
      } else {
        // Serialize complex values as JSON and parse inside sandbox.
        const json = JSON.stringify(value);
        await this.context!.eval(`globalThis.${key} = ${json};`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — Helpers
  // ---------------------------------------------------------------------------

  /** Throw immediately if the sandbox has been disposed. */
  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('Cannot use a disposed CodeActSandbox');
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Wrap user code in an async IIFE so top-level `await` and `return` work.
 */
function wrapCode(userCode: string): string {
  return `(async () => {\n${userCode}\n})()`;
}

/**
 * Extract a structured error object from an unknown thrown value.
 * Handles isolated-vm timeout errors, memory errors, and generic JS errors.
 */
function extractErrorInfo(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
  }
  return {
    name: 'Error',
    message: String(err),
  };
}
