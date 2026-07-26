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
import type { CliConfig, SkillsConfig, ThemeName } from '../config/schema.js';
import { isAdapterProvider } from '../config/schema.js';
import { makeGetApiKey } from '../config/load.js';
import { updatePersistedConfig } from '../config/store.js';
import { createBuiltinTools, type ConfirmRequest } from '../tools/index.js';
import { createNodeSkillHost } from '../skills/node-host.js';
import { SkillService, type ApprovalGate } from '../skills/service.js';
import { createSkillTools } from '../skills/tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { NoticeLevel } from './reducer.js';

/** Approval gate used whenever there is provably no human to ask (headless). */
export const DENY_ALL_APPROVAL: ApprovalGate = {
  canPrompt: () => false,
  request: async () => false,
};

export interface ControllerDeps {
  /** Awaited before a mutating tool runs when `confirmTools` is enabled. */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
  /**
   * Skill-install approval (§8.3.1 / D17). Distinct from `confirm` on purpose:
   * that callback auto-approves when unattached, which is a sane default for
   * `--confirm`-gated mutating tools and a silent security hole for skills.
   * Defaults to deny-all, so forgetting to pass one fails CLOSED.
   */
  approval?: ApprovalGate;
  /**
   * CLI version stamped into `.argon-skill.json` and the install User-Agent.
   * Without it an agent-initiated install records `installer: "0.0.0"` while the
   * same install through `/skills` or `aragon skills` records the real version —
   * so provenance would depend on who started it, which is exactly the question
   * `/skills info` exists to answer.
   */
  version?: string;
  /** Called after the skill set changes so the UI can rebuild its commands. */
  onSkillsChanged?: () => void;
  /** Transcript notices from the skill subsystem. */
  notify?: (level: NoticeLevel, text: string) => void;
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
  private readonly skills: SkillService;
  private readonly skillsEnabled: boolean;
  private onSkillsChanged?: () => void;

  /** Mutable session cwd — tools resolve relative paths against this. */
  private cwd: string;

