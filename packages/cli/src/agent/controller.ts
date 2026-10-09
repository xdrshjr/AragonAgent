import {
  createModelSettingsDraft, saveModelSettings, reloadModelSettings,
  type ModelSettingsSnapshot,
} from './model-profile-settings.js';
import type {
  ModelSettingsDraft, ModelSettingsPatch, ModelSettingsSaveResult,
} from '../config/model-profile-store.js';
import { randomUUID } from 'node:crypto';
import { verifyCompactionIdentity, type CompactionIdentity } from '../compaction/memory-identity.js';
import { COMPACTION_LIMITS } from '../compaction/limits.js';
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

import type { PromptOptions, PromptOutcome } from './prompt-options.js';

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
} from '@aragon-agent/core';
import type {
  CliConfig,
  CompactionConfig,
  FastConfig,
  RetryConfig,
  SkillsConfig,
  TeamConfig,
  ThemeName,
  TodoConfig,
} from '../config/schema.js';
import {
  clampCompactionConfig,
  clampFastConfig,
  clampRetryConfig,
  clampTeamConfig,
  clampTodoConfig,
  isAdapterProvider,
  toRetryPolicy,
} from '../config/schema.js';
import type { ModelRole } from '../config/model-profiles.js';
import { resolveModelProfileState } from '../config/model-profile-resolution.js';
import { makeGetApiKey } from '../config/load.js';
import { updatePersistedConfig } from '../config/store.js';
import { ModelWindows } from '../config/model-windows.js';
import { createBuiltinTools, type ConfirmRequest } from '../tools/index.js';
// `import type` ONLY — see the same note in `tools/index.ts`.
import type { ToolPermission } from '../exec/permission.js';
import { createFileChangeStore, type FileChangeStore } from '../tools/file-change-store.js';
import {
  createToolOutputStore,
  type ToolOutputListener,
  type ToolOutputStore,
} from '../tools/tool-output-store.js';
import type { FilePatch } from '../tools/patch.js';
import { TeamRuntime } from '../team/runtime.js';
import { TeamHumanQueue } from '../team/human-queue.js';
import { createTaskTool } from '../team/task-tool.js';
import { buildTeamBlock } from '../team/prompt.js';
import type { TeamEvent, TeamSnapshot } from '../team/types.js';
import { buildFastBlock } from '../fast/prompt.js';
import { ProcSupervisor } from '../proc/supervisor.js';
import { buildBackgroundServicesBlock } from '../proc/prompt.js';
import { PROC_LIMITS } from '../proc/limits.js';
import type { ProcEventListener, ServiceSnapshot } from '../proc/types.js';
import { makeBashKill, makeBashOutput } from '../tools/proc-tools.js';
import { addSignalHook } from '../logging/install.js';
import { describeFastTierProblem, fastProviderOf, resolveFastTier } from '../fast/resolve.js';
import { FastWiring, offFastStatus, type FastStatus } from '../fast/wiring.js';
import type { FastEventListener, FastSnapshot } from '../fast/types.js';
import { CompactionWiring, offCompactionSnapshot } from '../compaction/wiring.js';
import { ContextMeter, type ContextUsageListener } from '../compaction/meter.js';
import type {
  CompactionEventListener,
  CompactionSnapshot,
  ContextUsageSnapshot,
} from '../compaction/types.js';
import { TodoStore } from '../todo/store.js';
import { createTodoTool } from '../todo/todo-tool.js';
import { buildTodoBlock } from '../todo/prompt.js';
import type { TodoEventListener, TodoSnapshot } from '../todo/types.js';
import { createPlanTools, type AskRoundTicket } from '../tools/plan-tools.js';
import { DENY_ALL_HUMAN_INPUT, type HumanInputGate } from '../tools/human-input.js';
import { getLogger } from '../logging/logger.js';
import { createNodeSkillHost } from '../skills/node-host.js';
import { SkillService, type ApprovalGate } from '../skills/service.js';
import { createSkillTools } from '../skills/tools.js';
import { buildSystemPrompt } from './system-prompt.js';
import type { AgentMode } from './agent-mode.js';
import type { NoticeLevel } from './reducer.js';

/**
 * Extra budget, on top of `PROC_LIMITS.killGraceMs`, that `prompt()` allows a
 * force-stopped engine to unwind in before it starts a new run anyway (I-8).
 *
 * `bash`'s own kill grace is what a wedged foreground command costs; this covers
 * the loop's own unwinding on top of it. Waiting FOREVER is not an option - a
 * tool that never settles is exactly why the force-stop rung exists.
 */
const ENGINE_UNWIND_GRACE_MS = 3000;

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
   * CLI version stamped into `.aragon-skill.json` and the install User-Agent.
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
  /**
   * The plan-mode human channel (§3.5). Defaults to `DENY_ALL_HUMAN_INPUT`, so
   * forgetting to pass one registers NO plan tools rather than registering tools
   * that would hang. A THIRD approval channel on purpose: `confirm` auto-approves
   * when unattached and `approval` denies, but neither can render a question
   * wizard or a plan card.
   */
  humanInput?: HumanInputGate;
  /**
   * Whether this session could EVER render the todo rail (todo-plan-execution
   * §3.7 / P1-6). Full-screen and interactive; headless calls are false.
   *
   * It varies ONE SENTENCE of the `<todo_planning>` block, and nothing else.
   * Telling the model "the user sees this list in a panel beside the
   * conversation" under `-p` is the same error `composeSystemPrompt` already
   * guards against for team mode with its two flags. Defaults to `false` so a
   * caller that forgets it gets the honest sentence rather than a false claim
   * about the user's screen.
   *
   * Deliberately STATIC (D-25). The two dynamic causes — a resize below
   * `TODO_RAIL_MIN_TOTAL_COLS` and an open overlay — do NOT re-compose the
   * prompt: rebuilding it on every resize would rewrite the system prompt
   * mid-run, and the sentence is guidance rather than a contract.
   */
  todoPanelCapable?: boolean;
  /**
   * The `aragon exec` tool policy (cli-integration-surface §4.2).
   *
   * FORWARDED TO **TWO** PLACES, AND BOTH ARE REQUIRED (R-4 / R-5). It goes into
   * `createBuiltinTools` for the lead's own array, and into `TeamRuntimeDeps` so
   * children inherit it. Without the second, `--deny-tool bash` is bypassed by
   * one `task` call and NOTHING ANYWHERE REPORTS IT — a security control that
   * silently does not hold. Plan mode's "reaches one level down" guarantee is
   * the precedent; AC-12 is the test.
   *
   * Absent on every existing path (the TUI, `-p`, every subcommand), which is
   * what keeps the tool array identical there — see the option's own comment in
   * `tools/index.ts`.
   */
  permission?: ToolPermission;
  /**
   * `--append-system-prompt` text, appended verbatim to the composed prompt
   * (§4.1). Threaded through `composeSystemPrompt` so it survives every rebuild
   * — a `/cwd` change, a skills rescan, a mode flip — rather than being spliced
   * once at construction and lost at the first `rebuildSystemPrompt()`.
   */
  appendSystemPrompt?: string;
  /**
   * The per-model window table from ~/.aragon-agent/model-windows.json.
   * Injectable so tests can hand the controller a table without writing into
   * the shared vitest home root (app-paths.ts TEST-ISOLATION CONTRACT);
   * production leaves it absent and the constructor builds the real one.
   */
  modelWindows?: ModelWindows;
}

/** What `setAgentMode` actually adopted — see `AgentController.setAgentMode`. */
export interface AgentModeState {
  effective: AgentMode;
  /** Non-null only while a `plan -> build` switch is waiting for `agent_end`. */
  pending: AgentMode | null;
}

export interface PlanStatus extends AgentModeState {
  askRoundsUsed: number;
  maxAskRounds: number;
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
  /** Per-model user-declared context windows; see `config/model-windows.ts`. */
  private readonly modelWindows: ModelWindows;
  private modelMetadataEnabled = false;
  private modelMetadataGeneration = 0;
  private modelMetadataAbort = new AbortController();
  private disposed = false;
  private readonly tools: AgentTool[];
  private readonly skills: SkillService;
  private readonly skillsEnabled: boolean;
  private onSkillsChanged?: () => void;

  /** Mutable session cwd — tools resolve relative paths against this. */
  private cwd: string;

  /**
   * `--append-system-prompt` text (cli-integration-surface §4.1).
   *
   * A FIELD, NOT A LOCAL, because `composeSystemPrompt()` is called again on
   * every rebuild — a `/cwd` change, a skills rescan, a plan-mode flip — and a
   * value spliced once at construction would silently vanish at the first one.
   * Empty on every path but `aragon exec`.
   */
  private readonly appendSystemPrompt: string;

  // -----------------------------------------------------------------------
  // Plan mode (§3.1) — THE CONTROLLER OWNS THE MODE.
  //
  // It is the object the tools close over, so it is the only place that can
  // answer "may this tool run?" at execute time. `ViewState.agentMode` is a
  // MIRROR held for rendering, written only from what `setAgentMode` reports it
  // adopted.
  // -----------------------------------------------------------------------

  private effectiveMode: AgentMode;
  private pendingMode: AgentMode | null = null;
  private askRounds = 0;
  /** Static: whether this session could ever render a question overlay. */
  private readonly planInteractive: boolean;

  // -----------------------------------------------------------------------
  // Team mode (team-subagents §4.5) — TWO FLAGS, AND THEY ARE NOT THE SAME.
  //
  // `teamRegistered` is decided ONCE, at construction, and can never change:
  // it is whether the `task` tool is in `this.tools` at all. The array is
  // immutable for the life of the session (see the note in the constructor),
  // so `/team on` in a session started with `--no-team` CANNOT add it.
  //
  // `teamEnabled` is live. `/team off` flips it, which makes `task` refuse
  // through its own guard and drops `<team_mode>` from the next prompt rebuild
  // — `rebuildSystemPrompt()` IS a live path, unlike the tool array.
  //
  // Conflating them is P0-2: the prompt would advertise a tool that was never
  // registered, every call would come back "unknown tool", and the model would
  // have no way to discover why (D-17 / R-18).
  // -----------------------------------------------------------------------

  private readonly teamRegistered: boolean;
  private teamEnabled: boolean;
  private readonly teamRuntime: TeamRuntime | null;

  // -----------------------------------------------------------------------
  // Todo planning (todo-plan-execution §3.6a) — THE SAME TWO FLAGS, FOR THE
  // SAME REASON.
  //
  // `todoRegistered` is decided ONCE, at construction: whether `todo_write` is
  // in `this.tools` at all. The array is immutable for the life of the session
  // (C-1), so `/todo on` in a session started with `--no-todo` CANNOT add it.
  //
  // `todoEnabled` is live. `/todo off` flips it, which makes `todo_write` refuse
  // through its own closure AND drops `<todo_planning>` from the next prompt
  // rebuild — and BOTH halves are required (P1-1). Flip the flag without the
  // rebuild and the block survives `/todo off`: every call comes back with the
  // refusal while the instructions telling the model to keep calling are still
  // in its own context, so it cannot diagnose the loop.
  // -----------------------------------------------------------------------

  private readonly todoRegistered: boolean;
  private todoEnabled: boolean;
  private readonly todos: TodoStore | null;
  /** Static: whether this session could ever render the rail. See the dep. */
  private readonly todoPanelCapable: boolean;

  /**
   * Structured file diffs on their way to the UI (agent-activity-presentation
   * §3.3.5). A bounded, take-once ring; see `file-change-store.ts` for why each
   * of those three words is load-bearing.
   *
   * DECLARED WITH AN INITIALIZER, so it exists before `createBuiltinTools` runs
   * in the constructor body and the recorder closure it hands over is valid from
   * the first tool call.
   */
  private readonly fileChanges: FileChangeStore = createFileChangeStore();

