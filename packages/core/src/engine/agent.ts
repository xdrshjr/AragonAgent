/**
 * Agent — the main class for the Agent engine.
 *
 * Wraps the agent loop, message management, steering/follow-up queues,
 * tool registry/executor, and idle watchdog into a single cohesive API
 * that provides a full agentic LLM execution engine.
 */

import type {
  Message,
  ThinkingLevel,
  UserMessage,
} from '../llm/types.js';
import type { ProviderRegistry } from '../llm/providers/index.js';
import type { AgentTool } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import type { AgentEvent, AgentEventListener } from '../types.js';
import { MessageManager } from './message-manager.js';
import { MessageQueueManager } from './steering.js';
import { IdleWatchdog } from './watchdog.js';
import { runAgentLoop } from './agent-loop.js';
import type { CodeActSandbox, ModelRef } from './agent-loop.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** The initial system prompt. */
  systemPrompt: string;

  /** Model reference (provider + model ID + optional base URL). */
  model: ModelRef;

  /** Tools available to the agent. */
  tools: AgentTool[];

  /** Extended thinking level (Anthropic). Defaults to 'off'. */
  thinkingLevel?: ThinkingLevel;

  /** The LLM provider registry for streaming completions. */
  providerRegistry: ProviderRegistry;

  /** Resolver for API keys by provider ID. */
  getApiKey: (providerId: string) => string | undefined;

  /** Optional CodeAct sandbox for JS code execution. */
  sandbox?: CodeActSandbox;

  /** Maximum output tokens per LLM call. `undefined` = use provider default. */
  maxTokens?: number;

  /** Timeout configuration. */
  timeouts?: {
    /** Single LLM call timeout (ms). Default: 300_000 (5 min). */
    llmCallTimeout?: number;
    /** Agent idle timeout — no events for this long triggers abort (ms). Default: 60_000 (60 s). */
    idleTimeout?: number;
    /** Per-tool execution timeout (ms). Default: 120_000 (2 min). */
    toolTimeout?: number;
    /** Code execution timeout (ms). Default: 30_000 (30 s). */
    codeTimeout?: number;
  };
}

// ---------------------------------------------------------------------------
// Agent State (readonly view)
// ---------------------------------------------------------------------------

export interface AgentState {
  readonly systemPrompt: string;
  readonly model: ModelRef;
  readonly thinkingLevel: ThinkingLevel;
  readonly tools: AgentTool[];
  readonly messages: readonly Message[];
  readonly isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Default timeouts
// ---------------------------------------------------------------------------

const DEFAULT_LLM_CALL_TIMEOUT = 300_000;
const DEFAULT_IDLE_TIMEOUT = 60_000;
const DEFAULT_TOOL_TIMEOUT = 120_000;
const DEFAULT_CODE_TIMEOUT = 30_000;

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export class Agent {
  // --- Internal components ---
  private readonly messageManager = new MessageManager();
  private readonly messageQueueManager = new MessageQueueManager();
  private readonly toolRegistry = new ToolRegistry();
  private readonly toolExecutor: ToolExecutor;
  private readonly watchdog: IdleWatchdog;
  private readonly listeners = new Set<AgentEventListener>();

  // --- Configuration (mutable via setters) ---
  private systemPrompt: string;
  private model: ModelRef;
  private thinkingLevel: ThinkingLevel;
  private currentTools: AgentTool[];
  private readonly providerRegistry: ProviderRegistry;
  private readonly getApiKeyFn: (providerId: string) => string | undefined;
  private readonly sandbox?: CodeActSandbox;

  // --- LLM generation parameters ---
  private maxTokens: number | undefined;

  // --- Timeouts ---
  private readonly llmCallTimeout: number;
  private readonly idleTimeout: number;
  private readonly toolTimeout: number;
  private readonly codeTimeout: number;

  // --- Runtime state ---
  private abortController: AbortController | null = null;
  private running = false;
  private idlePromiseResolvers: Array<() => void> = [];

  constructor(config: AgentConfig) {
    this.systemPrompt = config.systemPrompt;
    this.model = { ...config.model };
    this.thinkingLevel = config.thinkingLevel ?? 'off';
    this.currentTools = [...config.tools];
    this.providerRegistry = config.providerRegistry;
    this.getApiKeyFn = config.getApiKey;
    this.sandbox = config.sandbox;
    this.maxTokens = config.maxTokens;

    // Timeouts
    this.llmCallTimeout = config.timeouts?.llmCallTimeout ?? DEFAULT_LLM_CALL_TIMEOUT;
    this.idleTimeout = config.timeouts?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    this.toolTimeout = config.timeouts?.toolTimeout ?? DEFAULT_TOOL_TIMEOUT;
    this.codeTimeout = config.timeouts?.codeTimeout ?? DEFAULT_CODE_TIMEOUT;

    // Register initial tools
    this.syncToolRegistry(config.tools);

    // Tool executor
    this.toolExecutor = new ToolExecutor(this.toolRegistry, {
      defaultTimeout: this.toolTimeout,
    });

    // Watchdog — on timeout, abort the agent
    this.watchdog = new IdleWatchdog(this.idleTimeout, () => {
      console.error('[Agent] idle watchdog fired — aborting');
      this.abort();
    });
  }

  // =========================================================================
  // Public readonly state
  // =========================================================================

  get state(): AgentState {
    return {
      systemPrompt: this.systemPrompt,
      model: { ...this.model },
      thinkingLevel: this.thinkingLevel,
      tools: [...this.currentTools],
      messages: this.messageManager.getAll(),
      isRunning: this.running,
    };
  }

  // =========================================================================
  // Core methods
  // =========================================================================

  /**
   * Send a user message and run the Agent loop until completion.
   * Always emits `agent_start` at the beginning and `agent_end` at the end,
   * even if an error occurs.
   */
  async prompt(message: string | UserMessage): Promise<void> {
    if (this.running) {
      throw new Error('Agent is already running. Call abort() first or wait for idle.');
    }

    const userMessage: UserMessage =
      typeof message === 'string'
        ? { role: 'user', content: message, timestamp: Date.now() }
        : message;

    this.messageManager.push(userMessage);
    await this.runLoopWithLifecycle();
  }

  /**
   * Resume the Agent loop from the current message state.
   * Useful for retrying after an error without re-sending the user message.
   */
  async continue(): Promise<void> {
    if (this.running) {
      throw new Error('Agent is already running. Call abort() first or wait for idle.');
    }
    await this.runLoopWithLifecycle();
  }

  /** Abort the currently running Agent loop. */
  abort(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  /**
   * Wait until the Agent is idle (not running).
   * Resolves immediately if the Agent is already idle.
   */
  waitForIdle(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idlePromiseResolvers.push(resolve);
    });
  }