  constructor(private config: CliConfig, deps: ControllerDeps = {}) {
    this.cwd = config.cwd;
    this.providerRegistry = initProviders();
    this.modelRegistry = new ModelRegistry(this.providerRegistry);
    this.skillsEnabled = config.skills.enabled;
    this.onSkillsChanged = deps.onSkillsChanged;

    this.skills = new SkillService({
      host: createNodeSkillHost(),
      getCwd: () => this.cwd,
      config: config.skills,
      runtime: config.skillsRuntime,
      // Fail-closed by default (D17): a missing gate must never mean "approved".
      approval: deps.approval ?? DENY_ALL_APPROVAL,
      onChange: () => this.refreshSkills(),
      ...(deps.notify ? { notify: deps.notify } : {}),
      persist: (patch: Partial<SkillsConfig>) => {
        try {
          updatePersistedConfig({ skills: patch as SkillsConfig });
        } catch {
          // Best-effort: a failed persist must not break the live session.
        }
      },
    });
    if (this.skillsEnabled) {
      this.skills.discover();
      this.skills.reportUnknownForcedSkills();
    }

    this.tools = createBuiltinTools({
      getCwd: () => this.cwd,
      confirmTools: config.confirmTools,
      confirm: deps.confirm,
      // `--no-skills` yields an empty array, so the tool list is byte-identical
      // to the pre-Skills seven (invariant I-S1 / AC-10).
      skillTools: this.skillsEnabled
        ? createSkillTools(this.skills, deps.version, () => this.toolNames())
        : [],
      // Omitted entirely when skills are off, which is what leaves the seven
      // built-ins unwrapped and AC-G17 provable by object identity.
      ...(this.skillsEnabled
        ? {
            toolPolicy: () => this.skills.toolPolicyDecision(() => this.toolNames()),
            onToolPolicyEvent: (e) => this.skills.reportToolPolicyEvent(e),
          }
        : {}),
    });

    const model: ModelRef = {
      providerId: config.provider,
      modelId: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    };

    this.agent = new Agent({
      systemPrompt: this.composeSystemPrompt(),
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
   * The tool names registered right now — LAZY, and the laziness is required.
   *
   * `this.skills.discover()` runs during construction, before `this.tools` is
   * assigned, and the closure handed to `createBuiltinTools` is invoked later
   * still. Reading `this.tools` eagerly would capture `undefined`; reading it
   * through this getter yields `[]` in that window, which `computeToolPolicy`
   * handles by design (I-G1: no registered tools means no ceiling, never an
   * empty permitted set).
   *
   * The same ordering is why tool-name resolution must NOT move into
   * `validateSkillFrontmatter()`: that runs inside `discover()`, when the tool
   * list does not exist yet, and would report every skill as unresolvable.
   * `doctor` carries that check instead (§5.7).
   */
  private toolNames(): string[] {
    return this.tools?.map((t) => t.name) ?? [];
  }

  // -----------------------------------------------------------------------
  // System prompt — invariant I-S2 (§6.3.1 / P1-1 / C3)
  //
  // `agent.setSystemPrompt()` is called from EXACTLY ONE place in this class:
  // `rebuildSystemPrompt()`. Before Skills existed, `setCwd()` built its own
  // prompt inline; leaving it that way meant any rescan-then-setCwd ordering
  // would drop `<available_skills>` with no error, no log, and no plausible
  // connection between the user's action (`/cwd ..`) and the symptom (the model
  // suddenly denies having any skills). Structure, not call ordering, is what
  // rules that out — so if you add a third caller, route it through here.
  // -----------------------------------------------------------------------

  private composeSystemPrompt(): string {
    return buildSystemPrompt({
      cwd: this.cwd,
      tools: this.tools,
      skillsBlock: this.skillsEnabled ? this.skills.catalogBlock() + this.skills.alwaysBlock() : '',
    });
  }

  private rebuildSystemPrompt(): void {
    this.agent.setSystemPrompt(this.composeSystemPrompt());
  }

  /** Re-render the prompt from the current skill set and tell the UI. */
  refreshSkills(): void {
    this.rebuildSystemPrompt();
    this.onSkillsChanged?.();
  }

  getSkillService(): SkillService {
    return this.skills;
  }

  /** Let the UI attach its handler after construction (App mounts later). */
  setOnSkillsChanged(handler: () => void): void {
    this.onSkillsChanged = handler;
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
    // A new user message is a new intent, so the previous turn's tool ceiling
    // expires here and anything a slash command queued is promoted (D-G1 / D-G2).
    // This and `steer()` below are the ONLY two places a user message enters the
    // engine, which is what makes a per-turn scope implementable at all (FG9).
    if (this.skillsEnabled) this.skills.beginUserTurn();
    return this.agent.prompt(text);
  }

  abort(): void {
    this.agent.abort();
  }

  steer(text: string): void {
    // Mid-run interjection: promote the queue, keep what is already in force
    // (D-G3). Clearing here would make "ask a follow-up" the way around the
    // ceiling; skipping the promotion would miss slash commands, which the TUI
    // routes through `steer` whenever the agent happens to be running.
    if (this.skillsEnabled) this.skills.absorbPendingFrames();
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
    // The project scope moved with the cwd, so rescan BEFORE rebuilding — then
    // let the single prompt entry point emit a prompt that reflects both the new
    // directory and the new skill set (I-S2 / AC-17).
    if (this.skillsEnabled) this.skills.discover();
    this.rebuildSystemPrompt();
    this.onSkillsChanged?.();
  }

  getCwd(): string {
    return this.cwd;
  }

  clearMessages(): void {
    this.agent.clearMessages();
    // A new conversation has no loaded skills, so the "already loaded earlier
    // in this conversation" hint would otherwise start lying (P2-9).
    this.skills.getRegistry().clearActive();
  }

  /** Read-only view of the live system prompt (regression tests, /debug). */
  getSystemPrompt(): string {
    return this.agent.state.systemPrompt;
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