  /**
   * A running tool's output on its way to the UI
   * (agent-activity-presentation-live §3.1.3).
   *
   * NULL WHEN THE FEATURE IS OFF (P1-6). `fileChanges` next door is declared
   * with an initializer because it is unconditional; this one cannot be, since a
   * field initializer cannot read a constructor parameter -- and an
   * unconditional initializer would allocate on every construction and make
   * AC-31's "no store is allocated" false by construction. `private readonly
   * fast: FastWiring | null` below is the same declaration shape in the same
   * class.
   *
   * ASSIGNED IN THE CONSTRUCTOR BODY, ABOVE THE `createBuiltinTools` CALL, not
   * near `this.fast` which runs after it. The binding there is spread
   * CONDITIONALLY on this field, so an assignment placed after the call would
   * read `undefined`, add no property, and produce a build in which the feature
   * is silently off with the key on.
   */
  private readonly toolOutputs: ToolOutputStore | null;

  private readonly outputListeners = new Set<ToolOutputListener>();

  // -----------------------------------------------------------------------
  // Fast model tier (fast-model-tier §3.1 / §3.3)
  //
  // ONE FIELD AND FOUR THIN FORWARDERS. The flag pair, the tier cache, the
  // reviewer's lifetime and the `resolveTier` closure all live in
  // `fast/wiring.ts`, which is a BUDGET decision rather than an aesthetic one
  // (C-12 / RV-5): `CLAUDE.md` caps a source file at 1000 lines and this one had
  // 40 to spare when the design was written.
  //
  // `null` when the tier could not be resolved at construction, which is the
  // byte-identity branch: no reviewer is subscribed, `task` carries no `model`
  // property, and `<fast_tier>` is never spliced (I-2).
  // -----------------------------------------------------------------------

  private readonly fast: FastWiring | null;

  // -----------------------------------------------------------------------
  // Context compaction (context-auto-compaction §3.2.1)
  //
  // ONE FIELD AND THIN FORWARDERS, the `fast` shape one feature later, and for
  // the same budget reason (C-16): every piece of state — the guards, the
  // ladder, the manual queue, the session totals — lives in
  // `compaction/wiring.ts` and `compaction/compactor.ts`.
  //
  // `null` when `compaction.enabled` was false at construction, which is the
  // byte-identity branch: no manager is passed to `new Agent({...})`, nothing is
  // subscribed, no registry is allocated, and the engine loop's checkpoint is one
  // `if` against a field that is genuinely absent (AC-1).
  //
  // CONSTRUCTED ABOVE `new Agent({...})` AND ATTACHED BELOW IT (C-12 / P0-2).
  // The port has to be inside the Agent's constructor argument and the wiring has
  // to subscribe to the Agent, and this class cannot do both in one step.
  // -----------------------------------------------------------------------

  private readonly compaction: CompactionWiring | null;

  // -----------------------------------------------------------------------
  // Context occupancy (context-usage-gauge-accuracy §3.2 / W1)
  //
  // CONSTRUCTED UNCONDITIONALLY, unlike its neighbour, and that asymmetry IS the
  // feature. `compaction` above is `null` for a session started with
  // `--no-compaction` - and before this field existed, that took the only
  // measuring code in the process with it: such a session's gauge had exactly
  // one sample per turn (the provider's `turn_end` usage) and read `0 %` after a
  // `/resume`. Occupancy is not a compaction concern; it is what compaction
  // READS.
  //
  // IT COSTS A HEADLESS HOST NOTHING (I-11). `aragon exec` builds an
  // `AgentController` too, and nothing there reads this number; the meter arms
  // no timer while it has no subscribers, so the extra object is a few scalars
  // and a `Set`.
  // -----------------------------------------------------------------------

  private settingsRevision = 0;
  private requestVersion = 0;
  private idleCompaction: AbortController | undefined;
  private restoredCompactionIdentity: CompactionIdentity | undefined;
  private readonly compactionBusyListeners = new Set<(busy: boolean) => void>();
  private modelSettingsBlocked = false;
  private preparedSystemPrompt: string | undefined;
  private readonly contextMeter: ContextMeter;

  // -----------------------------------------------------------------------
  // Background services (background-service-supervision §3.3 / §3.6)
  //
  // CONSTRUCTED UNCONDITIONALLY, and that is the one thing about this field that
  // is easy to get wrong (P1-6 / D-9). `cfg.bash.background` gates the SERVICE
  // half - the `background` tool param, `bash_output`/`bash_kill`, the prompt
  // block, the status chip - and NEVER the foreground half, because G2 ("bash
  // always settles") and G3 ("Esc, Esc always works, and the session stays
  // usable") are promised unconditionally. Gating the whole supervisor on the
  // flag would make rung two of the Esc ladder a silent no-op for every user who
  // turned background services off.
  //
  // With the flag off it holds foreground pids, nothing else, and allocates no
  // timers.
  // -----------------------------------------------------------------------

  private readonly procs: ProcSupervisor;
  /**
   * The host's notice channel, kept so `prompt()`'s totality has somewhere to
   * report to (I-8). Every other consumer reads `deps.notify` through a closure
   * built in the constructor; this one is called from a method, which is why it
   * needs a field.
   */
  private readonly notifyHostFn: ((level: 'info' | 'warn' | 'error', text: string) => void) | undefined;
  /** Whether the SERVICE half is on: tools, prompt block, `background` param. */
  private readonly bashBackgroundRegistered: boolean;
  /** Release the exit reaper. Called by `dispose()`. */
  private readonly releaseSignalHook: () => void;
  /**
   * Bumped by `forceStop()`; captured by `App` when it subscribes to a run.
   *
   * THE VIEW AND THE ENGINE DELIBERATELY DISAGREE AFTER A FORCE-STOP (D-10 /
   * I-7). Rung two dispatches `runEnd` locally so the composer is usable
   * immediately, but the engine keeps unwinding and keeps EMITTING -
   * `turn_start`, `tool_call_start`, `turn_end`, `agent_end` - and
   * `runStart`/`turnStart` would set `status: 'running'` again, bouncing the
   * view straight back out of the `idle` the user was just given and appending
   * entries to a transcript they believe is finished. `App` drops every event
   * whose generation is stale, which is the same shape as `abortRequested`
   * above and exists for the same reason: the loop legitimately emits after an
   * abort lands.
   */
  private runGen = 0;
  private startupSequence = 0;
  /**
   * Set SYNCHRONOUSLY by `abort()` before `agent.abort()` (§3.5.4a guard 1).
   * Cleared at the next `agent_start`.
   */
  private abortRequested = false;
  /** Only exact acceptance receipts release user messages from reviewer protection. */
  private readonly pendingUserSteering = new Map<string, string>();
  /** Session changes must not make a delayed receipt match a new message. */
  private readonly steeringPrefix = randomUUID();
  private steeringSequence = 0;

