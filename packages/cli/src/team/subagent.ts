/**
 * `createSubagent` — one child `Agent`, its tool set, and the instrumentation
 * that turns core events into a `SubagentRun` (team-subagents §3.4).
 *
 * ASCII ONLY: `src/team/**` is inside the glyph scanner's scope.
 *
 * A CHILD IS BUILT FROM THE SAME FACTORY THE LEAD USES. That is the point: the
 * `--confirm` gate, the skills ceiling and the plan-mode gate are re-applied one
 * level down by the same wrappers, so delegation cannot be a way around any of
 * them (§3.11 / R-6). What a child does NOT get is spelled out below, and each
 * omission has a reason that is a correctness boundary rather than caution.
 */

import type { ModelRole } from '../config/model-profiles.js';
import {
  Agent,
  createSkillFindTool,
  type AgentConfig,
  type AgentEvent,
  type AgentTool,
  type AssistantMessage,
  type Message,
  type ModelRef,
  type ProviderRegistry,
  type SkillRegistry,
  type TokenUsage,
  type ToolPolicyDecision,
  type ToolPolicyVerdict,
} from '@aragon-agent/core';
import type { AgentMode } from '../agent/agent-mode.js';
import type { ChildContextManagerProvider } from '../compaction/child.js';
import { formatStreamError } from '../agent/reducer.js';
import { buildSystemPrompt } from '../agent/system-prompt.js';
import { buildFastBlock } from '../fast/prompt.js';
import { createBuiltinTools, type ConfirmRequest } from '../tools/index.js';
import type { CliConfig } from '../config/schema.js';
import type { ToolPermission } from '../exec/permission.js';
import { pickActivityArgs, sanitizeActivity } from './activity.js';
import type { ChildReviewProvider } from './child-reviewer.js';
import { TEAM_LIMITS, TEAM_SUBAGENT_TOOL_NAMES } from './limits.js';
import { isRetryableStreamError } from './retry.js';
import { TeamBus } from './bus.js';
import { makeTeamSend, makeTeamWait, withMailboxTail } from './comm-tools.js';
import type { TeamHumanQueue, WatchdogPausable } from './human-queue.js';
import { buildSubagentBlock } from './prompt.js';
import type { OverseerVerdict, SubagentRun, SubagentSpec } from './types.js';

/**
 * The slice of `Agent` a child is used through.
 *
 * Structural rather than the concrete class so `TeamRuntime` can be handed a
 * stub factory and the whole scheduler can be tested without a network — the
 * same seam `HeadlessController` already uses.
 */
export interface SubagentAgentLike extends WatchdogPausable {
  prompt(text: string): Promise<void>;
  abort(): void;
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /** Steering surface for the child's own fast reviewer (core `Agent.steer`). */
  steer(text: string): void;
  /** Queued-block hygiene on abort, again mirroring the lead (D-21). */
  clearAllQueues(): void;
  /**
   * The child's live history, for its own context manager
   * (context-auto-compaction-hardening §3.4.3 / W3).
   *
   * NARROWED ON PURPOSE. `Agent` satisfies this with its full `AgentState`
   * getter and a stub satisfies it with `{ messages: [] }`. Widening it to
   * `AgentState` would make every test stub fabricate a systemPrompt, a model and
   * a phase to compile, for fields none of them use.
   *
   * A PROPERTY READ, NOT A METHOD CALL, AND THAT IS NOT A STYLE CHOICE: core's
   * `Agent` has NO `getMessages()`. It exposes `get state(): AgentState`;
   * `AgentController.getMessages()` is the CONTROLLER's own one-line forwarder
   * over `this.agent.state.messages`. Adding a method to the engine to serve a
   * host-side convenience would move the core export surface for nothing.
   */
  readonly state: { readonly messages: readonly Message[] };
}

export type SubagentAgentFactory = (config: AgentConfig) => SubagentAgentLike;

/** The default factory: a real `Agent` from `@aragon-agent/core`. */
export const defaultSubagentFactory: SubagentAgentFactory = (config) => new Agent(config);