  // =========================================================================
  // Event subscription
  // =========================================================================

  /**
   * Subscribe to Agent events.
   * @returns An unsubscribe function.
   */
  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // =========================================================================
  // Message queues
  // =========================================================================

  /** Inject a high-priority steering message (interrupts tool execution). */
  steer(message: string): void {
    this.messageQueueManager.pushSteering(message);
  }

  /** Queue a low-priority follow-up message (consumed after end_turn). */
  followUp(message: string): void {
    this.messageQueueManager.pushFollowUp(message);
  }

  // =========================================================================
  // State mutation
  // =========================================================================

  setModel(model: ModelRef): void {
    this.model = { ...model };
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.thinkingLevel = level;
  }

  setMaxTokens(value: number | undefined): void {
    this.maxTokens = value;
  }

  setTools(tools: AgentTool[]): void {
    this.currentTools = [...tools];
    this.syncToolRegistry(tools);
  }

  clearMessages(): void {
    this.messageManager.clear();
  }

  /** Append a single message to the conversation history (used by direct-mode flows). */
  appendMessage(message: Message): void {
    this.messageManager.push(message);
  }

  /** Replace the entire message history (used when loading a conversation from DB). */
  replaceMessages(messages: Message[]): void {
    this.messageManager.restore(messages);
  }

  /** Clear both steering and follow-up message queues. */
  clearAllQueues(): void {
    this.messageQueueManager.clearAll();
  }

  // =========================================================================
  // Internal
  // =========================================================================

  /**
   * Emit an event to all listeners and kick the watchdog.
   * Listener errors are caught and logged to prevent crashing the loop.
   */
  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[Agent] listener error:', err);
      }
    }
    this.watchdog.kick();
  }

  /**
   * Synchronize the ToolRegistry with the provided tool array.
   * Removes tools no longer present and adds new ones.
   */
  private syncToolRegistry(tools: AgentTool[]): void {
    const newNames = new Set(tools.map((t) => t.name));

    // Remove tools no longer in the set.
    for (const existing of this.toolRegistry.getAll()) {
      if (!newNames.has(existing.name)) {
        this.toolRegistry.unregister(existing.name);
      }
    }

    // Add or update tools.
    for (const tool of tools) {
      if (this.toolRegistry.has(tool.name)) {
        // Unregister and re-register to update the definition.
        this.toolRegistry.unregister(tool.name);
      }
      this.toolRegistry.register(tool);
    }
  }

  /**
   * Run the agent loop wrapped with lifecycle events and error handling.
   * Guarantees: agent_start is emitted first, agent_end is always emitted
   * in the finally block, and the watchdog is always stopped.
   */
  private async runLoopWithLifecycle(): Promise<void> {
    this.running = true;
    this.abortController = new AbortController();
    this.watchdog.start();

    this.emit({ type: 'agent_start' });

    try {
      await runAgentLoop({
        providerRegistry: this.providerRegistry,
        toolRegistry: this.toolRegistry,
        toolExecutor: this.toolExecutor,
        messageManager: this.messageManager,
        messageQueueManager: this.messageQueueManager,
        getApiKey: this.getApiKeyFn,
        emit: (event) => this.emit(event),
        sandbox: this.sandbox,
        model: this.model,
        systemPrompt: this.systemPrompt,
        thinkingLevel: this.thinkingLevel,
        maxTokens: this.maxTokens,
        signal: this.abortController.signal,
        timeouts: {
          llmCallTimeout: this.llmCallTimeout,
          toolTimeout: this.toolTimeout,
          codeTimeout: this.codeTimeout,
        },
      });
    } catch (err) {
      console.error('[Agent] loop error:', err);
    } finally {
      this.watchdog.stop();
      this.running = false;
      this.abortController = null;

      this.emit({
        type: 'agent_end',
        messages: this.messageManager.getAll() as Message[],
      });

      // Resolve all pending waitForIdle() callers.
      for (const resolve of this.idlePromiseResolvers) {
        resolve();
      }
      this.idlePromiseResolvers = [];
    }
  }
}