  constructor(private config: CliConfig, deps: ControllerDeps = {}) {
    this.cwd = config.cwd;
    this.appendSystemPrompt = deps.appendSystemPrompt ?? '';
    const humanInput = deps.humanInput ?? DENY_ALL_HUMAN_INPUT;
    this.planInteractive = humanInput.neverPrompts !== true;
    this.effectiveMode = config.startInPlanMode ? 'plan' : 'build';
    // The retry policy is installed HERE and replaced live by `setRetryConfig`
    // (llm-api-retry-backoff §6.3). Subagents inherit it for free: `TeamRuntime`
    // reuses this very registry instance.
    this.providerRegistry = initProviders({ retryPolicy: toRetryPolicy(config.retry) });
    this.modelRegistry = new ModelRegistry(this.providerRegistry);
    this.modelWindows = deps.modelWindows ?? new ModelWindows();
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

    const confirm = deps.confirm;

    // --- Todo planning -----------------------------------------------------
    this.todoRegistered = config.todo.enabled;
    this.todoEnabled = config.todo.enabled;
    this.todoPanelCapable = deps.todoPanelCapable === true;
    this.todos = this.todoRegistered ? new TodoStore() : null;

    // --- Fast model tier ---------------------------------------------------
    //
    // RESOLVED BEFORE THE TOOL ARRAY, because `fastRegistered` decides whether
    // `task`'s schema carries a `model` property at all and the array is built
    // ONCE (C-2). `FastWiring` re-runs the same pure function in its own
    // constructor; the two agree by construction because they read the same
    // config through the same resolver.
    const fastTier = resolveFastTier(config, (id, role) => this.hasApiKey(id, role));
    const fastRegistered = fastTier.ok;

    // --- Team mode ---------------------------------------------------------
    this.teamRegistered = config.team.enabled;
    this.teamEnabled = config.team.enabled;
    this.teamRuntime = this.teamRegistered
      ? new TeamRuntime({
          getConfig: () => this.config,
          // Read LIVE through the wiring, exactly as `resolveTier` below is: the
          // closure is only ever called from inside a dispatch, and
          // `childFactory()` re-reads `compaction.subagents` on every call so a
          // settings-screen edit reaches the next dispatch.
          contextManagerFor: (req) => this.compaction?.childFactory()?.(req),
          // Read LIVE through the wiring, which does not exist yet — the closure
          // is only ever called from inside a dispatch, long after construction.
          resolveTier: (tier) =>
            this.fast
              ? this.fast.resolveTier(tier)
              : {
                  ref: {
                    providerId: this.config.provider,
                    modelId: this.config.model,
                    ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
                  },
                  thinkingLevel: this.config.thinkingLevel,
                  role: 'main',
                },
          providerRegistry: this.providerRegistry,
          getCwd: () => this.cwd,
          getMode: () => this.effectiveMode,
          getApiKey: (id, role) => this.resolveKey(id, role),
          // `skill_find` only, and the lead's always-on bodies. See the long
          // note in `subagent.ts` for why `skill` itself is withheld (D-16).
          ...(this.skillsEnabled
            ? {
                skillRegistry: this.skills.getRegistry(),
                alwaysBlock: () => this.skills.alwaysBlock(),
                toolPolicy: () => this.skills.toolPolicyDecision(() => this.toolNames()),
                // Label-decorating, and it DOES NOT advance the lead's
                // escalation counter (P1-3). That counter exists to tell ONE
                // agent to stop retrying ONE tool; a child cannot retry the
                // lead's turn, and letting children spend the lead's budget
                // makes the escalation fire on the lead's next legitimate call.
                onChildToolPolicyEvent: (e) =>
                  deps.notify?.('warn', `[${e.label}] ${e.verdict.message ?? `Blocked ${e.tool}`}`),
              }
            : {}),
          // NOT routed through `withHumanWait` (I-3, and this one is subtle):
          // the lead's watchdog is ALREADY paused for the whole dispatch, and
          // `IdleWatchdog.pause()` is a boolean rather than a counter — so a
          // nested resume when one child's dialog closed would re-arm the lead
          // mid-dispatch and abort it at `idleTimeoutMs`. The queue pauses the
          // CHILD's watchdog instead, which is the one that needs it (P0-4).
          ...(confirm ? { humanQueue: new TeamHumanQueue(confirm) } : {}),
          // CHILDREN INHERIT THE POLICY (§4.2 invariant 3 / R-4 / AC-12).
          // Without this line `--deny-tool bash` is bypassed by one `task` call
          // and nothing anywhere reports it. Spread conditionally so a session
          // with no policy builds `SubagentDeps` exactly as it does today.
          ...(deps.permission ? { permission: deps.permission } : {}),
        })
      : null;

    // ABOVE `createBuiltinTools`, and the ordering is load-bearing for the
    // reason the field's own comment gives: the binding below is spread
    // conditionally on it (§3.1.3 / P1-6).
    this.toolOutputs = config.liveToolOutput ? createToolOutputStore() : null;

    // ALSO ABOVE `createBuiltinTools`, and UNCONDITIONAL - see the field's own
    // comment. `readyTimeoutMs` is read through a closure rather than captured,
    // so a live config change reaches the next service rather than the next
    // launch of the CLI.
    this.procs = new ProcSupervisor({ readyTimeoutMs: () => this.config.bash.readyTimeoutMs });
    this.notifyHostFn = deps.notify;
    this.bashBackgroundRegistered = config.bash.background;
    // THE EXIT REAPER (G5 / P1-2 / R-10). An APPEND-ONLY hook rather than a
    // second `setSignalTerminator`: that is a single slot `cli.tsx` already owns
    // for the alternate-screen restore, and replacing it is the documented bug
    // that leaves the user staring at a blank alternate screen. `reapSync` is
    // the only entry point it calls, and it is synchronous end to end (I-9).
    this.releaseSignalHook = addSignalHook(() => this.procs.reapSync());

    this.tools = createBuiltinTools({
      getCwd: () => this.cwd,
      // OWNED HERE, NOT IN `cli.tsx` (D-18): `createBuiltinTools` is called from
      // this constructor and from `team/subagent.ts`, never from `cli.tsx`, so
      // this is the one place a recorder can be bound to the toolset that will
      // use it. Pre-bound to `'lead'`, so `fs-tools.ts` never learns what an
      // owner is; subagents get no recorder this round (D-13).
      recordChange: (id, patch) => this.fileChanges.record('lead', id, patch),
      // The live-output recorder, at the identical site and for the identical
      // reason, and spread ONLY WHEN THE STORE EXISTS: with `liveToolOutput` off
      // the options bag has no `recordOutput` property at all, so
      // `createBuiltinTools`'s conditional spread yields today's `deps` byte for
      // byte and `bash` is the pre-round tool (AC-31).
      ...(this.toolOutputs
        ? { recordOutput: (id: string, chunk: string) => this.emitToolOutput('lead', id, chunk) }
        : {}),
      // THE SERVICE HALF, AND ONLY THE SERVICE HALF (P1-6 / I-2). With
      // `bash.background: false` the options bag has no `procs` key at all, so
      // `createBuiltinTools` adds no property to `deps`, `bash` gets its default
      // `{}` second argument, and the tool is the pre-feature one: no
      // `background` in its schema, the pre-feature description string, no
      // supervisor call. The FOREGROUND half of `this.procs` is still live, and
      // `forceStop()` still reaches it.
      ...(this.bashBackgroundRegistered
        ? {
            procs: this.procs,
            // Read LIVE for the reason every other closure in this bag is:
            // `aragon config set bash.autoBackground false` must take effect in
            // the running session.
            autoBackground: () => this.config.bash.autoBackground,
            startupSettleMs: () => this.config.bash.startupSettleMs,
            // D-15 / P1-8. `planInteractive` is the SAME signal `planTools`
            // already uses to decide that no overlay can be rendered, which is
            // exactly the question being asked here: can a card be drawn, and is
            // there a user who could keep a service alive?
            interactive: this.planInteractive,
          }
        : {}),
      confirmTools: config.confirmTools,
      // Routed through the same watchdog pause as the plan tools. This is a
      // pre-existing bug being fixed in passing: a `--confirm` user who took
      // longer than `idleTimeoutMs` over `Proceed? (y/N)` had their run killed
      // by the watchdog, and nothing said why (R-P3).
      ...(confirm ? { confirm: (req: ConfirmRequest) => this.withHumanWait(() => confirm(req)) } : {}),
      // `--no-skills` yields an empty array, so the tool list is byte-identical
      // to the pre-Skills seven (invariant I-S1 / AC-10).
      skillTools: this.skillsEnabled
        ? createSkillTools(this.skills, deps.version, () => this.toolNames())
        : [],
      // Registered ONCE per session, whatever the current mode, and never
      // rebuilt on a toggle (§3.4). `Agent.setTools()` unregisters and
      // re-registers entries in the live `ToolRegistry`, and `submit_plan`
      // mutates the mode from INSIDE a tool execution — rebuilding the array at
      // that moment would mutate the registry mid-iteration. Keeping the array
      // immutable removes the hazard entirely; the mode-dependent behaviour
      // lives in the gate, which is a pure function of `getMode()`.
      //
      // Empty in headless mode, so the tool list there is still exactly the 7
      // (or 11 with skills) it is today.
      planTools: createPlanTools({
        gate: humanInput,
        takeAskRound: () => this.takeAskRound(),
        withHumanWait: (fn) => this.withHumanWait(fn),
        onPlanApproved: () => this.setAgentMode('build', { force: true }),
      }),
      // THROUGH THE FACTORY for the reason `teamTools` records below (C-2), and
      // empty when todo planning was off at construction — which leaves the
      // array byte-identical to the pre-todo build (AC-30).
      todoTools: this.todos
        ? [
            createTodoTool({
              store: this.todos,
              // Read LIVE: `/todo off` flips the flag, it cannot unregister.
              isEnabled: () => this.todoEnabled,
            }),
          ]
        : [],
      // THROUGH THE FACTORY for the reason `teamTools` records below (P0-2), and
      // empty when background services were off at construction - which leaves
      // the array byte-identical to the pre-feature build (I-2).
      procTools: this.bashBackgroundRegistered
        ? [makeBashOutput({ supervisor: this.procs }), makeBashKill({ supervisor: this.procs })]
        : [],
      // THROUGH THE FACTORY, NEVER APPENDED AFTERWARDS (D-15 / P0-1).
      // `tools.test.ts::C7` asserts `HOST_TOOL_NAMES` equals what
      // `createBuiltinTools` produces, so appending `task` here would turn that
      // test red with a message about two lists of names.
      //
      // Empty when team mode was off at construction, which leaves the array
      // byte-identical to the pre-team build (AC-11).
      teamTools: this.teamRuntime
        ? [
            createTaskTool({
              runtime: this.teamRuntime,
              // Read LIVE: `/team off` flips the flag, it cannot unregister.
              isTeamEnabled: () => this.teamEnabled,
              // FROZEN AT CONSTRUCTION (C-2). `/fast on` in a session launched
              // without the tier cannot add a schema property, and it says so
              // rather than advertising one that is not there.
              fastRegistered,
              // Read LIVE at dispatch time (RV-3): the tier can stop resolving
              // mid-session, and the normalizer and the subagent factory must
              // agree about that at the same instant.
              fastAvailable: () => this.fast?.delegationAvailable() === true,
              maxSubagents: () => this.config.team.maxSubagents,
              hasApiKey: () => this.hasApiKey(),
              activeProvider: () => this.config.provider,
              modelCost: () => this.getModelInfo().cost,
              fastModelCost: () => {
                const ref = this.fast?.fastRef();
                return ref ? this.getModelInfoFor(ref).cost : undefined;
              },
              fastPricingUnknown: () => this.fast?.snapshot().pricingUnknown === true,
              withPausedWatchdog: (fn) => this.withPausedWatchdog(fn),
            }),
          ]
        : [],
      // Read at CALL time, never cached: the mode flips mid-run when the user
      // approves a plan, and a cached 'plan' would refuse the work they just
      // authorized.
      agentMode: () => this.effectiveMode,
      // SPREAD, never passed as `permission: deps.permission` (P1-2 / AC-28).
      // With no policy the options bag has no such key, so `createBuiltinTools`
      // never enters its filter branch and returns the same tool OBJECTS it does
      // today — which is what makes "the TUI and `-p` are unchanged" provable by
      // identity rather than by inspection.
      ...(deps.permission ? { permission: deps.permission } : {}),
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

    // --- Context occupancy, part 1: BEFORE the Agent, UNCONDITIONALLY ------
    //
    // Built here for the same C-12 reason the wiring is - lazy `getMessages` /
    // `getSystemPrompt` closures, `attach` after `new Agent` - and built for
    // EVERY session, including one with compaction off, because that is the one
    // whose gauge was broken (P1-4 / P0-2).
    this.contextMeter = new ContextMeter({
      getRequestVersion: () => this.requestVersion,
      getMessages: () => this.agent.state.messages,
      getSystemPrompt: () => this.agent.state.systemPrompt,
      getModelInfo: () => this.getModelInfo(),
      // Context discovery does not imply that the model's price is known.
      isWindowKnown: () => this.getModelInfo().contextWindowSource !== 'fallback',
      // LIVE, so a settings-screen edit moves the denominator without a relaunch.
      getWindowOverride: () => this.config.contextWindow,
    });

    // --- Context compaction, part 1: BEFORE the Agent ----------------------
    //
    // It needs no agent reference to EXIST — only live config, the key
    // resolvers, the model-info lookup and a notifier — which is exactly what
    // makes the C-12 split work. `getMessages` / `getSystemPrompt` are LAZY for
    // the same reason: `this.agent` is assigned on the very next statement, and
    // they are only ever called from inside an event handler.
    this.compaction = config.compaction.enabled
      ? new CompactionWiring({
          getConfig: () => this.config,
          hasKey: (id, role) => this.hasApiKey(id, role),
          getApiKey: (id, role) => this.resolveKey(id, role),
          getModelInfoFor: (ref) => this.getModelInfoFor(ref),
          isPricedModel: (ref) => this.isPricedModel(ref),
          getMessages: () => this.agent.state.messages,
          getSystemPrompt: () => this.agent.state.systemPrompt,
          notify: (level, text) => deps.notify?.(level, text),
          // ONE METER PER PROCESS (R-1). The wiring forwards it to the compactor,
          // so the trigger and the gauge cannot read two different numbers.
          meter: this.contextMeter,
        })
      : null;

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
      // SPREAD CONDITIONALLY, never `contextManager: this.compaction?.manager()`.
      // With the feature off the options bag has no such key, so the loop's gate
      // tests a field that is genuinely `undefined` rather than a property
      // holding `undefined` — which is what makes AC-1's byte-identity claim
      // provable by construction rather than by inspection. `createBuiltinTools`
      // above spreads `permission` for the identical reason (P1-2 / AC-28).
      ...(this.compaction ? { contextManager: this.compaction.manager() } : {}),
      timeouts: {
        // Timeout invariant (R1): idle ≥ tool so long tool runs are not killed.
        toolTimeout: config.toolTimeoutMs,
        idleTimeout: config.idleTimeoutMs,
        // A human wait is not a hung tool. 30 minutes by default, and the
        // number only bites BECAUSE the plan tools race `ctx.signal` — the
        // executor's timeout is cooperative, so an override is inert for any
        // tool that does not listen (see API.md, "Blocking on a human").
        toolTimeoutOverrides: {
          ask_user: config.planModeHumanTimeoutMs,
          submit_plan: config.planModeHumanTimeoutMs,
          // A fan-out is not a hung tool either. Like the two above, this
          // number only bites BECAUSE `task` races `ctx.signal` — the
          // executor's timeout is cooperative, so an override is inert for any
          // tool that does not listen (I-2).
          ...(this.teamRegistered ? { task: config.team.dispatchTimeoutMs } : {}),
        },
      },
    });

    // --- Context compaction, part 2: AFTER the Agent exists -----------------
    //
    // `attach` is what lets the wiring see `compaction_end` — the ENGINE's
    // `applied` verdict, which the compactor cannot know because validation
    // happens after `compact()` returns — and `agent_start`, which resets the
    // per-run cap. It is idempotent, and `dispose()` unsubscribes.
    //
    // A SEPARATE CALL RATHER THAN A `subscribe` DEP LIKE `FastWiring`'s, and that
    // is the constraint that makes the whole split work: a constructor that
    // subscribed could not run before `new Agent(...)`, and the port has to be
    // inside its constructor argument (C-12 / P0-2).
    this.compaction?.attach((listener) => this.agent.subscribe(listener));

    // --- Context occupancy, part 2: after the Agent exists -----------------
    //
    // ORDER RELATIVE TO THE LINE ABOVE IS DELIBERATELY IRRELEVANT (I-9 / T7).
    // The append direction is order-free because the meter marks itself dirty
    // and re-measures on read; the replace direction is order-free because the
    // splice is announced from `settlePending`'s own synchronous code rather
    // than from a listener. If a future change makes this ordering matter, the
    // fix is at those two sites, not here.
    this.contextMeter.attach((listener) => this.agent.subscribe(listener));

    // --- Fast tier, part 2: after the Agent exists --------------------------
    //
    // `FastWiring` subscribes to the lead's event stream, so it cannot be built
    // before the `Agent`. The prompt is therefore composed twice at startup:
    // once above without `<fast_tier>` (the wiring is still null) and once here.
    // That is one extra string build at construction and no live path.
    this.fast = fastRegistered
      ? new FastWiring({
          getConfig: () => this.config,
          hasKey: (id, role) => this.hasApiKey(id, role),
          getApiKey: (id, role) => this.resolveKey(id, role),
          isPricedModel: (ref) => this.isPricedModel(ref),
          subscribe: (listener) => this.agent.subscribe(listener),
          complete: (providerId, request) => this.providerRegistry.complete(providerId, request),
          // Reviewer advice shares skill activation, but cannot own a user ID.
          steer: (text) => this.enqueueSteering(text, false),
          isRunning: () => this.isRunning(),
          isAbortRequested: () => this.abortRequested,
          userSteerCount: () => this.pendingUserSteering.size,
          clearAllQueues: () => this.clearAllQueues(),
          notify: (level, text) => deps.notify?.(level, text),
          onPromptChanged: () => this.rebuildSystemPrompt(),
        })
      : null;

    // The two guards' bookkeeping, and the only reason this class subscribes to
    // its own agent. A receipt is where a user steer stops being pending;
    // `agent_start` is where a requested abort stops being in force.
    this.agent.subscribe((event) => {
      if (event.type === 'agent_start') this.abortRequested = false;
      if (event.type === 'steering_accepted') {
        for (const id of event.ids) this.pendingUserSteering.delete(id);
      }
      // The authoritative result arrives with this event, so from this instant
      // the tail is superseded and its slot must be released (§3.1.1). Clearing
      // HERE rather than on read is what keeps the store's size a function of
      // CONCURRENT calls instead of total calls.
      if (event.type === 'tool_execution_end') {
        this.toolOutputs?.clear('lead', event.toolCallId);
      }
    });

    if (this.fast) {
      this.rebuildSystemPrompt();
      // Fast-tier children are counted from the outcome rather than from the
      // specs, so a downgraded child is not miscounted as a saving (§3.6).
      this.teamRuntime?.subscribe((event) => {
        if (event.type !== 'dispatch_end') return;
        this.fast?.noteDelegated(event.outcome.runs.filter((r) => r.tier === 'fast').length);
      });
    }

    // ONE LINE FOR THE TWO CONFIGURATION MISTAKES THAT ARE OTHERWISE INVISIBLE
    // (§3.3): the tier is on but unnamed, or named against a provider with no
    // key. Nothing else in the session would ever mention either.
    const problem = describeFastTierProblem(fastTier, fastProviderOf(config));
    if (problem) deps.notify?.('warn', problem);
  }

