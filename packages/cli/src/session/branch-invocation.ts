/**
 * What command the new terminal runs (tui-branch-terminal-shortcut 3.4).
 *
 * ASCII ONLY - `src/session/**` is inside `glyphs.test.ts::inScope`.
 *
 * THIS MODULE PRODUCES NO IO ITSELF. It answers two questions and nothing else:
 * "which argv pieces make up the aragon command" and "how does that sentence read
 * when printed to a human". Spawning lives in `session/branch-launch.ts`, and the
 * terminal ladder lives in `proc/terminal-plan.ts`, so the one part of this
 * feature that a unit test can pin exactly - the command line - is not buried
 * inside an `spawn()` call. The repository already draws the boundary this way:
 * `proc/readiness.ts` and `proc/classify.ts` are pure, `proc/supervisor.ts` is the
 * part that touches processes.
 *
 * IT DOES IMPORT `proc/terminal-plan.ts` (D-5), and that is still the right
 * direction: `session -> proc`. The manual line needs both quoting dialects, and
 * the dialect owner is `proc/terminal-plan.ts`; putting it in `proc/` would mean
 * `proc/` importing `session/`, which is the cycle the header above forbids.
 * What that import brings with it is one `statSync` probe used by the PATH lookup -
 * not a process, not a write - so "no IO on purpose" still describes this module's
 * own behaviour.
 *
 * NAMED `branch-invocation`, NOT `branch-command` (R-22): `commands/branch-command.ts`
 * is the command body, and two files with one basename make every import, stack
 * trace and grep ambiguous. What this module exports is an *invocation*.
 */

import { isAbsolute } from 'node:path';
import { powerShellScript } from '../proc/terminal-plan.js';
import { isValidSessionId } from './store.js';

/** Which of the three resolution rules produced the command (D-8). */
export type AragonCommandKind = 'override' | 'script' | 'bin';

export interface AragonCommandResolution {
  /** argv pieces, ready to hand to a shell or a terminal emulator. */
  parts: string[];
  kind: AragonCommandKind;
  /** Human-readable note for the log and the error copy. Never part of the command. */
  origin: string;
}

export interface BranchInvocation {
  /** `[...aragon.parts, '--resume', id]`. */
  parts: string[];
  /**
   * One line, for the toast and the log.
   *
   * NOT THE PASTEABLE FORM ON WIN32 - and the defect that produced this comment is
   * the proof: a double-quoted command word is a string EXPRESSION to PowerShell, so
   * pasting this line into the shell Windows Terminal opens by default yields the
   * same `ParserError` the new window used to. `renderManualCommand(parts,
   * platform)` is the paste-ready form; on win32 it is two labelled lines.
   */
  command: string;
}

export const BRANCH_RESUME_FLAG = '--resume';

/** The env var that overrides "what executable the new window runs" (D-7 sibling). */
export const ARAGON_BRANCH_COMMAND_ENV = 'ARAGON_BRANCH_COMMAND';

/** Longest prefix of a rejected id that reaches the user's screen. */
const REJECTED_ID_PREVIEW_CELLS = 24;

/**
 * A path that could be a script we are already running (`node <script.js>`).
 *
 * Anchored and case-insensitive: Windows writes `.JS` in the wild, and an
 * unanchored variant would also match `cli.js.bak` - which is not something node
 * could have been invoked with.
 */
const SCRIPT_PATH_RE = /\.(?:js|cjs|mjs)$/i;

/**
 * Decide what to execute in the new window (D-8), first match wins.
 *
 * The precedence exists because `aragon` is NOT on PATH in three of this
 * repository's own four ways of running: `npm run dev:cli`, `npx
 * @aragon-agent/cli`, and `node packages/cli/dist/cli.js`. Rule 2 recovers all
 * three from `process.execPath` + `process.argv[1]` without consulting PATH at
 * all, which is the only way "press the key and something starts" holds on a
 * machine where the global install is missing.
 *
 * The override is treated as ONE executable path and never split into arguments:
 * splitting needs a shell parser, and a shell parser is what re-introduces the
 * quoting problem this feature spends a whole module avoiding. The documented
 * escape hatch is a `.cmd` / `.sh` wrapper.
 */
