/**
 * Built-in toolset assembly (spec §3.6). The core engine ships no tools, so the
 * CLI supplies the entire `tools: AgentTool[]` array: filesystem, search, and
 * shell — all at full permission.
 *
 * An optional `confirmTools` mode wraps the mutating tools (write_file /
 * edit_file / bash) in a Yes/No gate. It is off by default per the max-permission
 * requirement; when enabled, a `confirm` callback (wired by the TUI) is awaited
 * before the tool runs.
 */

import {
  errorResult,
  evaluateToolCall,
  type AgentTool,
  type ToolPolicyDecision,
  type ToolPolicyVerdict,
  type ToolResult,
} from '@aragon-agent/core';
import type { AgentMode } from '../agent/agent-mode.js';
import { planRefusal, submitPlanRefusal } from '../agent/agent-mode.js';
// `import type` ONLY: `exec/permission.ts` is pure, but a value import would
// still put an exec-shaped module in the graph of every TUI and subagent build
// for a shape that is erased at compile time.
import type { ToolPermission } from '../exec/permission.js';
import type { ToolDeps } from './fs-tools.js';
import { makeReadFile, makeWriteFile, makeEditFile, makeListDir } from './fs-tools.js';
import type { FilePatch } from './patch.js';
import { makeGlob, makeGrep } from './search-tools.js';
import { makeBash } from './bash-tool.js';
// `import type` ONLY, for the reason `exec/permission.ts` records above: the
// supervisor is a PORT here, and a value import would put its implementation in
// the graph of every TUI, headless and subagent build for a shape that is erased.
import type { ProcSupervisorPort } from '../proc/types.js';

export interface ConfirmRequest {
  tool: string;
  summary: string;
  /**
   * The tool call's own abort signal, when the executor supplied one.
   *
   * IT IS HERE BECAUSE `withConfirmation` IS THE ONLY PLACE THAT HAS IT. A
   * confirm implementation that has to abandon a pending dialog — the subagent
   * queue in `team/human-queue.ts` is the one that does (team-subagents §3.11 /
   * AC-16) — cannot reach `ctx` any other way, and without it an `Esc` during a
   * dispatch pops a fresh dialog for every request still sitting in the FIFO.
   *
   * Ignored by the interactive and headless confirms, which are resolved by
   * their own channel when a run ends.
   */
  signal?: AbortSignal;
}