  private resolveKey(providerId: string, role: ModelRole = 'main'): string | undefined {
    return makeGetApiKey(this.config, role)(providerId);
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

  private composeSystemPrompt(config: CliConfig = this.config): string {
    const tier = resolveFastTier(config, (id, role) => !!makeGetApiKey(config, role)(id));
    const fastAvailable = config === this.config ? this.fast?.available() === true
      : this.fast?.isRegistered() && config.fast.enabled && tier.ok;
    return buildSystemPrompt({
      cwd: this.cwd,
      tools: this.tools,
      skillsBlock: this.skillsEnabled ? this.skills.catalogBlock() + this.skills.alwaysBlock() : '',
      agentMode: this.effectiveMode,
      planInteractive: this.planInteractive,
      planMaxAskRounds: config.planModeMaxAskRounds,
      // BOTH flags, and both are required (§4.5). `teamRegistered` false means
      // there is no `task` tool to advertise; `teamEnabled` false means the user
      // turned it off for this session. Advertising in either case would
      // describe a capability the model does not have.
      teamBlock:
        this.teamRegistered && this.teamEnabled
          ? buildTeamBlock({
              maxSubagents: config.team.maxSubagents,
              maxConcurrent: config.team.maxConcurrent,
              // One cross-reference sentence, present only when the capability
              // is (§3.8). `this.fast` is null during the FIRST compose (the
              // wiring needs the Agent), which is why the constructor composes
              // again once it exists.
              fastDelegation: !!fastAvailable && config.fast.delegate,
            })
          : '',
      // BOTH FLAGS, exactly as team mode uses both, and for the identical
      // reason: `todoRegistered` false means there is no `todo_write` to
      // advertise, `todoEnabled` false means the user turned it off for this
      // session, and advertising in either case would describe a capability the
      // model does not have.
      todoBlock:
        this.todoRegistered && this.todoEnabled
          ? buildTodoBlock({
              panelVisible: this.todoPanelCapable && config.todo.panel,
            })
          : '',
      // The SAME two flags one more time, plus the live resolution — all three
      // live inside `FastWiring.available()` (§3.3). `buildFastBlock` itself
      // returns `''` when neither capability is on, so a user who turned both
      // off pays nothing for the tier being technically live.
      fastBlock:
        fastAvailable
          ? buildFastBlock({
              model: tier.ok ? tier.ref.modelId : '',
              delegate: config.fast.delegate,
              review: config.fast.review,
            })
          : '',
      // ONE FLAG, unlike team/todo's two: there is no live on/off switch for
      // background services - `bash.background` is read once at construction,
      // and the tools it registers cannot be unregistered (the `team.enabled` /
      // `todo.enabled` rule). So the block is present exactly when the tools are,
      // and can never advertise a capability the model does not have.
      backgroundBlock: this.bashBackgroundRegistered ? buildBackgroundServicesBlock() : '',
      // Read from the FIELD on every rebuild, for the reason the field's own
      // comment gives. Empty everywhere but `aragon exec`, and `buildSystemPrompt`
      // splices it conditionally, so every existing prompt is byte-identical.
      appendSystemPrompt: this.appendSystemPrompt,
    });
  }

  private rebuildSystemPrompt(): void {
    const prompt = this.preparedSystemPrompt ?? this.composeSystemPrompt();
    if (prompt !== this.agent.state.systemPrompt) this.idleCompaction?.abort();
    this.agent.setSystemPrompt(prompt);
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
   * does not touch `@aragon-agent/core`.
   */
  hasApiKey(provider?: string, role: ModelRole = 'main'): boolean {
    const activeProvider = role === 'fast'
      ? this.config.fast.provider || this.config.provider : this.config.provider;
    const key = this.resolveKey(provider ?? activeProvider, role);
    return !!key && key.trim().length > 0;
  }

  /**
   * Set the color theme live. Mirrors the `setModel` / `setThinkingLevel`
   * mutator pattern — a subsequent re-render re-reads `getConfig().theme` and
   * re-memoizes the palette (P1-1). Does not touch `@aragon-agent/core`.
   */
  setTheme(name: ThemeName): void {
    this.advanceSettingsRevision();
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
    if (this.modelSettingsBlocked) return { ok: false, kind: 'config',
      message: 'Settings were saved but not fully applied. Restart before sending requests.' };
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
  async prompt(text: string, options: PromptOptions = {}): Promise<PromptOutcome> {
    if (this.isCompactionBusy()) return this.compactionBusyOutcome();
    // Capture BEFORE stopping: synchronous abort listeners may cancel this request.
    if (this.modelSettingsBlocked) {
      return { status: 'not-started', reason: 'failed' };
    }
    if (this.modelMetadataEnabled) void this.refreshModelMetadata();
    const request = ++this.startupSequence;
    try {
      if (this.agent.state.isRunning) {
        this.stopEngine();
        await this.waitForEngineIdle();
      }
      if (request !== this.startupSequence) {
        return { status: 'not-started', reason: 'cancelled' };
      }
      if (this.agent.state.isRunning) throw new Error('The previous run is still stopping.');
      if (this.isCompactionBusy()) return this.compactionBusyOutcome();
      return await this.startPrompt(text, options, request);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      getLogger().warn('agent', 'prompt_failed', { reason });
      this.notifyHostFn?.('error', `Could not start the run: ${reason}`);
      return { status: 'not-started', reason: 'failed' };
    }
  }

  /**
   * Wait for the engine to unwind, bounded.
   *
   * BOUNDED BECAUSE THE UNBOUNDED CASE IS THE ONE THIS FEATURE IS ABOUT: a tool
   * that never settles is exactly why the force-stop rung exists, and `Agent.waitForIdle()`
   * alone would hang here for as long as it hangs there. The budget is the two
   * graces a wedged `bash` can legitimately spend, plus the executor's own.
   */
  private waitForEngineIdle(): Promise<void> {
    const budget = PROC_LIMITS.killGraceMs + ENGINE_UNWIND_GRACE_MS;
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, budget);
      timer.unref?.();
      void this.agent.waitForIdle().then(finish, finish);
    });
  }

  /** Prepare before clearing the plan, then enter the engine without yielding. */
  private async startPrompt(
    text: string, options: PromptOptions, request: number,
  ): Promise<PromptOutcome> {
    this.prepareUserTurn(text);
    if (request !== this.startupSequence) {
      return { status: 'not-started', reason: 'cancelled' };
    }
    this.todos?.beginUserTurn(options.todoPolicy);
    await this.agent.prompt(text);
    return { status: 'finished' };
  }

  private prepareUserTurn(text: string): void {
    if (this.skillsEnabled) this.skills.beginUserTurn();
    this.askRounds = 0;
    this.fast?.setGoal(text);
  }

  /** Cancel pending startup as well as any engine run already in progress. */
  abort(): void {
    this.startupSequence += 1;
    this.idleCompaction?.abort();
    this.stopEngine();
  }

  private stopEngine(): void {
    // SET BEFORE `agent.abort()`, SYNCHRONOUSLY — guard 1 of §3.5.4a. The loop
    // still emits the batch's final `tool_execution_end` (`agent-loop.ts:249`)
    // after an Esc lands inside the last tool's `await`, and the reviewer's
    // listener runs synchronously inside that emit; without this flag it would
    // see `isRunning() === true`, steer, and strand a critique in a queue
    // nothing ever clears (RV-1).
    this.abortRequested = true;
    this.fast?.abort();
    // The engine also races `ctx.signal` inside `runCompaction`, so this is the
    // same DELIBERATE REDUNDANCY the `teamRuntime` line below records: it makes
    // "Esc cancels an in-flight summarization" a property of this class rather
    // than a consequence of the compactor honouring a signal three modules away.
    this.compaction?.abort();
    this.agent.abort();
    // DELIBERATE REDUNDANCY (§3.8). Aborting the lead already aborts the
    // in-flight `task` call's `ctx.signal`, which the runtime listens to — that
    // path is correct today. Calling it directly as well makes "no child
    // survives its dispatch" a property of THIS class rather than a consequence
    // of signal plumbing three modules away, which is the same argument
    // `App.tsx` records for `cancelPendingHuman()` on `agent_end`.
    this.teamRuntime?.abortAll();
  }

