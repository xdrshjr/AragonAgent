/**
 * AgentController — builds the core `Agent`, wires the built-in toolset, and
 * exposes a small run/abort/steer surface plus the pre-flight validation that
 * turns the most common failure (no API key) into a guided action instead of a
 * blank screen (spec §3.3.1 / R2).
 *
 * The controller never inspects the resolved promise of `agent.prompt()` for
 * success — that promise resolves even on failure. Success/failure is derived
 * from the event stream by the reducer (TUI) and the headless writer.
 */

import {
  Agent,
  initProviders,
  ModelRegistry,
  type AgentEvent,
  type AgentTool,
  type Message,
  type ModelInfo,
  type ModelRef,
  type ProviderRegistry,
  type ThinkingLevel,
} from '@argon-agent/core';
import type { CliConfig, ThemeName } from '../config/schema.js';
import { isAdapterProvider } from '../config/schema.js';
import { makeGetApiKey } from '../config/load.js';
import { createBuiltinTools, type ConfirmRequest } from '../tools/index.js';
import { buildSystemPrompt } from './system-prompt.js';

export interface ControllerDeps {
  /** Awaited before a mutating tool runs when `confirmTools` is enabled. */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
}

export interface PreflightResult {
  ok: boolean;
  message?: string;
  /** 'config' for a missing/invalid key or unusable provider. */
  kind?: 'config';
}

export class AgentController {
  private readonly agent: Agent;
  private readonly providerRegistry: ProviderRegistry;
  private readonly modelRegistry: ModelRegistry;
  private readonly tools: AgentTool[];

  /** Mutable session cwd — tools resolve relative paths against this. */
  private cwd: string;

  constructor(private config: CliConfig, deps: ControllerDeps = {}) {
    this.cwd = config.cwd;
    this.providerRegistry = initProviders();
    this.modelRegistry = new ModelRegistry(this.providerRegistry);

    this.tools = createBuiltinTools({
      getCwd: () => this.cwd,
      confirmTools: config.confirmTools,
      confirm: deps.confirm,
    });

    const model: ModelRef = {
      providerId: config.provider,
      modelId: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };

    this.agent = new Agent({
      systemPrompt: buildSystemPrompt({ cwd: this.cwd, tools: this.tools }),
      model,
      tools: this.tools,
      thinkingLevel: config.thinkingLevel,
      providerRegistry: this.providerRegistry,
      // Resolve the key dynamically so live edits (settings screen) take effect
      // without rebuilding the Agent — the closure reads the current config.
      getApiKey: (id) => this.resolveKey(id),
      maxTokens: config.maxTokens,
      timeouts: {
        // Timeout invariant (R1): idle ≥ tool so long tool runs are not killed.
        toolTimeout: config.toolTimeoutMs,
        idleTimeout: config.idleTimeoutMs,
      },
    });
  }

  private resolveKey(providerId: string): string | undefined {
    return makeGetApiKey(this.config)(providerId);
  }

  /**
   * Whether a usable API key exists for the given provider (default: active).
   * Read-only CLI-layer helper for the Header/Welcome key-status dot (P1-1);
   * does not touch `@argon-agent/core`.
   */
  hasApiKey(provider?: string): boolean {
    const key = this.resolveKey(provider ?? this.config.provider);
    return !!key && key.trim().length > 0;
  }

  /**
   * Set the color theme live. Mirrors the `setModel` / `setThinkingLevel`
   * mutator pattern — a subsequent re-render re-reads `getConfig().theme` and
   * re-memoizes the palette (P1-1). Does not touch `@argon-agent/core`.
   */
  setTheme(name: ThemeName): void {
    this.config = { ...this.config, theme: name };
  }

  /**
   * Advance the lifetime submit counter that drives the composer's progressive
   * disclosure (§4.6). Lives here rather than in React state so incrementing it
   * on every submit does not re-render the transcript.
   */
  setSubmitCount(n: number): void {
    this.config = { ...this.config, submitCount: n };
  }

