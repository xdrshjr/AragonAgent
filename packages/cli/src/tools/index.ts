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
} from '@argon-agent/core';
import type { ToolDeps } from './fs-tools.js';
import { makeReadFile, makeWriteFile, makeEditFile, makeListDir } from './fs-tools.js';
import { makeGlob, makeGrep } from './search-tools.js';
import { makeBash } from './bash-tool.js';

export interface ConfirmRequest {
  tool: string;
  summary: string;
}

export interface BuiltinToolsOptions {
  getCwd: () => string;
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
   * Omitting this leaves every tool unwrapped — see the early return below.
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
] as const;

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

export function createBuiltinTools(options: BuiltinToolsOptions): AgentTool[] {
  const deps: ToolDeps = { getCwd: options.getCwd };

  let tools: AgentTool[] = [
    makeReadFile(deps),
    makeWriteFile(deps),
    makeEditFile(deps),
    makeListDir(deps),
    makeGlob(deps),
    makeGrep(deps),
    makeBash(deps),
  ];

  if (options.confirmTools && options.confirm) {
    const confirm = options.confirm;
    tools = tools.map((t) => (MUTATING_TOOLS.has(t.name) ? withConfirmation(t, confirm) : t));
  }

  if (options.skillTools && options.skillTools.length > 0) {
    tools = [...tools, ...options.skillTools];
  }

  // No decision provider (`--no-skills`, or a caller that never enabled the
  // policy) means the tools go out exactly as they came in.
  //
  // A ceiling that always says "allow" would behave identically, so this early
  // return buys nothing at run time — it buys the ability to PROVE the claim.
  // AC-G17 asserts object identity on this path; with a wrapper in place, "the
  // `--no-skills` path is unchanged from iteration 2" would demote from a fact
  // anyone can check to an argument someone has to trust.
  if (!options.toolPolicy) return tools;

  // Outermost on purpose (D-G11). Asking a human "run bash?", waiting for them
  // to say yes, and only then reporting that policy refused it is the worst
  // available ordering. The ceiling needs no I/O, so it goes first.
  const getDecision = options.toolPolicy;
  return tools.map((t) => withToolPolicy(t, getDecision, options.onToolPolicyEvent));
}