/** Everything a child needs that is the same for every child in a dispatch. */
export interface SubagentDeps {
  bus: TeamBus;
  config: CliConfig;
  providerRegistry: ProviderRegistry;
  getCwd: () => string;
  /** The lead's live session mode. Read at CALL time, never cached. */
  getMode: () => AgentMode;
  getApiKey: (providerId: string, role?: ModelRole) => string | undefined;
  /**
   * The lead's `SkillRegistry`, used for `skill_find` ONLY.
   *
   * `undefined` when skills are off, in which case the child gets no skill tool
   * at all — the same shape `--no-skills` produces for the lead.
   */
  skillRegistry?: SkillRegistry;
  /** The lead's always-on skill bodies, spliced into every child's prompt. */
  alwaysBlock?: string;
  toolPolicy?: () => ToolPolicyDecision;
  /**
   * The lead's `aragon exec` tool policy (cli-integration-surface §4.2
   * invariant 3). TIGHTENING ONLY, exactly as `spec.readOnly` is: there is no
   * field anywhere that gives a child more permission than the session it was
   * spawned from.
   *
   * `team_send` / `team_wait` survive it unconditionally — the exemption lives
   * inside `ToolPermission.isAllowed`, not here, so every caller gets it and no
   * second list of the same two names exists (P1-3).
   */
  permission?: ToolPermission;
  /** Already label-decorating; see `TeamRuntime` (§3.11 / P1-3). */
  onChildToolPolicyEvent?: (e: {
    label: string;
    tool: string;
    verdict: ToolPolicyVerdict;
    sourceNames: string[];
  }) => void;
  confirmTools: boolean;
  /** Present only when `--confirm` is on AND a human channel exists. */
  humanQueue?: TeamHumanQueue;
  agentFactory: SubagentAgentFactory;
  /**
   * Whether the dispatch supervisor is live for THIS dispatch
   * (team-overseer). Read once per dispatch by the runtime and spread here;
   * when true the child's OWN idle watchdog is lengthened by
   * `TEAM_LIMITS.overseerWatchdogFactor`, so the supervisor's soft silence
   * inspection at `idleTimeoutMs` always precedes the hard abort.
   */
  overseerActive?: boolean;
  /**
   * Per-child fast review (main-agent parity): the controller's shared
   * provider, built on the lead's `FastWiring`. ABSENT means the session
   * has no fast wiring, and the child is then exactly what it always was.
   */
  review?: ChildReviewProvider;
  /**
   * Build this child its own context manager
   * (context-auto-compaction-hardening §3.4.3 / W3).
   *
   * ABSENT means children get none, and `subagent.ts` then spreads NO
   * `contextManager` key at all - so the child's loop gate tests a genuinely
   * undefined field and a `compaction.subagents: false` session is byte-identical
   * to round 1 (AC-H10). `AgentController` supplies it from
   * `CompactionWiring.childFactory()`, which returns `null` when the key is off.
   */
  contextManagerFor?: ChildContextManagerProvider;
}

export interface SubagentHooks {
  /** Coalesced at the source (§5.2); phase transitions always pass. */
  onUpdate: (run: SubagentRun) => void;
  onUsage: (label: string, usage: TokenUsage) => void;
  /**
   * UNTHROTTLED per-event callback (team-overseer I-OV3). `onUpdate` is
   * coalesced, so it would lie about silence; the supervisor's soft stall
   * timer needs one kick per REAL agent event. Called after the phase switch
   * so the phase read at fire time is current.
   */
  onActivity?: () => void;
}

export interface SubagentHandle {
  spec: SubagentSpec;
  run: SubagentRun;
  agent: SubagentAgentLike;
  tools: AgentTool[];
  /**
   * THE HANDLE-LEVEL ABORT, and the only one `TeamRuntime` may call. It sets a
   * synchronous `abortRequested` flag BEFORE `agent.abort()`, which is what the
   * child's fast reviewer reads as its guard-1 fact: an Esc or a dispatch stop
   * must be visible to the reviewer in the same tick it happens, or the
   * reviewer steers a `<fast_review>` block into a run that is already dying.
   */
  abort: () => void;
  /**
   * Whether `abort()` has been called on this handle (team-overseer
   * I-OV4): the supervisor reads it before steering a nudge, so advice is
   * never queued into a child that is already dying - the same guard-1 fact
   * the child's own fast reviewer reads.
   */
  isAborted: () => boolean;
  /**
   * A terminal supervisor decision awaiting application by the WORKER LOOP
   * (team-overseer I-OV1). Written by `TeamRuntime` immediately before
   * `abort()`; read by `runOne` after `prompt()` resolves. NEVER cleared,
   * so an abort racing the read cannot hide the cause.
   */
  overseerVerdict?: OverseerVerdict;
  unsubscribe: () => void;
}