export interface BuiltinToolsOptions {
  getCwd: () => string;
  /**
   * Hand `write_file` / `edit_file` a place to leave a structured `FilePatch`
   * (agent-activity-presentation §3.3.5), already bound to its owner.
   *
   * THE FIELD IS NEEDED IN TWO INTERFACES, NOT ONE. This bag is the factory's;
   * `ToolDeps` is what the `make*` functions receive, and it is built below from
   * exactly the fields named there. Adding it to `ToolDeps` alone type-checks and
   * forwards nothing — the tools simply never record, and every card falls back
   * to `ToolPreview` with no error anywhere (P1-3).
   *
   * Omitting it — every existing test, every headless run, and every subagent
   * this round — leaves the tools byte-identical to today, which is the same
   * opt-in shape `skillTools` / `planTools` / `todoTools` already use.
   */
  recordChange?: (toolCallId: string, patch: FilePatch) => void;
  /**
   * Hand `bash` a place to leave its raw output chunks
   * (agent-activity-presentation-live §3.1.2), already bound to its owner.
   *
   * THE TWO-INTERFACE RULE ABOVE APPLIES VERBATIM (P1-1), and it applies because
   * round 1 made this exact mistake once already with `recordChange`: adding the
   * field to `ToolDeps` alone type-checks and forwards nothing, so `bash` never
   * records, every running card stays the single `running` row it is today, and
   * NOTHING ANYWHERE ERRORS.
   *
   * The conditional spread below is also what makes AC-31 true at this layer:
   * with `liveToolOutput` off the controller passes no key, so no property is
   * added and `deps` is the object it is today.
   */
  recordOutput?: (toolCallId: string, chunk: string) => void;
  /** When true (and `confirm` is provided), mutating tools are gated. */
  confirmTools?: boolean;
  /** Awaited before a mutating tool runs; resolve `false` to cancel. */
  confirm?: (req: ConfirmRequest) => Promise<boolean>;
  /**
   * `skill` / `skill_install` / `skill_create`, appended verbatim.
   *
   * Deliberately NOT added to `MUTATING_TOOLS`: the installer runs its own
   * `ApprovalGate` (§8.3.1), which is strictly stronger than the `--confirm`
   * wrapper. Adding them here too would ask the user twice for one action and,
   * worse, the outer wrapper would auto-approve where the inner gate refuses.
   *
   * An empty array (the `--no-skills` path) leaves the tool list byte-identical
   * to the pre-Skills seven — invariant I-S1 / AC-10.
   */
  skillTools?: AgentTool[];
  /**
   * Read the ceiling AT CALL TIME. Never cache the returned decision: the frame
   * changes mid-turn (a `skill` call adds to it, a rescan can empty it), and a
   * cached decision would ignore the skill the model just loaded.
   *
   * Omitting this leaves every tool unwrapped BY THIS GATE — see the first of
   * the two independent guards at the end of `createBuiltinTools`. It used to be
   * an early return, and P0-1 replaced it precisely because an early return also
   * skipped the plan-mode gate below it (R2-P2-3).
   */
  toolPolicy?: () => ToolPolicyDecision;
  /**
   * Report a refusal or a warn-mode pass so the user hears about it (D-G10).
   *
   * The field is `sourceNames`, NOT `sources`. `ToolPolicyDecision.sources` is a
   * list of structured `ToolPolicySource` objects; two same-named fields of
   * different shape in one flow is the easiest possible thing to mix up, so the
   * event carries the plain names under a different name.
   */
  onToolPolicyEvent?: (e: {
    tool: string;
    verdict: ToolPolicyVerdict;
    sourceNames: string[];
  }) => void;
  /**
   * Read the mode AT CALL TIME. Never cache: the mode can flip mid-run when the
   * user approves a plan, and a cached `'plan'` would refuse the very work the
   * user just authorized.
   *
   * Omitting this leaves every tool unwrapped by THIS gate — see the second,
   * INDEPENDENT guard at the end of `createBuiltinTools`, which is what keeps
   * the 7-tool / 11-tool baselines byte-identical (I-S1 / AC-G17).
   */
  agentMode?: () => AgentMode;
  /**
   * `ask_user` / `submit_plan`, appended verbatim. Empty in headless mode, where
   * no overlay can be rendered and showing the model a tool it cannot use just
   * burns a turn.
   */
  planTools?: AgentTool[];
  /**
   * `todo_write`, appended verbatim (todo-plan-execution §3.6).
   *
   * THROUGH THE FACTORY FOR THE REASON `teamTools` RECORDS BELOW (C-2):
   * `tools.test.ts::C7` asserts `HOST_TOOL_NAMES` equals what this factory
   * PRODUCES, so appending `todo_write` in `AgentController` after the factory
   * returned would turn C7 red with a message about two lists of names that
   * says nothing about todos.
   *
   * An empty array (the `--no-todo` path) leaves the tool list byte-identical to
   * the pre-todo build — AC-30, provable by object identity exactly as
   * `--no-skills` and `--no-team` are.
   */
  todoTools?: AgentTool[];
  /**
   * Team-mode tools, appended verbatim. The lead gets `[task]`; a subagent gets
   * `[team_send, team_wait]`.
   *
   * THIS OPTION EXISTS BECAUSE A TEST FORBIDS THE ALTERNATIVE (D-15 / P0-1).
   * `tools.test.ts::C7` asserts that `HOST_TOOL_NAMES` equals WHAT THIS FACTORY
   * ACTUALLY PRODUCES, so the moment `task` joined `HOST_TOOL_NAMES` (I-7),
   * appending it in `AgentController` after the factory returned would turn C7
   * red — with a failure message about two lists of names that says nothing
   * about team mode.
   *
   * ONE option serves both sides on purpose: the only two call sites are the
   * lead's controller and `createSubagent`, and a second option would just be a
   * second name for "extra tools this caller supplies".
   *
   * An empty array (the `--no-team` path) leaves the tool list byte-identical to
   * the pre-team build — AC-11, provable by object identity exactly as
   * `--no-skills` is.
   */
  teamTools?: AgentTool[];
  /**
   * The process supervisor (background-service-supervision §3.5).
   *
   * THE TWO-INTERFACE RULE: it is declared on `ToolDeps` as well, and adding it
   * to only one of the two type-checks and forwards nothing — `bash` never sees
   * a supervisor and every long-running command keeps hanging, with nothing
   * anywhere erroring. Both, or neither.
   *
   * The conditional spread below is what makes I-2 true at this layer: with
   * background services off the controller passes no key, so no property is
   * added and `deps` is the object it is today.
   */
  procs?: ProcSupervisorPort;
  /**
   * `bash_output` / `bash_kill`, appended verbatim.
   *
   * THROUGH THE FACTORY FOR THE REASON `teamTools` AND `todoTools` EACH RECORD
   * IN CAPITALS (P0-2): `tools.test.ts::C7` asserts `HOST_TOOL_NAMES` equals
   * what this factory PRODUCES, so appending these two in `AgentController`
   * after the factory returned would turn C7 red with a message about two lists
   * of names that says nothing about background services.
   *
   * An empty array (`bash.background: false`) leaves the tool list
   * byte-identical to the pre-feature build — I-2, provable by object identity
   * exactly as `--no-skills` and `--no-team` are.
   */
  procTools?: AgentTool[];
  /**
   * `cfg.bash.autoBackground`, READ AT CALL TIME.
   *
   * Never cached: `aragon config set bash.autoBackground false` takes effect in
   * the running session, and a cached `true` would go on backgrounding commands
   * the user just told it not to.
   */
  autoBackground?: () => boolean;
  /** `cfg.bash.startupSettleMs`, read at call time for the same reason. */
  startupSettleMs?: () => number;
  /**
   * Whether this session can render a service card and keep a service alive
   * (D-15 / P1-8).
   *
   * FALSE UNDER `aragon exec` AND `-p`. It suppresses only the CLASSIFIER: an
   * explicit `background: true` is still honoured, and its result then says the
   * service dies with the run. Without it `aragon -p "npm run dev"` would
   * background a server, return in `startupSettleMs`, and reap it at process
   * exit with nothing anywhere saying so.
   *
   * It is the SAME SIGNAL `planTools` already uses to decide that no overlay can
   * be rendered, so this costs one boolean rather than a new capability probe.
   * Absent means interactive, which is what every existing caller is.
   */
  interactive?: boolean;
  /**
   * Tool names that skip the CEILING wrapper only (never the plan gate, never
   * confirmation).
   *
   * It exists for a subagent's two comm tools and for nothing else (§3.11).
   * `team_send` / `team_wait` are not in the LEAD's registered tool list, so
   * evaluating them against the lead's `allowed-tools` ceiling would refuse them
   * and dead-end the channel — the same dead end `SKILL_TOOL_FLOOR` exists to
   * prevent one level up. Widening this set to anything that can write to disk
   * would turn delegation into a ceiling bypass, which is exactly what §3.11
   * re-applies the lead's policy to children to avoid.
   */
  policyExempt?: ReadonlySet<string>;
  /**
   * The non-interactive tool policy of `aragon exec`
   * (cli-integration-surface §4.2). A denied tool is NOT REGISTERED AT ALL, so
   * the model never sees it and never plans around it (D-4).
   *
   * OMITTING IT MUST LEAVE THE ARRAY UNTOUCHED, PROVEN BY IDENTITY (P1-2 /
   * AC-28). Every optional in this bag follows that house rule and `AC-G17`
   * already enforces it for `--no-skills` in those words. An unconditional
   * `tools.filter(...)` would type-check, behave identically, and quietly
   * allocate a new array on every existing path — forfeiting the ability to
   * PROVE that `-p`, the TUI and every subagent are unchanged.
   *
   * IT IS A THIRD MECHANISM, NOT A RENAME OF THE OTHER TWO. `toolPolicy` is the
   * skills ceiling (refuses at call time, per turn); `agentMode` is the plan
   * gate (refuses at call time, per mode); this REMOVES the tool. `policyExempt`
   * belongs to the first of those and is unrelated to the comm-tool exemption
   * `ToolPermission.isAllowed` applies for itself.
   */
  permission?: ToolPermission;
}