export function resolveAragonCommand(input: {
  argv: readonly string[];
  execPath: string;
  env: Record<string, string | undefined>;
}): AragonCommandResolution {
  const override = input.env[ARAGON_BRANCH_COMMAND_ENV];
  if (override !== undefined && override.length > 0) {
    return {
      parts: [override],
      kind: 'override',
      origin: `${ARAGON_BRANCH_COMMAND_ENV}=${override}`,
    };
  }
  const script = input.argv[1];
  if (script !== undefined && isAbsolute(script) && SCRIPT_PATH_RE.test(script)) {
    return {
      parts: [input.execPath, script],
      kind: 'script',
      origin: 'process.execPath + process.argv[1]',
    };
  }
  return { parts: ['aragon'], kind: 'bin', origin: 'aragon on PATH' };
}

/**
 * `parts` + `--resume <id>`, plus the ONE-LINE form for the toast and the log.
 *
 * The paste-ready form is NOT this field (see `BranchInvocation.command` and
 * `renderManualCommand`): "one line for every shell" was the claim this branch
 * disproved, and leaving it here would keep the next reader believing it.
 */
export function buildResumeInvocation(input: {
  id: string;
  aragon: AragonCommandResolution;
}): BranchInvocation {
  const parts = [...input.aragon.parts, BRANCH_RESUME_FLAG, input.id];
  return { parts, command: joinCommandLine(parts) };
}

/**
 * Join argv pieces into one line a human can read at a glance.
 *
 * NOT A SHELL ESCAPER, and no longer claimed to be a universal paste line: it is
 * the RIGHT line for `cmd.exe` and for POSIX shells, and the WRONG one for
 * PowerShell on win32 (a double-quoted command word is an expression there). Its
 * product is what a POSIX/darwin user pastes, and what the `cmd.exe` half of the
 * win32 manual block shows; the PowerShell half comes from `powerShellScript` via
 * `renderManualCommand`. The real command lines are built by
 * `proc/terminal-plan.ts`, which quotes for the exact parser each rung lands in.
 */
export function joinCommandLine(parts: readonly string[]): string {
  return parts.map(quoteForDisplay).join(' ');
}

/**
 * The paste-ready form of the command, per platform (D-5 / D-6 / I-4).
 *
 * ONE LINE CANNOT BE CORRECT FOR BOTH WINDOWS PARSERS. A double-quoted command word
 * is a string EXPRESSION to PowerShell (the defect this branch fixes) while it is
 * exactly right for `cmd.exe`; `& 'x'` is right for PowerShell and wrong for
 * `cmd.exe` (which keeps the single quotes and tries to run `'x'`). So Windows gets
 * two labelled lines and the user copies the one matching the terminal they opened;
 * POSIX and macOS keep the single line they have always printed.
 *
 * The first line is `powerShellScript(parts)` VERBATIM, which is what makes I-1
 * ("one command, one artefact") testable: the fallback the user pastes is the same
 * text the new window receives in its `-EncodedCommand` payload.
 *
 * @param parts argv pieces of the aragon invocation, `--resume <id>` included.
 * @param platform the platform whose parsers the two lines have to satisfy.
 * @returns one line off Windows; two ASCII lines labelled `PowerShell:` and
 *   `cmd.exe   :` on win32. Both labels are 11 columns wide on purpose.
 */
export function renderManualCommand(
  parts: readonly string[],
  platform: NodeJS.Platform,
): string {
  if (platform !== 'win32') return joinCommandLine(parts);
  return [
    `PowerShell: ${powerShellScript(parts)}`,
    `cmd.exe   : ${joinCommandLine(parts)}`,
  ].join('\n');
}

/** Empty and whitespace-or-quote-bearing pieces get double quotes; the rest stay bare. */
function quoteForDisplay(part: string): string {
  if (part.length === 0) return '""';
  if (!/[\s"]/.test(part)) return part;
  return `"${part.replace(/"/g, '\\"')}"`;
}

/**
 * The second gate on D-9: an id is about to be concatenated into a command line.
 *
 * The command body checks first (it owns the user-facing sentence). This check
 * exists because a future caller can go straight to `buildResumeInvocation`, and
 * the injection defence belongs at the boundary that builds the string rather
 * than at the one call site that happens to exist today.
 *
 * Returns `null` when the id is usable, otherwise one sentence naming the actual
 * value (`<= 64 characters`, first 24 of it) so the user can see what was wrong.
 */
export function validateBranchId(id: string): string | null {
  if (isValidSessionId(id)) return null;
  const preview = id.slice(0, REJECTED_ID_PREVIEW_CELLS);
  return `Session id "${preview}" is not a legal file name, so it cannot be resumed.`;
}
