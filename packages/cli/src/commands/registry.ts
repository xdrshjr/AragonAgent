/**
 * Slash-command registry + dispatcher (spec §5.2). A leading `/` in the prompt
 * input is routed here instead of to the agent; `//` is the literal-`/` escape.
 */

import type { SubmitMessageOptions } from '../agent/prompt-options.js';
import type { CopyRequest, CopyRequestResult } from '../ui/clipboard-task.js';

import type { AgentController } from '../agent/controller.js';
import type { AgentMode } from '../agent/agent-mode.js';
import type { NoticeLevel, Overlay, ToastLevel, ViewAction, ViewState } from '../agent/reducer.js';
import type { PersistedConfig } from '../config/schema.js';
import type { FollowThroughBudget } from '../todo/follow-through.js';
// `import type`, so tsc ERASES the specifier and `dist/commands/registry.js`
// gains a type edge into `update/` and no runtime edge (cli-auto-update §3.1
// rule 1 / P1-7). A value import here would put the updater in the graph of
// every command, including under `aragon -p`.
import type { UpdateCommandPort } from '../update/types.js';

export interface CommandContext {
  /** App-owned shared lock and single feedback path for command and selection copies. */
  requestCopy?: (request: CopyRequest) => Promise<CopyRequestResult>;
  /** Raw argument string after the command word (may be empty). */
  args: string;
  controller: AgentController;
  state: ViewState;
  dispatch: (action: ViewAction) => void;
  setOverlay: (overlay: Overlay) => void;
  /** Durable transcript message (errors, listings, saved paths). */
  notify: (level: NoticeLevel, text: string) => void;
  /** Ephemeral, auto-dismissing acknowledgement (spec §3.9). */
  toast: (level: ToastLevel, text: string) => void;
  persistConfig: (patch: Partial<PersistedConfig>) => void;
  exit: () => void;
  /**
   * Submit `text` as if the user had typed it (steers when running, prompts when
   * idle). Dynamic skill commands need this: they turn `/pdf-forms a.pdf` into a
   * real user message. It is a separate entry point from `handleSubmit` on
   * purpose — routing back through that would re-enter slash-command parsing.
   *
   * `userInitiated: false` suppresses `recordPrompt` (todo-plan-followthrough
   * C-12 / AC-17), which skips TWO things and both are wanted: the prompt-history
   * append, and the `submitCount` bump that drives the composer's hint fade. A
   * canned string the user did not type belongs in neither. The parameter is
   * named for the CAUSE rather than for one of its effects, because a flag
   * called `recordHistory` would have made the second one look like a bug.
   *
   * WIDENING THIS SIGNATURE IS THE WHOLE REASON THIS FILE IS IN THE CHANGE PLAN
   * (P1-5): `builtins.ts` reaches `submitMessage` only through here, so
   * `/todo continue` cannot opt out of prompt history without it.
   */
  submit: (text: string, opts?: SubmitMessageOptions) => void;
  /**
   * The live auto-continue budget, for `/todo status`'s `(2/25 used)` clause
   * (todo-plan-followthrough §4.3).
   *
   * READ-ONLY AND OPTIONAL. It lives in an `App` ref rather than on the
   * controller or in `ViewState` (§4.4 / §5.2) because it counts a SESSION'S
   * INTERACTION WITH THE USER, not the model's plan — so this is the only way a
   * command can see it, and `makeCtx` is the only place that supplies it.
   * Optional so the many test contexts that build this object by literal need no
   * change; absent means the clause degrades to naming the ceiling alone.
   */
  followBudget?: FollowThroughBudget;
  /**
   * The updater, when this session has one (cli-auto-update §4.4 / C-14 / P0-2).
   *
   * `/fast`, `/team` and `/todo` reach their subsystems through `controller`,
   * because those subsystems live on `AgentController`. This one does not, and
   * by §3.1 it MUST NOT — `update/` may not import `agent/` — so it needs its
   * own field, and this is the only seam a slash command has.
   *
   * OPTIONAL, for two independent reasons. The service is legitimately absent
   * under `update.mode: 'off'`, on a non-TTY and in CI (§3.8), so `/update` has
   * to have something honest to say when it is missing; and a REQUIRED field
   * would break every existing `CommandContext` fixture in this package at
   * compile time, for a feature none of them are about. `followBudget` above is
   * the precedent for an optional, read-at-command-time member.
   */
  update?: UpdateCommandPort;
  /** Rebuild the system prompt and the dynamic command list after a skill change. */
  refreshSkills: () => void;
  /**
   * Apply a mode change through the App's SINGLE write path (§3.1 / R-P7).
   *
   * `controller` and `dispatch` are both already in this context, so `/plan`
   * COULD write the controller and dispatch the mirror itself — and that would
   * be a second mode write path, which is the one thing the `setAgentMode`
   * signature was shaped to forbid. One line here instead keeps `/plan` and
   * `Shift+Tab` literally the same code.
   *
   * Returns the ADOPTED state, because `plan -> build` may be deferred and the
   * command has to report what actually happened, not what it asked for.
   */
  applyAgentMode: (next: AgentMode) => { effective: AgentMode; pending: AgentMode | null };
  /**
   * Mouse capture, for `/mouse` (tui-selection-and-scroll-follow §6.2 / G3).
   *
   * OPTIONAL, and legitimately absent: `--no-mouse`, a non-TTY, a
   * Windows console that cannot deliver reports, and every test that builds this
   * context by literal. `/mouse` has to have something honest to say when it is
   * missing, which is the same reason `update` above it is optional.
   */
  mouse?: MouseCommandPort;
  /**
   * The foreign-write door, for `/copy`'s OSC 52 half (§4.4.5).
   *
   * NOT `process.stdout.write`. In full-screen mode stdout is a `Proxy` in front
   * of the frame differ, and an unrecognised chunk there is counted as a foreign
   * write and prints a diagnostic at the user the first time they copy anything
   * (P1-6). Absent with `--no-diff-render`, where the real
   * stream is handed over directly.
   */
  writeForeign?: (text: string) => void;
}

/** What `/mouse` can see and do. Read at command time, never captured. */
export interface MouseCommandPort {
  /** Whether the CLI is holding the mouse right now. */
  captured(): boolean;
  /** Whether drag-select is on for this session (`mouseSelect`). */
  selectEnabled(): boolean;
  setCapture(on: boolean): void;
}

export interface SlashCommand {
  name: string;
  aliases?: string[];
  description: string;
  run: (ctx: CommandContext) => void | Promise<void>;
}

export class CommandRegistry {
  private readonly byName = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.byName.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.byName.set(alias, command);
    }
  }

  get(name: string): SlashCommand | undefined {
    return this.byName.get(name);
  }

  all(): SlashCommand[] {
    // De-duplicate aliases pointing at the same command.
    return Array.from(new Set(this.byName.values()));
  }
}

/**
 * Try to run a slash command from raw input. Returns `true` if the input was a
 * (known or unknown) slash command and was consumed; `false` if it is a normal
 * message that should go to the agent.
 */
export async function runSlashInput(
  registry: CommandRegistry,
  input: string,
  makeCtx: (args: string) => CommandContext,
): Promise<boolean> {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith('/')) return false;
  // `//...` escapes a literal leading slash — not a command.
  if (trimmed.startsWith('//')) return false;

  const withoutSlash = trimmed.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const name = spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : withoutSlash.slice(spaceIdx + 1).trim();

  const command = registry.get(name);
  const ctx = makeCtx(args);
  if (!command) {
    ctx.notify('warn', `Unknown command "/${name}" - try /help.`);
    return true;
  }
  await command.run(ctx);
  return true;
}