  // -----------------------------------------------------------------------
  // Event subscription (delegates to the core Agent)
  // -----------------------------------------------------------------------

  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.agent.subscribe(listener);
  }

  // -----------------------------------------------------------------------
  // Pre-flight (R2): validate BEFORE entering the loop.
  // -----------------------------------------------------------------------

  preflight(): PreflightResult {
    const provider = this.config.provider;
    if (!isAdapterProvider(provider)) {
      return {
        ok: false,
        kind: 'config',
        message:
          `Provider "${provider}" has no adapter. Choose one of anthropic, openai, or google ` +
          '(open /settings or set --provider).',
      };
    }
    const key = makeGetApiKey(this.config)(provider);
    if (!key || key.trim().length === 0) {
      const envVar =
        provider === 'anthropic'
          ? 'ANTHROPIC_API_KEY'
          : provider === 'openai'
          ? 'OPENAI_API_KEY'
          : 'GOOGLE_API_KEY';
      return {
        ok: false,
        kind: 'config',
        message: `No API key for "${provider}" - open /settings or set ${envVar}.`,
      };
    }
    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Run lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start a run. Fire-and-forget for the TUI (events drive the UI); returns the
   * underlying promise so headless mode can await completion. `agent.prompt()`
   * never rejects, so callers must not treat resolution as success.
   */
  prompt(text: string): Promise<void> {
    return this.agent.prompt(text);
  }

  abort(): void {
    this.agent.abort();
  }

  steer(text: string): void {
    this.agent.steer(text);
  }

  followUp(text: string): void {
    this.agent.followUp(text);
  }

  isRunning(): boolean {
    return this.agent.state.isRunning;
  }

  // -----------------------------------------------------------------------
  // Mutators
  // -----------------------------------------------------------------------

  setModel(provider: string, model: string, baseUrl?: string): void {
    this.config = { ...this.config, provider, model, baseUrl };
    this.agent.setModel({ providerId: provider, modelId: model, ...(baseUrl ? { baseUrl } : {}) });
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.config = { ...this.config, thinkingLevel: level };
    this.agent.setThinkingLevel(level);
  }

  setMaxTokens(value: number | undefined): void {
    this.config = { ...this.config, maxTokens: value };
    this.agent.setMaxTokens(value);
  }

  setApiKey(provider: string, key: string): void {
    // The Agent resolves keys via `resolveKey(this.config)` at call time, so
    // updating the config here is sufficient — no Agent rebuild needed.
    this.config = {
      ...this.config,
      apiKeys: { ...this.config.apiKeys, [provider]: key },
    };
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.config = { ...this.config, cwd };
    // Refresh the system prompt so the model sees the new working directory.
    this.agent.setSystemPrompt(buildSystemPrompt({ cwd, tools: this.tools }));
  }

  getCwd(): string {
    return this.cwd;
  }

  clearMessages(): void {
    this.agent.clearMessages();
  }

  replaceMessages(messages: Message[]): void {
    this.agent.replaceMessages(messages);
  }

  getMessages(): Message[] {
    return this.agent.state.messages as Message[];
  }

  clearAllQueues(): void {
    this.agent.clearAllQueues();
  }

  // -----------------------------------------------------------------------
  // Model / provider info
  // -----------------------------------------------------------------------

  getConfig(): CliConfig {
    return this.config;
  }

  getProviderRegistry(): ProviderRegistry {
    return this.providerRegistry;
  }

  getModelRegistry(): ModelRegistry {
    return this.modelRegistry;
  }

  /** Resolve `ModelInfo` for the active model, falling back to a runtime model. */
  getModelInfo(): ModelInfo {
    const found = this.modelRegistry.getModel(this.config.provider, this.config.model);
    if (found) return found;
    return this.modelRegistry.buildRuntimeModel(this.config.provider, this.config.model);
  }

  /** List usable tools (name + description) for the /tools command. */
  listTools(): AgentTool[] {
    return this.tools;
  }
}