const MUTATING_TOOLS = new Set(['write_file', 'edit_file', 'bash']);

/**
 * Tools the ceiling always permits (D-G6). The ONLY place that knows which of
 * this host's tools are read-only — core must not (D-G7).
 *
 * Two groups, two different arguments. The read-only tools cannot change the
 * world, so an author who simply forgot to declare `read_file` gets an annoyance
 * rather than an incident. `skill` / `skill_find` have to stay reachable or the
 * Level 1 escape hatch would be visible to the model and uncallable inside a
 * frame — reintroducing the exact dead end iteration 2 spent a round removing.
 *
 * What is left under actual control is therefore `write_file` / `edit_file` /
 * `bash` / `skill_install` / `skill_create`: the five that change something. That
 * is the whole of what this mechanism is worth, and saying so plainly beats
 * implying it covers more.
 */
export const SKILL_TOOL_FLOOR = [
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'skill',
  'skill_find',
  // The two human-input tools join the floor for the same reason `skill` /
  // `skill_find` did: a skill that declares `allowed-tools` without naming them
  // would make `ask_user` unreachable and dead-end plan mode — the exact dead
  // end iteration 2 of the skills work spent a round removing. Neither is a
  // filesystem mutation, so the ceiling loses nothing it was protecting.
  // (`submit_plan` does mutate the SESSION MODE, which is why the floor is now
  // described as "everything that cannot write to disk" rather than
  // "read-only".)
  'ask_user',
  'submit_plan',
  // `task` joins the floor rather than the blocked set (D-5), and the choice is
  // forced to be conscious by the partition test below. It cannot itself mutate
  // anything: every child mutation passes through this same wrapper stack one
  // level down, with the child inheriting `agentMode` through the same closure.
  // Blocking it would forfeit parallel research, which is plan mode's best use.
  'task',
  // `todo_write` joins the floor rather than the blocked set (D-12), and the
  // partition test below is what forces that choice to be conscious. A todo list
  // is a DISPLAY: it writes no file and runs no shell. More concretely, a skill
  // whose `allowed-tools` omitted it would make the planning UI unreachable
  // inside that skill's frame — the identical dead end that put `ask_user` /
  // `submit_plan` / `task` here.
  'todo_write',
  // `bash_output` joins the FLOOR rather than the blocked set (D-12), and the
  // partition test below is what forces that choice to be conscious. It READS A
  // BUFFER: it cannot write to disk or run a shell, which is the floor's stated
  // membership test. Blocking it in plan mode would also let the agent start a
  // service it then could not read — the dead end the floor exists to prevent.
  'bash_output',
] as const;

