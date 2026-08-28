/**
 * `aragon exec` commander wiring (cli-integration-surface section 3.1).
 *
 * ASCII ONLY - `src/exec/**` is inside the glyph scanner's scope.
 *
 * THE DECLARATIONS LIVE HERE, NOT IN `cli.tsx`, AND THAT IS A DELIBERATE
 * DEPARTURE FROM THE EXISTING CONVENTION. `logs` / `history` / `skills` /
 * `update` declare their options in `cli.tsx` and delegate to a `run*Command`.
 * `cli.tsx` is already 1600 lines against this repository's 1000-line guideline,
 * and four new subcommands carrying about twenty declarations between them is
 * another 120 lines on a file that is 60% over budget. So `cli.tsx` gains four
 * imports and four `register*Command(...)` call sites instead. This is a rule
 * for the NEW code, not a refactor of the old (which is out of scope).
 *
 * NOT `src/commands/` EITHER: that directory is the SLASH-command tree
 * (`/help`, `/model`, `/save`, `/resume`), and it already owns the two names
 * exec's session work sits closest to.
 */

import { Option, type Command } from 'commander';
import type { CliFlags } from '../config/load.js';
import { runExec, type ExecControllerFactory } from './index.js';
import type { RawExecOptions } from './options.js';

export interface ExecCommandDeps {
  version: string;
  /**
   * Supplied by `cli.tsx`. It cannot be imported: `cli.tsx` imports this module,
   * so reaching back for `makeController` would be a cycle, and re-deriving it
   * here would give the headless approval gates a second definition.
   */
  makeController: ExecControllerFactory;
}

export function registerExecCommand(
  program: Command,
  toFlags: (opts: Record<string, unknown>) => CliFlags,
  deps: ExecCommandDeps,
): void {
  const exec = program
    .command('exec')
    .description('Headless, machine-facing run: JSON events, sessions, tool permissions, budgets')
    .argument('[prompt]', 'The prompt (or use --prompt-file, or pipe it on stdin)')
    .option('--output-format <fmt>', 'text | json | stream-json (default: text)')
    .option('--input-format <fmt>', 'text | stream-json (needs --output-format stream-json)')
    .option('--partial-messages', 'Emit text_delta events (stream-json only)')
    .option('--include-thinking', 'Emit thinking events (stream-json only)')
    .option('--prompt-file <path>', 'Read the prompt from a file')
    .option('--session-id <id>', 'Create or resume a session by id')
    .option('--resume <id|path>', 'Resume an existing session; fail if it is absent')
    .option('-c, --continue', 'Resume the newest session for this working directory')
    .option('--no-save-session', 'Run statelessly: write nothing to the sessions directory')
    .option('--max-turns <n>', 'Stop after n assistant turns (exit 3)')
    .option(
      '--max-duration <ms>',
      'Stop after ms of wall clock (exit 3). --idle-timeout still applies to a silent ' +
        'stretch inside the run, and --tool-timeout to a single tool call',
    )
    .option('--permission-mode <m>', 'auto | plan | strict (default: auto)')
    .option(
      '--allow-tool <names>',
      'Add tools to the baseline (repeatable; comma-separated accepted)',
      collect,
    )
    .option(
      '--deny-tool <names>',
      'Remove tools; wins over --allow-tool (repeatable; comma-separated accepted)',
      collect,
    )
    .option('--append-system-prompt <text>', 'Append text to the builtin system prompt')
    .option('--append-system-prompt-file <path>', 'Append the contents of a file')
    // HIDDEN, AND KEPT ONLY SO A GUESS IS NOT PUNISHED (P2-1 / D-16). The root
    // command already carries `--tool-timeout` (a single tool call) and
    // `--idle-timeout` (the engine watchdog); a third option called plainly
    // `--timeout` would be the most generic of the three names attached to the
    // newest and least familiar of them.
    .addOption(new Option('--timeout <ms>', 'Alias of --max-duration').hideHelp());

  exec.action(async (prompt: string | undefined, opts: RawExecOptions) => {
    const rootOpts = program.opts() as { quiet?: boolean; print?: boolean };
    process.exitCode = await runExec(
      toFlags(program.opts()),
      {
        ...opts,
        // Hoisted from the root by commander, and read here because `exec` does
        // not redeclare them. `--print` is REFUSED rather than ignored (P2-5).
        ...(rootOpts.quiet !== undefined ? { quiet: rootOpts.quiet } : {}),
        ...(rootOpts.print !== undefined ? { print: rootOpts.print } : {}),
      },
      prompt,
      { version: deps.version, makeController: deps.makeController },
    );
  });
}

/** Repeatable option accumulator. Comma splitting happens in `options.ts`. */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}
