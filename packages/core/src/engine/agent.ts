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
import type { ContextManager } from './context-manager.js';

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

  /**
   * Optional context manager (context-auto-compaction §4.1).
   *
   * `undefined` means the engine NEVER compacts and every code path is
   * byte-identical to a pre-feature build. THERE IS NO SETTER, deliberately: a
   * host implementation reads its own config live through closures (the idiom
   * `FastWiring` already uses), so the object handed in here can stay stable for
   * the `Agent`'s whole lifetime while the policy behind it changes mid-session.
   */
  contextManager?: ContextManager;

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
    /**
     * Ceiling on ONE `ContextManager.compact()` call (ms). Default: 120_000.
     *
     * EXPOSED ONLY SO AC-10a IS TESTABLE IN UNDER TWO MINUTES. It is not a host
     * policy knob — the whole point of the ceiling is that it does not depend on
     * the host being correct, and `compaction_start` pauses the idle watchdog, so
     * across the call this is the only clock running (P1-3 / R-13).
     */
    compactionHardTimeout?: number;
    /**
     * Per-tool ceilings keyed by tool name, overriding `toolTimeout`.
     *
     * READ THIS BEFORE RELYING ON IT: `ToolExecutor` expresses a timeout by
     * calling `controller.abort(...)` on the context signal and then continuing
     * to `await` the tool's promise — there is no `Promise.race`. A tool that
     * never observes `context.signal` is therefore never timed out, and any
     * number set here is inert for it. Tools that must honour a ceiling have to
     * subscribe to `context.signal` explicitly (see `bash-tool.ts` in the CLI
     * package for the house pattern).
     */
    toolTimeoutOverrides?: Record<string, number>;
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
  private readonly contextManager?: ContextManager;

  // --- LLM generation parameters ---
  private maxTokens: number | undefined;

  // --- Timeouts ---
  private readonly llmCallTimeout: number;
  private readonly idleTimeout: number;
  private readonly toolTimeout: number;
  private readonly codeTimeout: number;
  private readonly compactionHardTimeout: number | undefined;

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
    this.contextManager = config.contextManager;
    this.maxTokens = config.maxTokens;

    // Timeouts
    this.llmCallTimeout = config.timeouts?.llmCallTimeout ?? DEFAULT_LLM_CALL_TIMEOUT;
    this.idleTimeout = config.timeouts?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
    this.toolTimeout = config.timeouts?.toolTimeout ?? DEFAULT_TOOL_TIMEOUT;
    this.codeTimeout = config.timeouts?.codeTimeout ?? DEFAULT_CODE_TIMEOUT;
    this.compactionHardTimeout = config.timeouts?.compactionHardTimeout;

    // Register initial tools
    this.syncToolRegistry(config.tools);

    // Tool executor
    this.toolExecutor = new ToolExecutor(this.toolRegistry, {
      defaultTimeout: this.toolTimeout,
      ...(config.timeouts?.toolTimeoutOverrides
        ? { timeoutOverrides: config.timeouts.toolTimeoutOverrides }
        : {}),
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
  // Idle watchdog control
  //
  // Public because only the HOST knows that a tool is blocked on a human. The
  // engine sees an ordinary long-running tool call and would abort the run
  // after `idleTimeout` — which is right for a wedged network call and wrong
  // for a person reading a plan. Always pair these in a `try/finally`.
  // =========================================================================

  /** Suspend the idle watchdog (e.g. while a tool waits on a human). Idempotent. */
  pauseIdleWatchdog(): void {
    this.watchdog.pause();
  }

  /** Resume the idle watchdog and restart its window from now. Idempotent. */
  resumeIdleWatchdog(): void {
    this.watchdog.resume();
  }

  // =========================================================================
  // Internal
  // =========================================================================

  /**
   * Emit an event to all listeners and kick the watchdog.
   * Listener errors are caught and logged to prevent crashing the loop.
   */
  private emit(event: AgentEvent): void {
    // BEFORE THE LISTENERS. A listener that throws is caught below, but the
    // policy still has to have been applied — otherwise a bad subscriber leaves
    // the watchdog armed across a 30-second backoff and the run is aborted for
    // being "idle" while it is provably waiting on purpose.
    this.applyWatchdogPolicy(event);
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
   * Suspend the idle watchdog across a wait the ENGINE ITSELF scheduled, and
   * resume it when work moves again.
   *
   * TWO PAIRS, ONE POLICY (context-auto-compaction §3.3). Retry backoff was the
   * first (llm-api-retry-backoff §4.6); context compaction is the second, and it
   * is the reason this method lost the `Retry` in its name. Both are cases where
   * the run is provably waiting on purpose and the watchdog cannot tell that
   * apart from a wedged network call.
   *
   * `compaction_end` IS EMITTED FROM A `finally` IN `runCompaction`, on every
   * exit path including a throw, precisely so this `resume()` is unconditional.
   * A compaction whose `end` never arrived would leave the watchdog paused for
   * the rest of the run, with nothing anywhere reporting it (P1-3 / R-13).
   *
   * Both halves are idempotent, and `runLoopWithLifecycle`'s `finally` calls
   * `watchdog.stop()`, which clears `paused` — that is what bounds an abort
   * landing mid-wait.
   *
   * `withRetry` waits up to `maxDelayMs` between attempts and emits nothing while
   * it does. That is indistinguishable from a wedged network call to the
   * watchdog, which is right for a wedged call and wrong for a wait the engine
   * itself scheduled. `pause()` swallows the subsequent `kick()` by design and
   * `resume()` restarts the window from now; both are idempotent.
   *
   * A `retry_scheduled` never followed by a `retry_attempt` — an abort during the
   * wait — leaves the watchdog deaf, and that is bounded rather than leaked:
   * `runLoopWithLifecycle`'s `finally` calls `watchdog.stop()`, and `stop()`
   * clears `paused` for exactly this reason. DO NOT "simplify" that line out of
   * `stop()`.
   */
  private applyWatchdogPolicy(event: AgentEvent): void {
    if (event.type === 'compaction_start') {
      this.watchdog.pause();
      return;
    }
    if (event.type === 'compaction_end') {
      this.watchdog.resume();
      return;
    }
    if (event.type !== 'message_update') return;
    const t = event.streamEvent.type;
    if (t === 'retry_scheduled') this.watchdog.pause();
    else if (t === 'retry_attempt') this.watchdog.resume();
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
        // SPREAD, never `contextManager: this.contextManager`. With no manager the
        // loop context has no such key, so `if (!ctx.contextManager)` tests a field
        // that is genuinely absent rather than a property holding `undefined` —
        // which is what makes the byte-identity claim in AC-1 provable.
        ...(this.contextManager ? { contextManager: this.contextManager } : {}),
        signal: this.abortController.signal,
        timeouts: {
          llmCallTimeout: this.llmCallTimeout,
          toolTimeout: this.toolTimeout,
          codeTimeout: this.codeTimeout,
          ...(this.compactionHardTimeout !== undefined
            ? { compactionHardTimeout: this.compactionHardTimeout }
            : {}),
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