/**
 * The five tools plan mode refuses: exactly the complement of `SKILL_TOOL_FLOOR`
 * within `HOST_TOOL_NAMES` — "the five that change something", the set this file
 * already names in prose above.
 *
 * It lives HERE, next to the floor, rather than in `agent/agent-mode.ts` with
 * the rest of the mode vocabulary. The invariant worth having is that these two
 * sets PARTITION `HOST_TOOL_NAMES`, and a partition test is only as trustworthy
 * as the distance between the two definitions it compares. Splitting them
 * across modules is how they drift.
 */
export const PLAN_MODE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'bash',
  'skill_install',
  'skill_create',
  // `bash_kill` joins the BLOCKED set (D-12). It TERMINATES A PROCESS, which is
  // a mutation of the world and the complement's stated membership test. Nothing
  // is dead-ended by it: `Ctrl+C` and `/bg stop` both remain available to the
  // USER in plan mode, so the person can always stop what the agent started.
  'bash_kill',
]);

/**
 * Every tool name this host CAN register (7 built-ins + 4 skill tools).
 *
 * Exists because `aragon skills doctor` runs in a one-shot process with no
 * `AgentController` and therefore no live tool array, yet it is the primary
 * mitigation for "your declaration will never be enforceable" (RG1 / RG3 / RG5).
 * Without this it would have to report every skill as NOT ENFORCEABLE or check
 * nothing at all.
 *
 * Deliberately the SUPERSET rather than "what is registered right now": doctor
 * answers "can this declaration ever take effect?", not "is it in effect at this
 * instant". So `--no-skills` must still resolve `skill_create`. The runtime
 * ceiling keeps using the live `toolNames()` (§5.4c); these two lists are not
 * interchangeable, and a test asserts they agree.
 *
 * `/skills info` and the `/skills` ceiling summary use it for the same reason,
 * even though a TUI session does have a live tool array: both describe what a
 * declaration MEANS, and that reading must not change with how the CLI was
 * started.
 */