/** The final assistant text of a turn, or `''` when the turn was tool calls only. */
function assistantText(message: AssistantMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return '';
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('').trim();
}

/**
 * Build a child's tool array.
 *
 * Exported so `team-tool-gate.test.ts` can assert what a child may and may not
 * call without constructing an `Agent` or reaching a network — the tool set IS
 * the security boundary here, so it has to be directly checkable.
 */
export function buildSubagentTools(
  spec: SubagentSpec,
  deps: SubagentDeps,
  getAgent: () => WatchdogPausable | null,
): AgentTool[] {
  // `team_wait`'s ceiling is the STRUCTURAL clamp when the child itself has no
  // wall clock (`subagentTimeoutMs: 0`): a peer wait must stay bounded even when
  // the child's run is not, or one forgotten wait would hold a slot forever.
  const subagentTimeoutMs = deps.config.team.subagentTimeoutMs;
  const commTools = [
    makeTeamSend(deps.bus, spec.label),
    makeTeamWait(deps.bus, spec.label, {
      getAgent,
      maxWaitMs:
        subagentTimeoutMs > 0
          ? subagentTimeoutMs
          : TEAM_LIMITS.waitMaxSeconds * 1000,
    }),
  ];

  const tools = createBuiltinTools({
    getCwd: deps.getCwd,
    confirmTools: deps.confirmTools,
    // Queued through the ONE human slot, with this child's watchdog paused for
    // the whole queue wait (§3.11 / I-4 / P0-4).
    ...(deps.confirmTools && deps.humanQueue
      ? {
          // `req.signal` is the CHILD's `ctx.signal`, carried through
          // `ConfirmRequest` because `withConfirmation` is the only frame that
          // holds it. Without it an abort mid-dispatch would still pop a dialog
          // for every request left in the FIFO, one after another, at a user who
          // has just pressed Esc — AC-16's "leaves nothing pending" would hold
          // for the queue's unit test and not for the session.
          confirm: (req: ConfirmRequest) =>
            deps.humanQueue!.request(getAgent(), spec.label, req, req.signal),
        }
      : {}),
    // `skill_find` ONLY, and this is a CORRECTNESS BOUNDARY rather than
    // conservatism (D-16 / P0-3 / R-16). `skill_find` is a pure registry lookup.
    // `skill` is not: `createSkillTool` calls `enterFrame()` on the registry it
    // is handed, and the only registry in the process is the LEAD's. A child
    // loading a skill would push a frame onto the lead's turn-scoped ceiling —
    // narrowing what the LEAD may do once the report returns — and fire
    // `onChange` -> `refreshSkills()` -> `rebuildSystemPrompt()`, rewriting the
    // lead's system prompt from inside the tool call the lead is blocked in,
    // from up to `maxConcurrent` places at once. Nothing in the child's report
    // would show any of it.
    //
    // The capability is not simply dropped: the lead's always-on skill bodies
    // are spliced into every child's system prompt below, so global skill
    // knowledge still reaches children. A child that needs a specific skill body
    // says so in its summary and the lead loads it.
    //
    // `skill_install` / `skill_create` are excluded for the original reason:
    // they mutate the user's skill root and route to an approval gate no child
    // can reach.
    skillTools: deps.skillRegistry
      ? [createSkillFindTool({ registry: deps.skillRegistry })]
      : [],
    // No `ask_user`, no `submit_plan`: there is no human attached to a child, and
    // registering tools it could never use burns a turn — the same argument that
    // keeps them out of headless mode.
    planTools: [],
    // NO `todo_write` FOR CHILDREN (todo-plan-execution §3.11 / D-14 / AC-34).
    // Children run concurrently against ONE list under a full-replacement
    // protocol: the last writer would win and the lead's plan would be destroyed
    // by a subagent's private checklist. A list PER child would be a second
    // panel and a second scroll model for work the lead already tracks as one
    // item.
    //
    // EXPLICIT, WITH THIS COMMENT, even though the option's absence already
    // yields an empty array: a silent default is not a decision anyone can find
    // later.
    todoTools: [],
    teamTools: commTools,
    // `spec.readOnly` forces the plan gate on for this child even in a BUILD
    // session. TIGHTENING ONLY (D-13): there is no field anywhere that gives a
    // child more permission than the session it was spawned from. Read LIVE, so
    // a mid-dispatch Shift+Tab to PLAN tightens every running child at its next
    // tool call.
    agentMode: () => (spec.readOnly ? 'plan' : deps.getMode()),
    // Site three of three for the policy (`ControllerDeps` -> `TeamRuntimeDeps`
    // -> here). Spread, so a child built without one gets today's options bag
    // byte for byte and `buildSubagentTools`'s existing tests are untouched.
    ...(deps.permission ? { permission: deps.permission } : {}),
    ...(deps.toolPolicy
      ? {
          toolPolicy: deps.toolPolicy,
          // Decorated with the child's label, NOT the lead's raw handler (P1-3).
          // `evaluateToolCall` returns a notice naming a tool and a skill but no
          // agent, so three children hitting one refusal would surface three
          // unattributable notices; and the lead's deny-escalation counter is
          // turn-scoped, so passing it through would advance it three times for
          // what is one refusal repeated.
          onToolPolicyEvent: (e: {
            tool: string;
            verdict: ToolPolicyVerdict;
            sourceNames: string[];
          }) => deps.onChildToolPolicyEvent?.({ ...e, label: spec.label }),
          // The two comm tools are not in the LEAD's registered tool list, so
          // the ceiling would refuse them and dead-end the channel.
          policyExempt: TEAM_SUBAGENT_TOOL_NAMES,
        }
      : {}),
  });

  // Mail rides on the NEXT tool result of whatever the child does next (D-4), so
  // every tool it can call has to carry the tail — the comm tools included, or a
  // child that only ever messages would never receive.
  return tools.map((t) => withMailboxTail(t, deps.bus, spec.label));
}