  /**
   * Final rung of the Esc ladder: stop the AGENT, whatever it is blocked on
   * (§3.6 / G3).
   *
   * FOUR STEPS, AND THE FOURTH IS AN ABSENCE.
   *
   *   1. `abort()` - everything it does today, unchanged.
   *   2. `killForeground('force')` - hard-kill every tracked foreground `bash`
   *      child. THIS is what actually unblocks a wedged `await tool.execute`;
   *      an abort signal a tool ignores is advisory, and the force-stop rung exists for
   *      precisely the tools that ignore it.
   *   3. `runGen += 1` - so `App` can drop the events the engine will keep
   *      emitting while it unwinds (I-7). Without it the view bounces straight
   *      back out of the `idle` the user was just given.
   *   4. IT DOES NOT TOUCH BACKGROUND SERVICES. `Esc` interrupts the AGENT;
   *      `Ctrl+C` stops the SERVICES. That asymmetry is the user's own two
   *      sentences and it is exactly the kind of thing a later reader will
   *      "fix" by making this kill everything - which would mean a user who
   *      confirmed a force-stop of a runaway turn also lost the dev server they
   *      had been working against for an hour. It is invariant I-4.
   *
   * UNCONDITIONAL ON `bash.background` (P1-6 / D-9). The supervisor is always
   * constructed; with services off its foreground registry is all there is, and
   * that is the half this method uses.
   */
  forceStop(): void {
    this.abort();
    const killed = this.procs.killForeground('force');
    this.runGen += 1;
    getLogger().info('agent', 'force_stop', { generation: this.runGen, killed });
  }

  /**
   * The current run generation (I-7).
   *
   * `App` captures it when it subscribes to a run and drops every engine event
   * whose generation is stale. Same shape as the `abortRequested` guard the fast
   * reviewer already uses, and for the same reason: the loop legitimately emits
   * after an abort lands.
   */
  get runGeneration(): number {
    return this.runGen;
  }

  // -----------------------------------------------------------------------
  // Background services (background-service-supervision §3.5 / §3.6)
  // -----------------------------------------------------------------------

  /** Whether `bash_output` / `bash_kill` are in `this.tools`. Fixed at construction. */
  isBackgroundRegistered(): boolean {
    return this.bashBackgroundRegistered;
  }

  /**
   * Subscribe to the CLI-local `ProcEvent` stream.
   *
   * Returns a live unsubscribe even when services are off, because the
   * supervisor exists either way - the contract `subscribeTeam` /
   * `subscribeTodos` / `subscribeFast` / `subscribeToolOutput` already set. With
   * services off nothing is ever emitted, so an unconditional subscription in
   * `App` costs one `Set` entry.
   */
  subscribeProc(listener: ProcEventListener): () => void {
    return this.procs.subscribe(listener);
  }

  getServiceSnapshot(id: string): ServiceSnapshot | undefined {
    return this.procs.get(id);
  }

  listServices(): ServiceSnapshot[] {
    return this.procs.list();
  }

  /** `starting | ready | running`. Drives the status chip and the Ctrl+C rung. */
  liveServiceCount(): number {
    return this.procs.liveCount();
  }

  readServiceLog(id: string, since?: number): ReturnType<ProcSupervisor['read']> {
    return this.procs.read(id, since);
  }

  /**
   * Stop one service, or every service when `id` is `'all'`.
   *
   * The GRACEFUL ladder (`SIGTERM` -> `SIGKILL` after `stopGraceMs`), because
   * this path has a live event loop to run it on. `reapServicesSync` is the
   * other one, and it is the only one an exit path may use.
   */
  stopService(id: string): Promise<ServiceSnapshot[]> {
    return this.procs.stop(id);
  }

  /**
   * Rung one of `Ctrl+C`: stop every live service (§3.6 / G4).
   *
   * `force: true` means `reapSync()` SEMANTICS - immediate `SIGKILL`, no
   * `stopGraceMs` - and is what `doExit` uses, because `doExit` awaits nothing
   * and must not start (§3.6 step 3). The graceful ladder belongs to `Ctrl+C`,
   * `bash_kill` and `/bg stop`.
   */
  stopAllServices(opts: { force?: boolean } = {}): Promise<ServiceSnapshot[]> {
    if (opts.force) {
      this.procs.reapSync();
      return Promise.resolve(this.procs.list());
    }
    return this.procs.stop('all');
  }

  /**
   * The synchronous reaper (I-9).
   *
   * Exposed so `doExit` can call it without awaiting anything. It is also what
   * the signal hook registered in the constructor calls, and it is idempotent -
   * which it has to be, since a normal quit reaches it twice.
   */
  reapServicesSync(): void {
    this.procs.reapSync();
  }

  /** Queue automation/user guidance with the same protection as visible input. */
  steer(text: string): void {
    this.enqueueSteering(text, true);
  }

  /** Return the opaque ID used by the view to match Core's acceptance receipt. */
  queueUserMessage(text: string): string {
    return this.enqueueSteering(text, true)!;
  }

  private enqueueSteering(text: string, user: boolean): string | undefined {
    // Both reviewer and user guidance can activate queued skill frames.
    if (this.skillsEnabled && this.isRunning()) this.skills.absorbPendingFrames();
    const id = user ? `${this.steeringPrefix}:${++this.steeringSequence}` : undefined;
    if (id !== undefined) this.pendingUserSteering.set(id, text);
    try {
      this.agent.steer(text, id);
    } catch (error) {
      if (id !== undefined) this.pendingUserSteering.delete(id);
      throw error;
    }
    return id;
  }

  followUp(text: string): void {
    this.agent.followUp(text);
  }

  /** Resume queued input without appending a duplicate user message. */
  async continue(): Promise<PromptOutcome> {
    if (this.isCompactionBusy()) return this.compactionBusyOutcome();
    if (this.modelSettingsBlocked || this.isRunning()) {
      return { status: 'not-started', reason: 'failed' };
    }
    if (this.pendingUserSteering.size > 0) {
      const request = ++this.startupSequence;
      this.prepareUserTurn([...this.pendingUserSteering.values()].join('\n\n'));
      if (request !== this.startupSequence) {
        return { status: 'not-started', reason: 'cancelled' };
      }
      this.todos?.beginUserTurn('new-task');
    }
    await this.agent.continue();
    return { status: 'finished' };
  }

  /** Pending user receipts survive until Core accepts or the host clears them. */
  hasPendingUserMessages(): boolean { return this.pendingUserSteering.size > 0; }

  private compactionBusyOutcome(): PromptOutcome {
    this.notifyHostFn?.('warn', 'Context compaction is busy; your input was not submitted.');
    return { status: 'not-started', reason: 'failed' };
  }

  isRunning(): boolean {
    return this.agent.state.isRunning;
  }

  // -----------------------------------------------------------------------
  // Plan mode (§3.1 / §3.2)
  // -----------------------------------------------------------------------

  getAgentMode(): AgentMode {
    return this.effectiveMode;
  }

  /**
   * Request a mode change and return what was ACTUALLY ADOPTED.
   *
   * Returning the adopted state rather than `void` is the whole point of this
   * signature. The caller dispatches THIS value into the view, never the value
   * it asked for — dispatching the request is the one way to make the badge lie
   * about what the gate will do, and the API shape forecloses it (R-P7).
   *
   * The two directions are deliberately asymmetric:
   *
   *  - `build -> plan` applies IMMEDIATELY. Tightening a permission mid-run is
   *    always safe; the user pressed the key *because* the agent is about to do
   *    something they want to stop.
   *  - `plan -> build` is DEFERRED to `agent_end`. Applying it live would mean a
   *    run the user launched under a read-only guarantee could start writing
   *    files because of one stray keypress.
   *  - `{ force: true }` is the single exception, used only by `submit_plan`'s
   *    approval path: the user has just read the plan and authorized exactly
   *    that work. That is an informed act; a stray Shift+Tab is not. If this
   *    code is ever refactored, that distinction is the thing to preserve.
   */
  setAgentMode(next: AgentMode, opts: { force?: boolean } = {}): AgentModeState {
    if (next === 'plan') {
      this.effectiveMode = 'plan';
      this.pendingMode = null;
    } else if (this.effectiveMode === 'build') {
      // Already there. Clear any stale deferral rather than queueing a second.
      this.pendingMode = null;
    } else if (opts.force || !this.isRunning()) {
      this.effectiveMode = 'build';
      this.pendingMode = null;
    } else {
      this.pendingMode = 'build';
    }
    this.rebuildSystemPrompt();
    return { effective: this.effectiveMode, pending: this.pendingMode };
  }

  /**
   * Adopt a deferred `plan -> build` switch. Call from the App's `agent_end`
   * handling. Returns `null` when nothing was pending, so the caller can skip
   * both the dispatch and the toast.
   */
  applyPendingMode(): AgentModeState | null {
    if (!this.pendingMode) return null;
    this.effectiveMode = this.pendingMode;
    this.pendingMode = null;
    this.rebuildSystemPrompt();
    return { effective: this.effectiveMode, pending: null };
  }

  /** Named read surface for `/plan status`, so no command reaches into internals. */
  getPlanStatus(): PlanStatus {
    return {
      effective: this.effectiveMode,
      pending: this.pendingMode,
      askRoundsUsed: this.askRounds,
      maxAskRounds: this.config.planModeMaxAskRounds,
    };
  }

  /** Spend one `ask_user` round. Called from the tool, never from the UI. */
  private takeAskRound(): AskRoundTicket {
    const max = this.config.planModeMaxAskRounds;
    if (this.askRounds >= max) {
      return { ok: false, used: this.askRounds, remaining: 0, max };
    }
    this.askRounds += 1;
    return { ok: true, used: this.askRounds, remaining: max - this.askRounds, max };
  }

  /**
   * Run `fn` with the idle watchdog paused.
   *
   * `try/finally` rather than two sequential calls: a throw inside the overlay
   * path must not leave the watchdog disarmed for the rest of the run. Also used
   * by the `--confirm` gate, which had exactly this bug — a user who took four
   * minutes over `Proceed? (y/N)` had their run killed by the watchdog.
   *
   * RENAMED FROM `withHumanWait`, WITH THE OLD NAME KEPT AS AN ALIAS (D-12). The
   * mechanism is not about humans any more — a `task` dispatch is a long wait
   * with no human in it at all — but the plan tools and the `--confirm` gate read
   * correctly with the old name at their call sites, and renaming those would be
   * churn in files this change should barely touch.
   *
   * NOT RE-ENTRANT, and that matters here: `IdleWatchdog.pause()` sets a boolean
   * rather than a counter, so a nested call's `finally` re-arms the watchdog
   * while the outer wait is still going. That is why a child's `--confirm`
   * dialog does NOT route through this (see the constructor's `humanQueue`).
   */
  async withPausedWatchdog<T>(fn: () => Promise<T>): Promise<T> {
    this.agent.pauseIdleWatchdog();
    try {
      return await fn();
    } finally {
      this.agent.resumeIdleWatchdog();
    }
  }

  /** @see withPausedWatchdog — the name the plan tools and `--confirm` use. */
  withHumanWait<T>(fn: () => Promise<T>): Promise<T> {
    return this.withPausedWatchdog(fn);
  }

  // -----------------------------------------------------------------------
  // Team mode (team-subagents §4.5)
  // -----------------------------------------------------------------------

  /** Whether `task` is in `this.tools`. Fixed at construction; see the fields. */
  isTeamRegistered(): boolean {
    return this.teamRegistered;
  }