export const HOST_TOOL_NAMES = [
  'read_file',
  'write_file',
  'edit_file',
  'list_dir',
  'glob',
  'grep',
  'bash',
  'skill',
  'skill_find',
  'skill_install',
  'skill_create',
  'ask_user',
  'submit_plan',
  'todo_write',
  // Both names are here even though `bash.background: false` registers NEITHER,
  // and that is the constant's documented meaning rather than an inconsistency:
  // it is the SUPERSET of what this host CAN register, answering "can a skill's
  // `allowed-tools` declaration ever take effect?" — the same relationship
  // `skills doctor` already has with `--no-skills`.
  'bash_output',
  'bash_kill',
  // `team_send` / `team_wait` are DELIBERATELY ABSENT (P2-5). This constant
  // answers "can a skill's `allowed-tools` declaration ever take effect?", and
  // those two are never registered on a lead — so a skill naming them genuinely
  // IS unenforceable, and `aragon skills doctor` saying so is correct rather
  // than a gap. They reach children through `policyExempt`, a different
  // mechanism answering a different question.
  'task',
] as const;

function summarize(toolName: string, params: Record<string, unknown>): string {
  if (toolName === 'bash') return `Run: ${String(params.command ?? '')}`;
  if (toolName === 'write_file') return `Write: ${String(params.path ?? '')}`;
  if (toolName === 'edit_file') return `Edit: ${String(params.path ?? '')}`;
  return toolName;
}

