/**
 * Agent mode vocabulary (plan-mode §5.1).
 *
 * Pure: no React, no I/O, no `node:*`. Imported by the controller, the tool
 * gate, the prompt builder, the slash command and four UI components, which is
 * exactly why it must stay free of every one of their dependencies.
 *
 * `PLAN_MODE_BLOCKED_TOOLS` is deliberately NOT here. It lives in
 * `tools/index.ts` beside `SKILL_TOOL_FLOOR`, because the invariant worth having
 * is that the two sets PARTITION `HOST_TOOL_NAMES` — and a partition test is
 * only as trustworthy as the distance between the two definitions. This file
 * owns the mode vocabulary; that file owns which tools the modes act on.
 *
 * ASCII ONLY in every string literal below. `agent/` is inside the glyph
 * scanner's scope (`glyphs.test.ts`), so a stray ellipsis here fails the build —
 * which is why `OTHER_OPTION_LABEL` is a bare word and the ellipsis is appended
 * at render time from `glyphs.ellipsis`.
 */

export type AgentMode = 'build' | 'plan' | 'unrestricted';

export const AGENT_MODES: readonly AgentMode[] = ['build', 'plan', 'unrestricted'] as const;

/** The user-visible word for each mode. English, per the repo convention. */
export const MODE_LABEL: Record<AgentMode, string> = {
  build: 'BUILD',
  plan: 'PLAN',
  unrestricted: 'UNRESTRICTED',
};

/**
 * The next mode in the cycle.
 *
 * Written as a cycle rather than a boolean flip so that adding Claude Code's
 * "auto-accept edits" as a third posture is a one-line change to `AGENT_MODES`
 * and nothing else. Three ship today: `plan` tightens to read-only;
 * `unrestricted` swaps in the operator's instruction package (entry is
 * refused when no validated package is installed).
 */
export function nextMode(current: AgentMode): AgentMode {
  const index = AGENT_MODES.indexOf(current);
  return AGENT_MODES[(index + 1) % AGENT_MODES.length]!;
}

/**
 * The keys that toggle the mode, as the user sees them written
 * (shift-tab-mode-toggle-still-dead-on-windows, C2).
 *
 * `fallback` exists because `primary` CANNOT be made to work everywhere. On a
 * Windows console without `ENABLE_VIRTUAL_TERMINAL_INPUT`, libuv takes the
 * character branch for `VK_TAB` and drops the modifier wholesale, so `Shift+Tab`
 * and `Ctrl+Tab` both arrive as a bare `0x09` - byte-identical to `Tab`. C1
 * turns that bit back on where it can, but it has three known ways to fail that
 * are outside this package (an old conhost refusing the bit, a locked-down
 * PowerShell, a foreign process resetting the mode), so a rung that depends on
 * NOTHING has to exist underneath it.
 *
 * `ctrl+p` IS MEASURED, not guessed. On the lossy path it arrives as `0x10`,
 * because Windows generates a real control character for `Ctrl+<letter>` and
 * libuv's character branch forwards it untouched; `Alt+M` produces no bytes at
 * all and `Ctrl+Tab` collapses exactly like `Shift+Tab` (analysis section 3.6).
 * Any idle `Ctrl+<letter>` in the `0x01-0x1A` range would work; this one is free
 * throughout the package - `keymap.ts` claims a/e/w/u/k, `App` claims c/l/t/o,
 * and `PromptInput` returns early on every `key.ctrl` - so binding it takes no
 * behaviour away from anyone. `Ctrl+B` survives the same path but is tmux's
 * default prefix, and this binding is unconditional and cross-platform, so it
 * would be silently dead for a whole class of macOS and Linux users.
 *
 * BOUND UNCONDITIONALLY, on every platform. A binding that only exists where it
 * is needed cannot be documented in one place, cannot be taught by muscle
 * memory, and is missing on precisely the machine whose capability probe was
 * wrong.
 *
 * THESE ARE THE LABELS, NOT THE BINDING. Editing a value here changes only what
 * the user is TOLD to press - the hint row, the startup notice, `doctor`. The
 * key that is actually listened for is `input === 'p'` in `App`'s `useInput`,
 * and the help overlay and README spell both keys out in their own title case.
 * Change one without the others and the product advertises a key it ignores.
 */
export const MODE_TOGGLE_KEYS = { primary: 'shift+tab', fallback: 'ctrl+p' } as const;

/** The two tools that only exist because a human is attached. */
export const PLAN_TOOL_NAMES = ['ask_user', 'submit_plan'] as const;

/**
 * The synthetic free-text option appended to every question.
 *
 * Plain `Other`, with no ellipsis: this module is inside the glyph scanner's
 * scope, and the overlay appends `glyphs.ellipsis` itself so the label degrades
 * to `Other...` on a terminal without Unicode.
 */
export const OTHER_OPTION_LABEL = 'Other';

/** Read-only alternatives named in every refusal, so the model has somewhere to go. */
const READ_ONLY_ALTERNATIVES = 'read_file / list_dir / glob / grep';

/**
 * Why a mutating tool was refused in plan mode.
 *
 * The wording carries weight beyond politeness (§3.9). A run that flips
 * `build -> plan` mid-flight keeps its original system prompt to the end — the
 * loop reads `ctx.systemPrompt`, which was copied by value when the run
 * started — so for the rest of that run this refusal is the ONLY place the
 * model learns that plan mode is on. A bare "not permitted" reads as a tool
 * malfunction and gets retried.
 */
export function planRefusal(tool: string): string {
  const extra =
    tool === 'bash'
      ? ' bash is refused in full, including read-only commands like "git status":' +
        ' a shell string cannot be classified reliably, and a gate that is right' +
        ' most of the time is worse than one that is always right.'
      : '';
  return (
    `Plan mode is active, so ${tool} is refused.${extra}` +
    ` Use ${READ_ONLY_ALTERNATIVES} to research, then call submit_plan.` +
    ' Do not try to work around this; finish the plan instead.'
  );
}

/** Why `submit_plan` was refused outside plan mode. */
export function submitPlanRefusal(): string {
  return (
    'submit_plan is only available in Plan mode. You are in Build mode - ' +
    'just do the work and summarize when you are done.'
  );
}
