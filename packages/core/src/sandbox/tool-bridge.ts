/**
 * CodeAct Sandbox — Tool Bridge
 *
 * Bridges AgentTool instances into the isolated-vm sandbox as globally
 * available async functions. Only tools marked `bridgeable: true` are
 * injected. Each call is recorded for inclusion in ExecuteResult.toolCalls.
 */

import ivm from 'isolated-vm';
import type { AgentTool } from '../tools/types.js';
import type { SandboxToolCall } from './types.js';

/**
 * ToolBridge manages the injection of AgentTools into an isolated-vm
 * Context and records every tool invocation made from sandbox code.
 */
export class ToolBridge {
  private toolCalls: SandboxToolCall[] = [];

  constructor(
    private readonly tools: AgentTool[],
  ) {}

  /**
   * Inject all bridgeable tools as global async functions in the given context.
   *
   * For each tool with `bridgeable: true`, a global function is registered
   * using the tool's `bridgeName` (falling back to `name`). The sandbox
   * function signature is:
   *
   *   async function toolName(args: object): Promise<string>
   *
   * The host-side callback executes the real tool, records the call, and
   * returns the text result (or throws on error).
   */
  async injectAll(context: ivm.Context): Promise<void> {
    const bridgeableTools = this.tools.filter((t) => t.bridgeable);

    for (const tool of bridgeableTools) {
      await this.injectTool(context, tool);
    }
  }

  /** Return all tool call records accumulated since the last clear. */
  getToolCalls(): SandboxToolCall[] {
    return [...this.toolCalls];
  }

  /** Clear accumulated tool call records. Called before each execute(). */
  clearToolCalls(): void {
    this.toolCalls = [];
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Validate that a function name is a safe JavaScript identifier.
   * Prevents code injection via malicious tool names in evalClosure.
   */
  private static validateIdentifier(name: string): void {
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
      throw new Error(
        `Invalid bridge function name "${name}": must be a valid JS identifier (letters, digits, _, $)`,
      );
    }
  }

  private async injectTool(context: ivm.Context, tool: AgentTool): Promise<void> {
    const fnName = tool.bridgeName || tool.name;

    // SECURITY: Validate fnName is a safe identifier before interpolating into eval'd code.
    ToolBridge.validateIdentifier(fnName);

    // Host-side callback invoked when sandbox code calls the bridged function.
    const callback = new ivm.Reference(async (argsJson: string): Promise<string> => {
      const args = JSON.parse(argsJson) as Record<string, unknown>;
      const startTime = Date.now();

      try {
        const result = await tool.execute(
          `sandbox-${Date.now()}`,
          args,
          { signal: undefined },
        );

        const text = result.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { type: 'text'; text: string }).text)
          .join('\n');

        this.toolCalls.push({
          toolName: tool.name,
          args,
          result: text,
          duration: Date.now() - startTime,
        });

        return text;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.toolCalls.push({
          toolName: tool.name,
          args,
          error: errMsg,
          duration: Date.now() - startTime,
        });
        throw new Error(errMsg);
      }
    });

    // Register the async function in the sandbox's global scope.
    // $0 is the ivm.Reference to the host callback.
    // The sandbox function JSON-stringifies args before sending to host,
    // and awaits the promise returned by the host callback.
    await context.evalClosure(
      `globalThis.${fnName} = async function(args) {
        return await $0.apply(undefined, [JSON.stringify(args)], { result: { promise: true } });
      }`,
      [callback],
      { arguments: { reference: true } },
    );
  }
}
