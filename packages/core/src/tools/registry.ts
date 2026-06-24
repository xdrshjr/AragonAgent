/**
 * Tool System — Tool Registry
 *
 * Manages dynamic registration and lookup of AgentTools.
 * Supports change notification so consumers (e.g. the Agent engine)
 * can react when tools are added or removed at runtime.
 */

import type {
  AgentTool,
  ToolDefinition,
  ToolRegistryEvent,
} from './types.js';

/** Listener callback type for registry change events. */
export type ToolRegistryListener = (event: ToolRegistryEvent) => void;

/**
 * A registry that holds AgentTool instances indexed by name.
 * Provides lookup, filtering, and LLM tool-definition export.
 */
export class ToolRegistry {
  /** Internal tool storage, keyed by tool name. */
  private readonly tools = new Map<string, AgentTool>();

  /** Registered change listeners. */
  private readonly listeners = new Set<ToolRegistryListener>();

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Register a single tool. Throws if a tool with the same name
   * is already registered.
   */
  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(
        `ToolRegistry: tool "${tool.name}" is already registered. ` +
        'Unregister it first or use a different name.',
      );
    }
    this.tools.set(tool.name, tool);
    this.emit({ type: 'registered', tool });
  }

  /**
   * Register multiple tools at once. Throws on the first duplicate
   * name encountered (tools registered before the error remain).
   */
  registerAll(tools: AgentTool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Remove a tool by name.
   * @returns `true` if the tool existed and was removed; `false` otherwise.
   */
  unregister(name: string): boolean {
    const existed = this.tools.delete(name);
    if (existed) {
      this.emit({ type: 'unregistered', name });
    }
    return existed;
  }

  // -----------------------------------------------------------------------
  // Lookup
  // -----------------------------------------------------------------------

  /** Retrieve a tool by name, or `undefined` if not found. */
  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  /** Return all registered tools as an array (snapshot). */
  getAll(): AgentTool[] {
    return Array.from(this.tools.values());
  }

  /** Return tools that include the specified tag. */
  getByTag(tag: string): AgentTool[] {
    return this.getAll().filter(
      (t) => t.tags !== undefined && t.tags.includes(tag),
    );
  }

  /** Return tools marked as bridgeable (for CodeAct sandbox). */
  getBridgeable(): AgentTool[] {
    return this.getAll().filter((t) => t.bridgeable === true);
  }

  /** Check whether a tool with the given name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Number of registered tools. */
  get size(): number {
    return this.tools.size;
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  /**
   * Export all registered tools as provider-agnostic ToolDefinitions
   * suitable for passing to any LLM provider adapter.
   */
  toToolDefinitions(): ToolDefinition[] {
    return this.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  // -----------------------------------------------------------------------
  // Change Notification
  // -----------------------------------------------------------------------

  /**
   * Subscribe to registry change events.
   * @returns An unsubscribe function.
   */
  onChange(listener: ToolRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private emit(event: ToolRegistryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors to avoid disrupting the registry.
      }
    }
  }
}