/**
 * Construct a child and wire its instrumentation.
 *
 * The returned agent has NOT been prompted; `TeamRuntime` owns scheduling.
 */
export function createSubagent(
  spec: SubagentSpec,
  deps: SubagentDeps,
  hooks: SubagentHooks,
): SubagentHandle {
  const run: SubagentRun = {
    label: spec.label,
    description: spec.description,
    phase: 'queued',
    turns: 0,
    toolCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    filesTouched: [],
    messagesSent: 0,
  };

  // The tools have to exist before `new Agent(...)` does, so `team_wait` and the
  // confirm queue read the agent through this holder rather than capturing it.
  // Resolving it eagerly would capture `null` for the child's whole life and
  // silently drop the watchdog pause (see `TeamWaitDeps.getAgent`).
  let agentRef: SubagentAgentLike | null = null;
  const getAgent = (): WatchdogPausable | null => agentRef;

  const tools = buildSubagentTools(spec, deps, getAgent);

  // THE CHILD'S MODEL IS THE LEAD'S MODEL, READ FROM THE DISPATCH-TIME CONFIG
  // (main-agent parity). Same provider, same model id, same base URL, same
  // thinking level: a delegation is never a downgrade, and the only model a
  // child may surprise its lead with is one a settings-screen edit made live
  // between two dispatches.
  //
  // `maxTokens` inherits `deps.config.maxTokens` below - the same ambition the
  // lead sends, clamped by the same adapter, so an inherited large value
  // degrades to the right number rather than to an HTTP 400.
  const resolved: { ref: ModelRef; thinkingLevel: typeof deps.config.thinkingLevel; role: 'main' } = {
    ref: {
      providerId: deps.config.provider,
      modelId: deps.config.model,
      ...(deps.config.baseUrl ? { baseUrl: deps.config.baseUrl } : {}),
    },
    thinkingLevel: deps.config.thinkingLevel,
    role: 'main',
  };
  const model: ModelRef = resolved.ref;

  // HOISTED TO A LOCAL, AND THAT IS WHAT MAKES W3 POSSIBLE AT ALL. This was built
  // INLINE inside the `agentFactory({...})` argument, so there was nothing for the
  // child manager's `getSystemPrompt` accessor to close over - and the accessor
  // cannot read it back off the agent, because `SubagentAgentLike` is narrowed to
  // `state.messages` on purpose.
  // THE SAME `<fast_tier>` BLOCK THE LEAD GETS, spliced only when this child
  // will actually have a reviewer. The gating expression is written against
  // `deps.review` here and the reviewer is built from the SAME predicate
  // below, so the prompt can never advertise a capability the child lacks -
  // and a child with a reviewer is never surprised by its first injection.
  const fastBlock =
    deps.review !== undefined && deps.review.active()
      ? buildFastBlock({ model: deps.review.modelId(), review: true })
      : '';
  const systemPrompt = buildSystemPrompt({
    cwd: deps.getCwd(),
    tools,
    skillsBlock: deps.alwaysBlock ?? '',
    agentMode: spec.readOnly ? 'plan' : deps.getMode(),
    // A child has no overlay, so the plan block must describe the headless
    // shape: write the plan as the final message rather than calling tools it
    // does not have.
    planInteractive: false,
    subagentBlock: buildSubagentBlock({
      label: spec.label,
      description: spec.description,
      peers: deps.bus.peersOf(spec.label),
    }),
    ...(fastBlock ? { fastBlock } : {}),
  });

  // LAZY ACCESSORS OVER `agentRef`, WHICH IS ASSIGNED AFTER THIS RETURNS. A
  // non-lazy read here is `undefined` at construction and the child's estimate
  // branch would silently measure an empty history - CR-1 one module over.
  const contextManager = deps.contextManagerFor?.({
    label: spec.label,
    model,
    role: resolved.role ?? 'main',
    getMessages: () => agentRef?.state.messages ?? [],
    getSystemPrompt: () => systemPrompt,
    onCompacted: () => {
      run.compactions = (run.compactions ?? 0) + 1;
    },
  });

  const agent = deps.agentFactory({
    systemPrompt,
    model,
    tools,
    thinkingLevel: resolved.thinkingLevel,
    // The LEAD's registry instance, REUSED (P2-2). It holds adapter state, and
    // constructing five of them per dispatch is pure waste.
    providerRegistry: deps.providerRegistry,
    // The lead's closure, so a settings-screen key edit reaches children too.
    getApiKey: (id) => deps.getApiKey(id, resolved.role ?? 'main'),
    ...(deps.config.maxTokens !== undefined ? { maxTokens: deps.config.maxTokens } : {}),
    timeouts: {
      toolTimeout: deps.config.toolTimeoutMs,
      // A child keeps its OWN idle watchdog, and that is a feature: a wedged
      // child is aborted by its own ceiling without taking the dispatch with it
      // (§3.8). The two places a child legitimately blocks on something other
      // than its own LLM or tool — `team_wait` and the confirm queue — pause it
      // explicitly.
      idleTimeout:
        deps.overseerActive === true
          ? deps.config.idleTimeoutMs * TEAM_LIMITS.overseerWatchdogFactor
          : deps.config.idleTimeoutMs,
    },
    // SPREAD CONDITIONALLY, never `contextManager: deps.contextManagerFor?.(...)`.
    // With the feature off the options bag has no such key, so the loop's gate
    // tests a field that is genuinely `undefined` rather than a property holding
    // one - the identical argument `AgentController` makes for the lead (AC-H10).
    ...(contextManager ? { contextManager } : {}),
  });
  agentRef = agent;

  // PER-CHILD FAST REVIEW (main-agent parity). GATED ON THE PROVIDER'S OWN
  // LIVE PREDICATE, read once here so the prompt and the reviewer CANNOT
  // DISAGREE about whether the child has one: a child told about
  // `<fast_review>` blocks must be a child that actually receives them, and a
  // child with a reviewer must have been told. `abortRequested` is the flag
  // `handle.abort()` sets (see `SubagentHandle`); the reviewer reads it as its
  // never-steer-into-a-requested-abort fact.
  let abortRequested = false;
  const reviewLive = deps.review !== undefined && deps.review.active() === true;
  const reviewer = reviewLive
    ? deps.review?.create({
        label: spec.label,
        goal: spec.description,
        agent,
        isRunning: () =>
          run.phase === 'starting' ||
          run.phase === 'thinking' ||
          run.phase === 'tool' ||
          run.phase === 'waiting',
        isAbortRequested: () => abortRequested,
      })
    : undefined;

  let lastEmit = 0;
  let lastPhase = run.phase;
  /**
   * The retry projection as it was last PUBLISHED (§6.10).
   *
   * A retry transition has to pass the throttle for the same reason a phase
   * transition does, and it is not covered by the phase check: a child entering
   * backoff stays `thinking`, so `retry_scheduled` arriving within a throttle
   * window of the previous token would be COALESCED AWAY — and the next event is
   * up to thirty seconds later, which is exactly the interval the row exists to
   * explain. The row would then say `thinking` for the whole wait.
   */
  let lastRetryKey = '';
  // The tail of the text the child is writing right now (F-1). Bounded on every
  // append: a long turn would otherwise grow this without limit, and it is the
  // only per-token allocation this feature adds.
  let textTail = '';
  const emit = (): void => {
    const now = Date.now();
    const retryKey = run.retry ? `${run.retry.attempt}/${run.retry.maxRetries}` : '';
    // Phase and retry transitions always pass; everything else is coalesced. Five
    // children streaming tokens must not push five React renders per token, and
    // the streaming coalescer in `App.tsx` protects the transcript, not this path.
    if (
      run.phase === lastPhase &&
      retryKey === lastRetryKey &&
      now - lastEmit < TEAM_LIMITS.agentUpdateThrottleMs
    ) {
      return;
    }
    lastPhase = run.phase;
    lastRetryKey = retryKey;
    lastEmit = now;
    // Exactly one sanitize per PUBLISHED frame rather than one per token (P2-2):
    // `emit()` throws away all but one result per throttle window, so two
    // regexes per token would be paid for a value nobody reads. `textTail` is
    // cleared on `turn_start` and `tool_execution_end`, so an empty tail is how
    // "not writing anything right now" is expressed.
    run.activity =
      textTail.length > 0 ? sanitizeActivity(textTail, TEAM_LIMITS.activityChars) : undefined;
    hooks.onUpdate({ ...run, filesTouched: [...run.filesTouched] });
  };

  const noteFile = (toolName: string, args: unknown): void => {
    if (toolName !== 'write_file' && toolName !== 'edit_file') return;
    const path = (args as { path?: unknown } | undefined)?.path;
    if (typeof path !== 'string' || path.length === 0) return;
    if (run.filesTouched.includes(path)) return;
    if (run.filesTouched.length >= TEAM_LIMITS.filesTouchedMax) return;
    run.filesTouched.push(path);
  };

  const unsubscribe = agent.subscribe((event) => {
    switch (event.type) {
      case 'turn_start':
        run.phase = 'thinking';
        textTail = '';
        run.activity = undefined; // a new turn is not the last turn's work
        run.activityArgs = undefined;
        break;
      case 'turn_end': {
        run.turns += 1;
        // A completed turn means whatever it retried, it recovered (§6.10). The
        // row goes back to reporting its phase.
        run.retry = undefined;
        run.usage = {
          inputTokens: run.usage.inputTokens + event.usage.inputTokens,
          outputTokens: run.usage.outputTokens + event.usage.outputTokens,
        };
        hooks.onUsage(spec.label, event.usage);
        // W1's delta needs the history LENGTH the measurement covered, and the
        // port carries no turn hook. `turn_end` is emitted BEFORE the assistant
        // push, so this is exactly the history the reported `usage` describes.
        contextManager?.onTurnEnd(event.usage, agentRef?.state.messages ?? [], systemPrompt);
        const text = assistantText(event.message);
        // The LAST non-empty assistant text wins, which is exactly the child's
        // final message once the loop stops calling tools. Capturing it here
        // rather than parsing `agent_end.messages` keeps a partial summary from
        // an aborted run, which the report renders as partial rather than lost.
        if (text.length > 0) run.summary = text;
        // `0` MEANS NO CAP (main-agent parity): the lead has no turn ceiling
        // either, and a child that needs forty turns for a forty-turn job is
        // not runaway - it is working.
        const turnCap = deps.config.team.maxTurnsPerSubagent;
        if (turnCap > 0 && run.turns >= turnCap) {
          run.truncated = true;
          // THE FLAG FIRST, exactly like `handle.abort()`: the child's
          // reviewer reads `abortRequested` as its guard-1 fact, and a
          // turn-cap stop must be visible to it in the same tick.
          abortRequested = true;
          agent.abort();
        }
        break;
      }
      case 'compaction_end':
        contextManager?.onCompactionEnd({
          applied: event.applied,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          tokensBefore: event.estimatedTokensBefore,
          tokensAfter: event.estimatedTokensAfter,
        });
        break;
      case 'tool_execution_start':
        run.phase = event.toolName === 'team_wait' ? 'waiting' : 'tool';
        run.lastTool = event.toolName;
        run.toolCalls += 1;
        textTail = '';
        run.activity = undefined; // prose is stale now
        run.activityArgs = pickActivityArgs(event.args); // PICKED, not raw (P1-4)
        noteFile(event.toolName, event.args);
        break;
      case 'tool_execution_end':
        run.phase = 'thinking';
        textTail = '';
        run.activity = undefined;
        // CLEARED, like `activity` (P1-5). Leaving it set would keep the picked
        // strings alive for the whole run and past it - `publish()` copies the
        // run into the snapshot and into every event, and `dispatch()` copies it
        // into the outcome the transcript holds - for a value nothing renders
        // once the phase is back to `thinking`.
        run.activityArgs = undefined;
        // Read from the BUS, not counted from tool calls: a refused send is an
        // attempt, not a message, and the panel's `mail N` readout has to agree
        // with what the recipients actually received.
        if (event.toolName === 'team_send') run.messagesSent = deps.bus.sentCount(spec.label);
        if (event.toolName === 'team_wait') {
          run.blockedWaits = deps.bus.blockedWaitCount(spec.label);
        }
        break;
      case 'message_update':
        if (event.streamEvent.type === 'error') {
          run.error = formatStreamError(event.streamEvent.error);
          run.retryable = isRetryableStreamError(event.streamEvent.error);
          // The ladder is over: an `error` reaching a subscriber means `withRetry`
          // stopped retrying. Leaving the projection set would freeze the row at
          // `retrying 10/10` on top of a failure (§6.10).
          run.retry = undefined;
        } else if (event.streamEvent.type === 'retry_scheduled') {
          // SET, and the phase is deliberately LEFT ALONE: the child is still
          // `thinking` as far as the scheduler is concerned, and rewriting the
          // phase would put a retry into `SubagentPhase` — a union the report, the
          // panel and `canSend` all read for a different question.
          run.retry = {
            attempt: event.streamEvent.attempt,
            maxRetries: event.streamEvent.maxRetries,
          };
        } else if (event.streamEvent.type === 'retry_attempt') {
          run.retry = {
            attempt: event.streamEvent.attempt,
            maxRetries: event.streamEvent.maxRetries,
          };
        } else if (event.streamEvent.type === 'text_delta') {
          // O(1) per delta: one bounded concat and one bounded slice, and
          // NOTHING else. The sanitize happens once per emitted frame instead,
          // inside `emit()` above (P2-2).
          textTail = (textTail + event.streamEvent.delta).slice(-TEAM_LIMITS.activityTailChars);
        }
        break;
      default:
        break;
    }
    // AFTER the switch, so `run.phase` is current when the supervisor's
    // silence timer consults it (team-overseer I-OV3): a `team_wait` start
    // must be observable as `waiting` on the very kick that follows it.
    hooks.onActivity?.();
    emit();
  });

  return {
    spec,
    run,
    agent,
    tools,
    // THE HANDLE-LEVEL ABORT (see `SubagentHandle`): the flag first, then the
    // agent, so the reviewer's guard observes the request in the same tick.
    abort: () => {
      abortRequested = true;
      agent.abort();
    },
    isAborted: () => abortRequested,
    unsubscribe: () => {
      reviewer?.dispose();
      unsubscribe();
    },
  };
}
