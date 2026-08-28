/**
 * `aragon history path | list | clear` — the prompt history's operations
 * surface (config-state-separation §5.5).
 *
 * Exit codes follow the existing convention: 0 success · 1 run-time failure ·
 * 2 usage error.
 *
 * EXEMPT from the "every subcommand records one info line" rule, for the same
 * reason `logging/cli-commands.ts` is: recording a line opens today's log file,
 * and a command whose job is to delete the user's data should not be creating
 * files as a side effect of announcing itself.
 */

import { existsSync } from 'node:fs';
import process from 'node:process';
import { getPromptHistoryPath } from './app-paths.js';
import { clearPromptHistory, listPromptHistory } from './prompt-history.js';

export interface HistoryCliOptions {
  /** `-n <N>` — entries printed by `list` (default 20). */
  lines?: string;
  json?: boolean;
  /** Required by `clear`; without it the command refuses. */
  yes?: boolean;
}

const EXIT_OK = 0;
const EXIT_USAGE = 2;

const DEFAULT_LIST_ENTRIES = 20;

export function runHistoryCommand(subcommand: string, opts: HistoryCliOptions): number {
  switch (subcommand) {
    case 'path':
      return runPath();
    case 'list':
      return runList(opts);
    case 'clear':
      return runClear(opts);
    default:
      process.stderr.write(
        `Unknown history subcommand "${subcommand}". Try: path | list | clear.\n`,
      );
      return EXIT_USAGE;
  }
}

function runPath(): number {
  const path = getPromptHistoryPath();
  process.stdout.write(`${path}\n`);
  if (!existsSync(path)) process.stdout.write('(no history recorded yet)\n');
  // The file holds prompts verbatim — the one thing to say out loud before
  // someone attaches it to a bug report or copies it to another machine.
  process.stdout.write(
    'entries are stored verbatim; clear them with: aragon history clear --yes\n',
  );
  return EXIT_OK;
}

function runList(opts: HistoryCliOptions): number {
  const entries = listPromptHistory();
  if (entries.length === 0) {
    process.stdout.write('No prompt history recorded.\n');
    return EXIT_OK;
  }

  const parsed = Number.parseInt(opts.lines ?? '', 10);
  const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIST_ENTRIES;
  const shown = entries.slice(0, wanted);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
    return EXIT_OK;
  }
  for (const entry of shown) {
    // Newlines would break the one-entry-per-line reading this output invites.
    const text = entry.text.replace(/\r?\n/g, ' ');
    process.stdout.write(`${new Date(entry.ts).toISOString()}  ${text}\n`);
  }
  return EXIT_OK;
}

function runClear(opts: HistoryCliOptions): number {
  if (!opts.yes) {
    process.stderr.write('Refusing to delete the prompt history without --yes.\n');
    return EXIT_USAGE;
  }
  const removed = clearPromptHistory();
  process.stdout.write(`Removed ${removed} entries.\n`);
  return EXIT_OK;
}