  /** Whether `task` will actually dispatch. Flipped live by `/team on|off`. */
  isTeamEnabled(): boolean {
    return this.teamEnabled;
  }

  /**
   * Flip the live switch and re-render the prompt.
   *
   * Turning it ON in a session that started with `--no-team` deliberately does
   * NOT register the tool (D-17): the array is immutable, and advertising an
   * unregistered tool is the dead end P0-2 is about. `/team` reports that
   * honestly by checking `isTeamRegistered()` first.
   */
  setTeamEnabled(enabled: boolean): void {
    this.advanceSettingsRevision();
    this.teamEnabled = enabled;
    this.rebuildSystemPrompt();
  }

  getTeamConfig(): TeamConfig {
    return this.config.team;
  }

  /**
   * Adopt a new team config for this session and re-render the prompt (the block
   * quotes the numbers). Clamped here as well as on the persist path, so a bad
   * value can never reach the runtime.
   */
  setTeamConfig(patch: Partial<TeamConfig>): TeamConfig {
    const team = clampTeamConfig({ ...this.config.team, ...patch });
    this.advanceSettingsRevision();
    this.config = { ...this.config, team };
    this.rebuildSystemPrompt();
    return team;
  }

  /** Refused mid-dispatch by `/team`; half a dispatch under two ceilings is not
   *  a result anything can afterwards explain (the reasoning `/reload` uses). */
  isTeamBusy(): boolean {
    return this.teamRuntime?.isBusy() ?? false;
  }

  getTeamSnapshot(): TeamSnapshot | null {
    return this.teamRuntime?.snapshot() ?? null;
  }

  /**
   * Subscribe to the CLI-local team event stream.
   *
   * Returns a no-op unsubscribe when team mode was off at construction, so every
   * caller can subscribe unconditionally.
   */
  subscribeTeam(listener: (event: TeamEvent) => void): () => void {
    if (!this.teamRuntime) return () => {};
    return this.teamRuntime.subscribe(listener);
  }

  /** Abort every child and clear timers. Idempotent; safe to call twice. */
  dispose(): void {
    this.idleCompaction?.abort();
    this.disposed = true;
    this.modelMetadataGeneration += 1;
    this.modelMetadataAbort.abort();
    this.teamRuntime?.dispose();
    this.fast?.dispose();
    this.compaction?.dispose();
    this.contextMeter.dispose();
    // REAP BEFORE RELEASING THE HOOK, in that order: disposal is a teardown, and
    // a service that outlives it has nothing left that could ever stop it.
    this.procs.reapSync();
    this.releaseSignalHook();
    this.procs.dispose();
  }

  // -----------------------------------------------------------------------
  // Todo planning (todo-plan-execution §3.6a)
  // -----------------------------------------------------------------------

  /** Whether `todo_write` is in `this.tools`. Fixed at construction (C-1). */
  isTodoRegistered(): boolean {
    return this.todoRegistered;
  }

  /** Whether `todo_write` will actually write. Flipped live by `/todo on|off`. */
  isTodoEnabled(): boolean {
    return this.todoEnabled;
  }

  /**
   * Flip the live switch and RE-RENDER THE PROMPT.
   *
   * THE REBUILD IS NOT OPTIONAL (P1-1 / AC-37). `composeSystemPrompt()` gates
   * `todoBlock` on `todoRegistered && todoEnabled`; without the rebuild
   * `<todo_planning>` survives `/todo off`, every call comes back with
   * `TODO_OFF_REFUSAL`, and the instructions telling the model to keep calling
   * are still in its own context — a refusal loop it cannot diagnose.
   *
   * Turning it ON in a session that started with `--no-todo` deliberately does
   * NOT register the tool: the array is immutable (C-1), and advertising an
   * unregistered tool is the dead end `/team on` already documents. `/todo`
   * reports that honestly by checking `isTodoRegistered()` first.
   */
  setTodoEnabled(enabled: boolean): void {
    this.advanceSettingsRevision();
    this.todoEnabled = enabled;
    this.rebuildSystemPrompt();
  }

  getTodoConfig(): TodoConfig {
    return this.config.todo;
  }

  /**
   * Adopt a new todo config for this session.
   *
   * THIS EXISTS BECAUSE `persistConfig` DOES NOT TOUCH THE RUNTIME (P1-2 /
   * AC-38). `App` reads `controller.getConfig()` on every render, and that
   * returns THIS object; the App's `persistConfig` only writes the file. So
   * `/todo panel off` must call both, exactly as `/team max` does — with only
   * the persist call the command reports success and changes nothing until the
   * next launch.
   *
   * Clamped here as well as on the persist path, so a bad value can reach
   * neither the runtime nor the file. The prompt rebuild carries §3.7's
   * `panelVisible` sentence, which is part of the block.
   */
  setTodoConfig(patch: Partial<TodoConfig>): TodoConfig {
    const todo = clampTodoConfig({ ...this.config.todo, ...patch });
    this.advanceSettingsRevision();
    this.config = { ...this.config, todo };
    this.rebuildSystemPrompt();
    return todo;
  }

  getTodoSnapshot(): TodoSnapshot | null {
    return this.todos?.snapshot() ?? null;
  }

  /**
   * Subscribe to the CLI-local todo event stream.
   *
   * Returns a no-op unsubscribe when todo planning was off at construction, so
   * every caller can subscribe unconditionally.
   */
  subscribeTodos(listener: TodoEventListener): () => void {
    if (!this.todos) return () => {};
    return this.todos.subscribe(listener);
  }

  /** `/resume`. An absent or empty list CLEARS — see `TodoStore.restore` (P0-2). */
  restoreTodos(items: unknown): void {
    this.todos?.restore(items);
  }

  /**
   * `/todo clear` and `/clear`. A user override of a projection (I-2's standing
   * exception). `/todo` refuses mid-run before it gets here; `/clear` does not,
   * on purpose — refusing there would leave it unable to clear the transcript.
   */
  clearTodos(): void {
    this.todos?.clear('user');
  }

  // -----------------------------------------------------------------------
  // API retry (llm-api-retry-backoff §6.3)
  //
  // NO `retryRegistered` TWIN of the team / todo flag pairs, and that asymmetry
  // is the point: retry is not a tool, so nothing is decided at construction.
  // The policy lives on the `ProviderRegistry`, which means it can be replaced
  // for a running session — including for children, because `TeamRuntime` holds
  // the same registry instance.
  // -----------------------------------------------------------------------

  getRetryConfig(): RetryConfig {
    return this.config.retry;
  }

  /**
   * Adopt a new retry config for this session AND PUSH IT INTO THE REGISTRY.
   *
   * THE SECOND CALL IS REQUIRED, NOT A NICETY (§6.3). Without it `/retry off`
   * would persist correctly and change nothing until the next launch — the
   * precise failure `config/schema.ts` warns about twice already, and the one a
   * user reports as "the setting does nothing".
   *
   * Clamped here as well as on the persist path, so a bad value can reach neither
   * the runtime nor the file.
   */
  setRetryConfig(patch: Partial<RetryConfig>): RetryConfig {
    const retry = clampRetryConfig({ ...this.config.retry, ...patch });
    this.advanceSettingsRevision();
    this.config = { ...this.config, retry };
    this.providerRegistry.setRetryPolicy(toRetryPolicy(retry));
    return retry;
  }

  // -----------------------------------------------------------------------
  // Mutators
  // -----------------------------------------------------------------------

  /** True while any request can still use a model or credential snapshot. */
  isModelSettingsBusy(): boolean {
    return this.isRunning() || this.isTeamBusy() || this.isCompactionBusy()
      || this.getCompactionSnapshot().inFlight
      || this.getFastStatus().snapshot.inFlight;
  }

  /** Monotonic revision protects an editor from all intervening settings changes. */
  getSettingsRevision(): number { return this.settingsRevision; }

  private advanceSettingsRevision(): void {
    this.settingsRevision += 1;
    this.idleCompaction?.abort();
  }

  /** Read-only draft creation; no startup migration or credential copying. */
  createModelSettingsDraft(): ModelSettingsDraft {
    return createModelSettingsDraft(this.config, this.settingsRevision);
  }

  /** Save an explicit draft as a single disk/live transaction. */
  saveModelSettings(draft: ModelSettingsDraft): ModelSettingsSaveResult {
    return saveModelSettings({ draft, controller: this });
  }

  /** Legacy commands share the same lossless conversion and atomic save path. */
  saveModelSettingsPatch(patch: ModelSettingsPatch): ModelSettingsSaveResult {
    const draft = this.createModelSettingsDraft();
    draft.profiles = undefined;
    draft.patch = patch;
    return this.saveModelSettings(draft);
  }

  /** Refresh both role connections and credentials while retaining conversation state. */
  reloadModelSettings(): ModelSettingsSaveResult { return reloadModelSettings(this); }