/** Wrap a tool so its execution is gated behind a confirmation callback. */
function withConfirmation(
  tool: AgentTool,
  confirm: (req: ConfirmRequest) => Promise<boolean>,
): AgentTool {
  const original = tool.execute;
  return {
    ...tool,
    async execute(id, params, ctx): Promise<ToolResult> {
      const approved = await confirm({
        tool: tool.name,
        summary: summarize(tool.name, params as Record<string, unknown>),
        // Forwarded, not consumed, here: this wrapper still awaits the answer,
        // because a confirm that resolved itself on abort would let the tool run
        // unapproved. It is the confirm IMPLEMENTATION that decides what an
        // abort means (see `ConfirmRequest.signal`).
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (!approved) return errorResult('Cancelled by user.');
      return original(id, params, ctx);
    },
  };
}

/**
 * Wrap a tool in the turn-scoped ceiling (§5.4b). Same shape as
 * `withConfirmation` — `{...tool, execute}` — so nothing in the engine needs to
 * know this happened.
 *
 * NO DEDUPLICATION HERE. Announce-once bookkeeping belongs to `SkillRegistry`,
 * the only object that knows when a turn starts; a `Set` closed over in this
 * function would be session-scoped and would mute `warn` mode after one message.
 */
function withToolPolicy(
  tool: AgentTool,
  getDecision: () => ToolPolicyDecision,
  notify?: (e: { tool: string; verdict: ToolPolicyVerdict; sourceNames: string[] }) => void,
): AgentTool {
  const original = tool.execute;
  return {
    ...tool,
    async execute(id, params, ctx): Promise<ToolResult> {
      const decision = getDecision();
      const verdict = evaluateToolCall(tool.name, decision);
      if (verdict.notice) {
        // Runs BEFORE the refusal is returned, which is what lets the service
        // append its escalation line to `verdict.message` in place.
        notify?.({ tool: tool.name, verdict, sourceNames: decision.sourceNames });
      }
      if (!verdict.allow) return errorResult(verdict.message ?? `Tool "${tool.name}" is not permitted.`);
      return original(id, params, ctx);
    },
  };
}

/**
 * Wrap a tool in the plan-mode read-only gate. Same `{...tool, execute}` shape
 * as `withConfirmation` / `withToolPolicy`, so nothing in the engine needs to
 * know this happened.
 *
 * Read-only becomes a property of the WIRING rather than a promise in a prompt:
 * the badge says PLAN because these five cannot run, not because the model was
 * asked nicely.
 *
 * CODEACT IS NOT A HOLE TODAY, AND THAT IS WORTH WRITING DOWN. The
 * ```execute-js``` path in the core agent loop runs through `ctx.sandbox`, not
 * through any `AgentTool`, so no tool wrapper can see it. The CLI passes no
 * `sandbox` to `new Agent(...)`, which makes the path inert. Anyone wiring a
 * sandbox later must gate it as well, or plan mode gains a shell by the back
 * door.
 */
function withPlanModeGate(tool: AgentTool, getMode: () => AgentMode): AgentTool {
  const original = tool.execute;
  return {
    ...tool,
    async execute(id, params, ctx): Promise<ToolResult> {
      const mode = getMode();
      if (mode === 'plan' && PLAN_MODE_BLOCKED_TOOLS.has(tool.name)) {
        return errorResult(planRefusal(tool.name));
      }
      // Asymmetric on purpose: `ask_user` is available in BOTH modes, because a
      // clarifying question is never harmful and refusing a tool the model can
      // see just burns a turn. `submit_plan` mutates the session mode and only
      // means something while a plan is being reviewed.
      if (mode !== 'plan' && tool.name === 'submit_plan') {
        return errorResult(submitPlanRefusal());
      }
      return original(id, params, ctx);
    },
  };
}

export function createBuiltinTools(options: BuiltinToolsOptions): AgentTool[] {
  const deps: ToolDeps = {
    getCwd: options.getCwd,
    // The forward half of the two-interface note on `recordChange` above.
    ...(options.recordChange ? { recordChange: options.recordChange } : {}),
    // Added in the same shape and for the same reason (P1-1).
    ...(options.recordOutput ? { recordOutput: options.recordOutput } : {}),
    // And the third, in the same shape and for the same reason. The FORWARD half
    // of the two-interface note on `procs` above: without this line the field is
    // on both interfaces, nothing errors, and `bash` still hangs.
    ...(options.procs ? { procs: options.procs } : {}),
  };

  let tools: AgentTool[] = [
    makeReadFile(deps),
    makeWriteFile(deps),
    makeEditFile(deps),
    makeListDir(deps),
    makeGlob(deps),
    makeGrep(deps),
    // The second argument is spread CONDITIONALLY on the supervisor being
    // present, so with background services off `makeBash` receives its default
    // `{}` and produces the pre-feature tool: no `background` property in the
    // schema, the pre-feature description string, no supervisor call (I-2).
    makeBash(
      deps,
      options.procs
        ? {
            supervisor: options.procs,
            ...(options.autoBackground ? { autoBackground: options.autoBackground } : {}),
            ...(options.startupSettleMs ? { startupSettleMs: options.startupSettleMs } : {}),
            ...(options.interactive !== undefined ? { interactive: options.interactive } : {}),
          }
        : {},
    ),
  ];

  if (options.confirmTools && options.confirm) {
    const confirm = options.confirm;
    tools = tools.map((t) => (MUTATING_TOOLS.has(t.name) ? withConfirmation(t, confirm) : t));
  }

  if (options.skillTools && options.skillTools.length > 0) {
    tools = [...tools, ...options.skillTools];
  }

  if (options.planTools && options.planTools.length > 0) {
    tools = [...tools, ...options.planTools];
  }

  // AFTER `planTools`, BEFORE `teamTools`, so a lead's `task` stays last and
  // `HOST_TOOL_NAMES` changes by one insertion rather than a reshuffle.
  if (options.todoTools && options.todoTools.length > 0) {
    tools = [...tools, ...options.todoTools];
  }

  // AFTER `todoTools`, BEFORE `teamTools`, so a lead's `task` stays last and
  // `HOST_TOOL_NAMES` changes by two insertions rather than a reshuffle.
  if (options.procTools && options.procTools.length > 0) {
    tools = [...tools, ...options.procTools];
  }

  // BEFORE both wrappers, so the lead's `task` is covered by the plan gate and
  // the ceiling like everything else, and a child's comm tools are covered by
  // everything except the ceiling (see `policyExempt`).
  if (options.teamTools && options.teamTools.length > 0) {
    tools = [...tools, ...options.teamTools];
  }

  // --- The `aragon exec` permission filter (cli-integration-surface §4.2). ---
  //
  // ITS OWN `if`, AFTER THE LAST APPEND AND BEFORE THE `toolPolicy` WRAPPER, and
  // both tail returns below are left byte-identical (P1-1 / R-6).
  //
  // AFTER THE APPENDS so `skillTools` / `planTools` / `todoTools` / `teamTools`
  // are all subject to it. BEFORE THE WRAPPERS so neither of the two independent
  // guards at the end of this function has to move: the v1 instruction "applied
  // last, after the plan gate" was unimplementable (the function ends in TWO
  // returns, so there is no position after both that is not after the whole
  // function) and reaching for one pushes an implementer into restructuring the
  // exact tail whose comment records the `--no-skills --plan` bug.
  //
  // ORDERING IS A PROPERTY OF WRAPPERS, NOT OF FILTERS. The rule below is about
  // NESTING at call time - which gate runs before which, and therefore who pays
  // for a human wait. A filter removes array elements and has no call-time
  // position at all; every wrapper preserves `.name` through `{...tool}`, so
  // `filter . map === map . filter` here and this placement is chosen for the
  // two structural reasons above rather than for a semantic one.
  //
  // THE GUARD IS WHAT MAKES AC-28 CHECKABLE. Omitting `permission` must leave
  // the tool OBJECTS untouched, provable by identity - the `AC-G17` discipline.
  if (options.permission) {
    const permission = options.permission;
    tools = tools.filter((t) => permission.isAllowed(t.name));
  }

  // No decision provider (`--no-skills`, or a caller that never enabled the
  // policy) means the ceiling adds nothing.
  //
  // A ceiling that always says "allow" would behave identically, so skipping it
  // buys nothing at run time — it buys the ability to PROVE the claim. AC-G17
  // asserts object identity on this path; with a wrapper in place, "the
  // `--no-skills` path is unchanged from iteration 2" would demote from a fact
  // anyone can check to an argument someone has to trust.
  //
  // Outermost on purpose (D-G11). Asking a human "run bash?", waiting for them
  // to say yes, and only then reporting that policy refused it is the worst
  // available ordering. The ceiling needs no I/O, so it goes before confirmation.
  if (options.toolPolicy) {
    const getDecision = options.toolPolicy;
    const exempt = options.policyExempt;
    tools = tools.map((t) =>
      exempt?.has(t.name) ? t : withToolPolicy(t, getDecision, options.onToolPolicyEvent),
    );
  }

  // TWO OPTIONS, TWO INDEPENDENT GUARDS, NO SHARED EXIT.
  //
  // This used to be a single `if (!options.toolPolicy) return tools;` early
  // return ending the function. That return sits BEFORE the plan gate, and
  // `--no-skills` / `ARAGON_SKILLS=0` supply no decision provider — so
  // `aragon --no-skills --plan` returned before the gate was applied and ran
  // with write_file / edit_file / bash fully live while the badge said PLAN.
  // If you ever collapse these two guards back into one, that is the bug you
  // are reintroducing, and nothing reports it (AC-P20 / I-P3).
  //
  // The plan gate is applied LAST, which makes it OUTERMOST at call time: it
  // needs no I/O and no state, so it must not sit behind a human wait.
  if (!options.agentMode) return tools;
  const getMode = options.agentMode;
  return tools.map((t) => withPlanModeGate(t, getMode));
}