  /** Prebuild all potentially failing model/prompt work before committing the file. */
  prepareModelSettingsSnapshot(config: CliConfig): ModelSettingsSnapshot {
    return { config, model: { providerId: config.provider, modelId: config.model,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) },
      systemPrompt: this.composeSystemPrompt(config) };
  }

  /** Apply prepared state synchronously, without rebuilding the controller or its history. */
  applyModelSettingsSnapshot(snapshot: ModelSettingsSnapshot): void {
    const connectionChanged = this.config.provider !== snapshot.config.provider
      || this.config.model !== snapshot.config.model || this.config.baseUrl !== snapshot.config.baseUrl;
    this.idleCompaction?.abort();
    this.preparedSystemPrompt = snapshot.systemPrompt;
    try {
      this.config = snapshot.config;
      this.advanceSettingsRevision();
      this.agent.setModel(snapshot.model);
      this.agent.setThinkingLevel(snapshot.config.thinkingLevel);
      this.agent.setMaxTokens(snapshot.config.maxTokens);
      // Credentials may change even when endpoint/model do not. Invalidate
      // before publishing a window, including when the new profile has no key.
      if (this.modelMetadataEnabled) {
        this.resetModelMetadataRequest();
        this.modelRegistry.clearCache();
      }
      this.fast?.onConfigChanged(false, snapshot.config.fast.enabled);
      this.compaction?.onConfigChanged(snapshot.config.compaction.enabled);
      if (connectionChanged) {
        this.requestVersion += 1;
        this.contextMeter.onHistoryReplaced();
      } else this.contextMeter.onWindowChanged();
      this.rebuildSystemPrompt();
    } finally {
      this.preparedSystemPrompt = undefined;
    }
    if (this.modelMetadataEnabled) void this.refreshModelMetadata();
  }

  /** Potentially failing ordinary-setting side effects are isolated from model application. */
  applyModelSettingsEffects(): void { getLogger().reconfigure(this.config.log); }

  /** A partially applied model snapshot must never reach another provider request. */
  blockModelSettingsRequests(): void {
    this.modelSettingsBlocked = true;
    this.config.modelSettingsRestartRequired = true;
    this.resetModelMetadataRequest();
  }

  /** The UI uses this before accepting or draining queued prompts. */
  areModelSettingsBlocked(): boolean { return this.modelSettingsBlocked; }

  setModel(provider: string, model: string, baseUrl?: string): void {
    if (this.isModelSettingsBusy()) throw new Error('Model settings are busy.');
    const connectionChanged = this.config.provider !== provider || this.config.model !== model
      || this.config.baseUrl !== baseUrl;
    if (this.modelMetadataEnabled) this.resetModelMetadataRequest();
    this.advanceSettingsRevision();
    this.config = { ...this.config, provider, model, baseUrl };
    this.config.modelProfileState = resolveModelProfileState(this.config);
    this.agent.setModel({ providerId: provider, modelId: model, ...(baseUrl ? { baseUrl } : {}) });
    // NOT NEUTRAL TO THE FAST TIER even when the user never touched a `fast.*`
    // key (§3.9 / RV-3): `fast.provider: ''` and `fast.baseUrl: ''` INHERIT from
    // exactly these three fields. Switching the main provider can therefore turn
    // a working tier into `no_key`, or silently re-point an inheriting tier at
    // another vendor's gateway — and `<fast_tier>` would go on naming the model
    // it used to resolve to.
    this.fast?.onConfigChanged();
    // The summarizer resolves from LIVE config too — it may BE the fast tier —
    // so the snapshot the chip and `/compact status` read has to be refreshed
    // for the same reason and at the same moments (the RV-3 lesson).
    this.compaction?.onConfigChanged();
    if (connectionChanged) {
      this.requestVersion += 1;
      this.contextMeter.onHistoryReplaced();
    } else this.contextMeter.onWindowChanged();
    if (this.modelMetadataEnabled) void this.refreshModelMetadata();
  }

  setThinkingLevel(level: ThinkingLevel): void {
    this.advanceSettingsRevision();
    this.config = { ...this.config, thinkingLevel: level };
    this.agent.setThinkingLevel(level);
  }

  setMaxTokens(value: number | undefined): void {
    this.advanceSettingsRevision();
    this.config = { ...this.config, maxTokens: value };
    this.agent.setMaxTokens(value);
  }

  setApiKey(provider: string, key: string): void {
    // The Agent resolves keys via `resolveKey(this.config)` at call time, so
    // updating the config here is sufficient — no Agent rebuild needed.
    this.advanceSettingsRevision();
    this.config = {
      ...this.config,
      apiKeys: { ...this.config.apiKeys, [provider]: key },
    };
    if (this.modelMetadataEnabled) {
      this.resetModelMetadataRequest();
      this.modelRegistry.clearCache(provider);
      this.contextMeter.onWindowChanged();
      void this.refreshModelMetadata();
    }
    // Rule 5 of §3.2 reads `apiKeys`, so a key edit is a tier event: this is the
    // path that turns `no_key` back into a working tier without a relaunch.
    this.fast?.onConfigChanged();
    // The summarizer resolves from LIVE config too — it may BE the fast tier —
    // so the snapshot the chip and `/compact status` read has to be refreshed
    // for the same reason and at the same moments (the RV-3 lesson).
    this.compaction?.onConfigChanged();
  }

  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.advanceSettingsRevision();
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

  /**
   * The structured diff a file tool left behind, CONSUMED ONCE.
   *
   * Called by `reduceEvent` on `tool_execution_end` and nowhere else, which is
   * what keeps the store at constant size however many files a session edits.
   * `undefined` is an ordinary answer — a tool that records nothing, a toolset
   * built without a recorder, or an entry the 64-write ring has already evicted
   * — and every one of those falls back to `ToolPreview`.
   */
  takeFilePatch(toolCallId: string): FilePatch | undefined {
    return this.fileChanges.take('lead', toolCallId);
  }

  /**
   * Sanitise a chunk into the store and hand the resulting tail to the view.
   *
   * SYNCHRONOUS, INSIDE THE CHILD-PROCESS DATA HANDLER. The alternative (queue
   * plus timer) adds a second clock to a component that already has one, and
   * `App` coalesces at the other end anyway (D-34).
   *
   * EVERY LISTENER IS WRAPPED, and that is not defensive noise (R-5 / AC-35): a
   * throw here propagates into `child.stdout.on('data')`, which is the reason a
   * render-side bug could otherwise kill a ten-minute build. `debug` rather than
   * `warn` because a listener that throws once throws on every chunk.
   */
  private emitToolOutput(owner: string, toolCallId: string, chunk: string): void {
    if (!this.toolOutputs) return;
    const rows = this.toolOutputs.append(owner, toolCallId, chunk);
    for (const listener of this.outputListeners) {
      try {
        listener({ toolCallId, rows });
      } catch (err) {
        getLogger().debug('tool', 'tool_output_listener_threw', {
          toolCallId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Subscribe to the CLI-local live tool-output stream (§3.1.3).
   *
   * Returns a no-op unsubscribe when `liveToolOutput` was off at construction,
   * so every caller can subscribe unconditionally -- the contract
   * `subscribeTeam` / `subscribeTodos` / `subscribeFast` already set.
   */
  subscribeToolOutput(listener: ToolOutputListener): () => void {
    if (!this.toolOutputs) return () => {};
    this.outputListeners.add(listener);
    return () => {
      this.outputListeners.delete(listener);
    };
  }

  clearMessages(): void {
    this.idleCompaction?.abort();
    this.restoredCompactionIdentity = undefined;
    this.agent.clearMessages();
    this.startupSequence += 1;
    // INVALIDATION SITE 3 (context-auto-compaction-hardening §3.2.3). The history
    // was CLEARED, not appended to, so the prefix length the last measurement
    // covered indexes an array that no longer exists.
    //
    // BOTH LINES, AND THE SECOND IS NOT REDUNDANT (context-usage-gauge-accuracy
    // I-9). The wiring is `null` for a `--no-compaction` session, so it is the
    // meter call that guarantees a re-measure - deleting it "to de-duplicate"
    // reintroduces P0-2 for exactly the sessions this feature was written for. A
    // deep reset is idempotent, so both firing costs nothing.
    this.compaction?.onHistoryReplaced();
    this.contextMeter.onHistoryReplaced();
    // A new conversation has no loaded skills, so the "already loaded earlier
    // in this conversation" hint would otherwise start lying (P2-9).
    this.skills.getRegistry().clearActive();
    // `/reset` clears `messages`, so the belief that justifies the panel is gone
    // with them and the list must go too (I-2). `/clear` also drops the list, but
    // through `clearTodos()` and reason `'user'`, which is the distinction that
    // remains: this path is a belief that no longer exists, that one is a user
    // overriding a projection of a belief the model still holds.
    this.todos?.clear('reset');
  }

  /** Read-only view of the live system prompt (regression tests, /debug). */
  getSystemPrompt(): string {
    return this.agent.state.systemPrompt;
  }

  replaceMessages(messages: Message[], identity?: CompactionIdentity): void {
    this.idleCompaction?.abort();
    this.restoredCompactionIdentity = identity;
    this.agent.replaceMessages(messages);
    this.startupSequence += 1;
    // INVALIDATION SITE 4 (§3.2.3) - `/resume`, and any future host-side rewrite.
    // `estimateAppendedTokens` bounds-checks as well, so a MISSED site costs
    // accuracy and never correctness; that belt does not make this call optional.
    //
    // THE SECOND LINE IS THE P0-2 FIX. Before it, `/resume` of a 180k-token
    // session left the gauge and `/compact status` reading 0 %: nothing
    // re-measured and nothing published, so the mount-time "empty history"
    // reading stood until the next completed turn. The DEEP reset also drops
    // `estimateOffset`, because `/resume` can change the model in the same
    // breath (I-8).
    this.compaction?.onHistoryReplaced(identity);
    this.contextMeter.onHistoryReplaced();
  }

  getMessages(): Message[] {
    return this.agent.state.messages as Message[];
  }

  /** Atomically capture adopted history and its host credential for serialization. */
  getSessionSnapshot(): { messages: Message[]; compactionIdentity?: CompactionIdentity } {
    const messages = this.getMessages();
    const identity = this.compaction ? this.compaction.getIdentity() : this.restoredCompactionIdentity;
    if (identity && !verifyCompactionIdentity(messages, identity)) {
      getLogger().debug('agent', 'invalid_compaction_session_identity');
    }
    // Retain invalid evidence so damaged host memory cannot become ordinary text.
    return { messages, ...(identity ? { compactionIdentity: { ...identity } } : {}) };
  }

  /** Compatibility name for the documented compaction session boundary. */
  getCompactionSessionState(): ReturnType<AgentController['getSessionSnapshot']> {
    return this.getSessionSnapshot();
  }

  clearAllQueues(): void {
    this.agent.clearAllQueues();
    this.pendingUserSteering.clear();
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
    return this.getModelInfoFor({
      providerId: this.config.provider,
      modelId: this.config.model,
    });
  }

  /**
   * Resolve `ModelInfo` for ANY model (fast-model-tier §3.6 / RV-4).
   *
   * ONE RESOLUTION PATH, which is the same reason §3.2 has exactly one
   * `resolveFastTier`: `getModelInfo()` above is now a call into this, so "the
   * cost table for the model that actually billed" cannot drift from "the cost
   * table for the session's model" as two separate bodies.
   */
  getModelInfoFor(ref: Pick<ModelRef, 'providerId' | 'modelId' | 'baseUrl'>): ModelInfo {
    const found = this.modelRegistry.getModel(ref.providerId, ref.modelId);
    const baseUrl = ref.baseUrl ?? (ref.providerId === this.config.provider && ref.modelId === this.config.model
      ? this.config.baseUrl : undefined);
    const userWindow = this.modelWindows.lookup(ref.modelId);
    return {
      ...(found ?? this.modelRegistry.buildRuntimeModel(ref.providerId, ref.modelId)),
      ...this.modelRegistry.getContextWindow(ref.providerId, ref.modelId, baseUrl),
      // A USER-DECLARED WINDOW OUTRANKS EVERY TABLE (model-windows.json): the
      // user asserted the number for exactly this id, while api/catalog are
      // what this process managed to look up about it. It still LOSES to
      // config.json's `contextWindow`, which `ContextMeter.resolveWindow`
      // consults before it ever reaches here.
      ...(userWindow !== undefined
        ? { contextWindow: userWindow, contextWindowSource: 'user' as const }
        : {}),
    };
  }

  /** Best-effort metadata lookup; never block typing or a model request. */
  async refreshModelMetadata(): Promise<void> {
    if (this.disposed || this.modelSettingsBlocked) return;
    this.modelMetadataEnabled = true;
    const generation = ++this.modelMetadataGeneration;
    const { provider, baseUrl } = this.config;
    try {
      const key = this.resolveKey(provider);
      if (!key) return;
      await this.modelRegistry.discoverModels(provider, key, baseUrl, this.modelMetadataAbort.signal);
      if (this.disposed || generation !== this.modelMetadataGeneration) return;
      this.contextMeter.onWindowChanged();
    } catch {
      // Offline or unsupported discovery leaves catalog/unknown metadata intact.
    }
  }

  /** Invalidate an old connection without restarting a lookup on every prompt. */
  private resetModelMetadataRequest(): void {
    this.modelMetadataGeneration += 1;
    this.modelMetadataAbort.abort();
    this.modelMetadataAbort = new AbortController();
  }

  /**
   * Whether the STATIC table knows this model's price (C-11 / RV-4).
   *
   * `buildRuntimeModel` returns `cost: { input: 0, output: 0 }` for a model it
   * has never seen — a table of zeros, not a missing one — so every consumer
   * that renders spend needs to be able to tell "free" from "unknown". The fast
   * tier is precisely where an unrecognised id is likely, and `$0.00` on a
   * feature that is spending money is the same class of lie as pricing a Haiku
   * child at Sonnet rates.
   */
  isPricedModel(ref: Pick<ModelRef, 'providerId' | 'modelId'>): boolean {
    return this.modelRegistry.getModel(ref.providerId, ref.modelId) !== undefined;
  }

  // -----------------------------------------------------------------------
  // Fast model tier (fast-model-tier §3.1) — FOUR THIN FORWARDERS
  // -----------------------------------------------------------------------

  /** Whether `task`'s schema carries `model`. Fixed at construction (C-2). */
  isFastRegistered(): boolean {
    return this.fast !== null;
  }

  /** Whether the tier will actually be used. Flipped live by `/fast on|off`. */
  isFastEnabled(): boolean {
    return this.fast?.isEnabled() === true;
  }

  /**
   * Flip the live switch and re-render the prompt.
   *
   * Turning it ON in a session that started without the tier deliberately does
   * NOT register it: the tool array is immutable (C-2), and advertising a schema
   * field that is not there is the dead end `/team on` already documents.
   * `/fast` reports that honestly by checking `isFastRegistered()` first.
   */
  setFastEnabled(enabled: boolean): void {
    this.advanceSettingsRevision();
    this.fast?.setEnabled(enabled);
  }

  getFastConfig(): FastConfig {
    return this.config.fast;
  }

  /**
   * Adopt a new fast config for this session.
   *
   * THE RE-RESOLUTION IS NOT OPTIONAL (§3.2 rule 8). `App` reads
   * `controller.getConfig()` on every render and the block interpolates the
   * model id, so a persist without this call reports success and changes
   * nothing until relaunch — the failure `/todo panel` records (P1-2).
   */
  setFastConfig(patch: Partial<FastConfig>): FastConfig {
    const fast = clampFastConfig({ ...this.config.fast, ...patch });
    this.advanceSettingsRevision();
    this.config = { ...this.config, fast };
    // `onConfigChanged` rebuilds the prompt; when there is no wiring (the tier
    // was never registered) nothing has to be rebuilt, because no block is
    // spliced either way.
    this.fast?.onConfigChanged();
    // The summarizer resolves from LIVE config too — it may BE the fast tier —
    // so the snapshot the chip and `/compact status` read has to be refreshed
    // for the same reason and at the same moments (the RV-3 lesson).
    this.compaction?.onConfigChanged();
    return fast;
  }

  /** Everything `/fast status`, the settings line and the chip read. */
  getFastStatus(): FastStatus {
    return this.fast ? this.fast.status() : offFastStatus();
  }

  /**
   * Subscribe to the CLI-local fast event stream.
   *
   * Returns a no-op unsubscribe when the tier was off at construction, so every
   * caller can subscribe unconditionally — the contract `subscribeTeam` and
   * `subscribeTodos` already set.
   */
  subscribeFast(listener: FastEventListener): () => void {
    if (!this.fast) return () => {};
    return this.fast.subscribe(listener);
  }

  /**
   * The FIFTH thin forwarder: the current fast-tier snapshot, or `null` when
   * this session never registered a tier at all
   * (web-use-tier-cooperation-and-control-closure §4.2.1).
   *
   * `null` and "a snapshot with `live: false`" are different answers and callers
   * depend on the difference: the first means "there is no tier here", the
   * second means "there is one and it is not usable right now".
   *
   * Deliberately NOT folded into the existing `review_end` event: that shape is
   * consumed by `App` too, and this round promised to be purely additive.
   */
  fastSnapshot(): FastSnapshot | null {
    return this.fast?.snapshot() ?? null;
  }

  // -----------------------------------------------------------------------
  // Context occupancy (context-usage-gauge-accuracy §4.2) — THREE FORWARDERS
  //
  // ALL THREE ARE AVAILABLE UNCONDITIONALLY, which is the whole difference
  // between this block and the compaction one below it: there is no
  // `?? offSomething()` fallback here, because the meter always exists.
  // -----------------------------------------------------------------------

  /**
   * Subscribe to occupancy publications. Returns an unsubscribe function.
   *
   * THE SOLE UPSTREAM OF `ViewState.context` (I-1). The gauge used to have two
   * writers - `turnEnd` and a `contextTokensEstimated` dispatch fired from two
   * places in `App` - which is the entire cause of P0-1: both wrote in the same
   * synchronous fan-out and the second one won, restoring the pre-compaction
   * figure one statement after the bar had correctly fallen. One writer makes
   * that class of bug unrepresentable rather than merely fixed.
   */
  subscribeContextUsage(listener: ContextUsageListener): () => void {
    return this.contextMeter.subscribe(listener);
  }

  /**
   * Occupancy right now, re-measuring if the history has moved.
   *
   * `/context` READS THIS AND NOT `getCompactionSnapshot().pressure` (RV-8). The
   * latter returns `offCompactionSnapshot()`'s hardcoded zero pressure when
   * compaction was never registered, so a report built on it would read 0 % for
   * precisely the sessions this feature exists to fix.
   */
  getContextUsage(): ContextUsageSnapshot {
    return this.contextMeter.currentUsage();
  }

  /** The meter itself, for the wiring's single-instance assertion and tests. */
  getContextMeter(): ContextMeter {
    return this.contextMeter;
  }

  // -----------------------------------------------------------------------
  // Context compaction (context-auto-compaction §3.2.1) — THIN FORWARDERS
  // -----------------------------------------------------------------------

  /** Whether a `ContextManager` exists at all. Fixed at construction. */
  isCompactionRegistered(): boolean {
    return this.compaction !== null;
  }

  /** Whether it will actually fire. Flipped live by `/compact on|off`. */
  isCompactionEnabled(): boolean {
    return this.compaction?.isEnabled() === true;
  }

  /**
   * Flip the live switch.
   *
   * A NO-OP WHEN NOTHING IS REGISTERED, and `/compact` reports that honestly by
   * checking `isCompactionRegistered()` first — the `/fast on` and `/team on`
   * shape. `enabled` decides whether the wiring EXISTS, which happens once at
   * construction and cannot be undone: a session that started with no manager
   * would have to be given one mid-flight, and the `Agent` has no setter for it
   * on purpose (§3.2).
   */
  setCompactionEnabled(enabled: boolean): void {
    this.advanceSettingsRevision();
    this.compaction?.setEnabled(enabled);
  }

  getCompactionConfig(): CompactionConfig {
    return this.config.compaction;
  }

  /**
   * Adopt a new compaction config for this session.
   *
   * THE `onConfigChanged` CALL IS NOT OPTIONAL, for the reason `setFastConfig`
   * records: a persist without it reports success and changes nothing visible
   * until relaunch, because the chip and `/compact status` read a snapshot.
   */
  setCompactionConfig(patch: Partial<CompactionConfig>): CompactionConfig {
    const compaction = clampCompactionConfig({ ...this.config.compaction, ...patch });
    this.advanceSettingsRevision();
    this.config = { ...this.config, compaction };
    this.compaction?.onConfigChanged();
    return compaction;
  }

  /** Everything `/compact status`, the settings row and the chip read. */
  getCompactionSnapshot(): CompactionSnapshot {
    return this.compaction ? this.compaction.snapshot() : offCompactionSnapshot();
  }

  /**
   * The `ModelRef` the next compaction would summarize with, or `null`.
   *
   * IT IS CARRIED, NEVER RE-DERIVED, and that is the whole reason it exists. The
   * summarizer is the fast tier when `useFastTier` is on AND the tier resolves,
   * and the session's own model otherwise — a combination no caller can
   * reconstruct from `CliConfig` without re-implementing `resolveFastTier`, and
   * one that a plausible guess (`fast.enabled ? fast.provider : provider`) gets
   * WRONG whenever `fast.enabled` is true and `compaction.useFastTier` is false.
   * Pricing the spend against the wrong provider looks up a model the static
   * table has never seen, which prices it at `$0.00` — the C-11 / RV-4 lie, on
   * the one feature that spends money without being asked (AC-15).
   */
  getCompactionSummarizerRef(): ModelRef | null {
    return this.compaction?.summarizerRef() ?? null;
  }

  /**
   * This run's archive key, or `null` when compaction is unregistered
   * (context-auto-compaction-hardening §3.5 / W4).
   *
   * `/compact history` and `/compact show` scope themselves to it, so a second
   * `aragon` in another terminal is invisible here rather than interleaved with
   * this one's compactions.
   */
  getCompactionRunId(): string | null {
    return this.compaction?.archiveRunId() ?? null;
  }

  /** Ask for a compaction at the next turn boundary (§4.4 / D-17). */
  queueCompaction(instructions?: string): void {
    this.compaction?.queueManual(instructions);
  }

  /**
   * The IDLE `/compact` path (§4.4 / D-25).
   *
   * IT VALIDATES BEFORE IT SPLICES. `CompactionWiring.compactNow` runs
   * `validateHistory` itself and refuses on failure, because with no loop running
   * the engine's own gate is unreachable and D-4 declares that gate
   * unbypassable. `replaceMessages` validates NOTHING.
   */
  async compactNow(instructions?: string): Promise<{ ok: boolean; reason?: string }> {
    if (this.modelSettingsBlocked) return { ok: false, reason: 'settings_restart_required' };
    if (!this.compaction) return { ok: false, reason: 'not_registered' };
    if (this.isCompactionBusy() || this.isRunning()) return { ok: false, reason: 'busy' };
    const controller = new AbortController();
    const epoch = this.startupSequence;
    const settings = this.settingsRevision;
    let adopted = false;
    let timedOut = false;
    const isCurrent = () => this.idleCompaction === controller && !controller.signal.aborted
      && epoch === this.startupSequence && settings === this.settingsRevision
      && !this.isRunning() && !this.disposed;
    this.idleCompaction = controller;
    this.publishCompactionBusy(true);
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, COMPACTION_LIMITS.operationTimeoutMs);
    deadline.unref?.();
    try {
      // The wiring races cancellation locally and settles before releasing ownership.
      const outcome = await this.compaction.compactNow({
        messages: this.agent.state.messages,
        systemPrompt: this.agent.state.systemPrompt,
        model: this.agent.state.model,
        signal: controller.signal,
        ...(instructions ? { instructions } : {}),
        isCurrent,
        adopt: (messages) => {
          if (!isCurrent()) throw new Error('stale_history');
          this.agent.replaceMessages(messages);
          adopted = true;
        },
      });
      return outcome.ok || adopted ? { ok: true }
        : { ok: false, reason: timedOut ? 'timeout' : outcome.reason };
    } finally {
      clearTimeout(deadline);
      if (this.idleCompaction === controller) {
        this.idleCompaction = undefined;
        this.publishCompactionBusy(false);
      }
    }
  }

  /** Local prepare/adopt ownership, available before any network-start event. */
  isCompactionBusy(): boolean { return this.idleCompaction !== undefined; }

  /** Cancel local compaction and await ownership release before a conversation switch. */
  cancelCompaction(): Promise<void> {
    if (!this.idleCompaction) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const unsubscribe = this.subscribeCompactionBusy((busy) => {
        if (busy) return;
        unsubscribe();
        resolve();
      });
      this.abort();
    });
  }

  /** Subscribe to synchronous ownership transitions; observers cannot break adoption. */
  subscribeCompactionBusy(listener: (busy: boolean) => void): () => void {
    this.compactionBusyListeners.add(listener);
    return () => { this.compactionBusyListeners.delete(listener); };
  }

  private publishCompactionBusy(busy: boolean): void {
    for (const listener of this.compactionBusyListeners) {
      try { listener(busy); }
      catch { getLogger().debug('agent', 'compaction_busy_listener_threw'); }
    }
  }

  /**
   * Subscribe to the CLI-local compaction event stream.
   *
   * Returns a no-op unsubscribe when compaction was off at construction, so
   * every caller can subscribe unconditionally — the contract `subscribeTeam`,
   * `subscribeTodos` and `subscribeFast` already set.
   */
  subscribeCompaction(listener: CompactionEventListener): () => void {
    if (!this.compaction) return () => {};
    return this.compaction.subscribe(listener);
  }

  /** List usable tools (name + description) for the /tools command. */
  listTools(): AgentTool[] {
    return this.tools;
  }
}
