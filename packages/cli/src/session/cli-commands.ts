/**
 * `aragon sessions` (cli-integration-surface section 4.3).
 *
 * ASCII ONLY - `src/session/**` is inside the glyph scanner's scope from this
 * feature onward.
 *
 * `list` AND `prune` SEE ONLY EXEC-MANAGED SESSIONS (P1-5 / R-16 / AC-23). The
 * sessions directory is SHARED with the TUI's `/save`, so a sweep that treated
 * every `*.json` as its own would destroy conversations a human saved by hand -
 * unrecoverable loss, triggered by a maintenance command the docs recommend.
 * `--all` opts in and says how many foreign files it will touch; `show` and `rm`
 * take any id, because the user named it.
 *
 * NOTHING IS EVER DELETED AUTOMATICALLY. `sessions list` makes the growth
 * visible; deciding to delete a user's conversations is not a call this CLI
 * should make on its own.
 */

import process from 'node:process';
import type { Command } from 'commander';
import {
  isValidSessionId,
  listSessions,
  pruneSessions,
  readSessionFile,
  removeSession,
  sessionPathFor,
  sessionsDir,
  type SessionListEntry,
} from './store.js';

/**
 * One wording for one rule, shared by `show` and `rm`.
 *
 * It is deliberately the same sentence `--session-id` produces: a caller who
 * meets the rule once should recognise it everywhere, and two spellings of the
 * same refusal read as two different rules.
 */
const INVALID_ID_MESSAGE = (id: string): string =>
  `Invalid session id "${id}". Use 1-64 characters matching ` +
  '[A-Za-z0-9][A-Za-z0-9._-]* (no "/", "\\", ".." or a leading dot). ' +
  'Pass a path to `aragon exec --resume` if you mean a file elsewhere.';

export interface SessionsCliOptions {
  json?: boolean;
  lines?: string;
  all?: boolean;
  olderThan?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const SUBCOMMANDS = ['list', 'show', 'rm', 'prune', 'path'] as const;

export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions [subcommand] [argument]')
    .description('Manage `aragon exec` sessions: list | show | rm | prune | path')
    .option('--json', 'Machine-readable output')
    .option('-n, --lines <n>', 'Entries for `sessions list` (default 20)')
    .option('--all', 'Include sessions this CLI did not create (TUI `/save` files)')
    .option('--older-than <days>', 'Only prune sessions untouched for this many days')
    .option('--dry-run', 'Print what `sessions prune` would delete, and delete nothing')
    .option('--yes', 'Confirm destructive actions (required by `rm` and `prune`)')
    .action((subcommand: string | undefined, argument: string | undefined, opts: SessionsCliOptions) => {
      process.exitCode = runSessionsCommand(subcommand ?? 'list', argument, opts);
    });
}

export function runSessionsCommand(
  subcommand: string,
  argument: string | undefined,
  opts: SessionsCliOptions,
): number {
  switch (subcommand) {
    case 'path':
      process.stdout.write(`${sessionsDir()}\n`);
      return 0;
    case 'list':
      return runList(opts);
    case 'show':
      return runShow(argument, opts);
    case 'rm':
      return runRemove(argument, opts);
    case 'prune':
      return runPrune(opts);
    default:
      process.stderr.write(
        `Unknown sessions subcommand "${subcommand}". Choose: ${SUBCOMMANDS.join(' | ')}.\n`,
      );
      return 2;
  }
}

function runList(opts: SessionsCliOptions): number {
  const limit = parseCount(opts.lines) ?? 20;
  const entries = listSessions({ ...(opts.all ? { all: true } : {}) }).slice(0, limit);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }
  if (entries.length === 0) {
    process.stdout.write(
      opts.all
        ? 'No sessions found.\n'
        : 'No `aragon exec` sessions found. Pass --all to include TUI /save files.\n',
    );
    return 0;
  }
  for (const entry of entries) {
    process.stdout.write(
      `${entry.id}  ${stamp(entry.updatedAt)}  ${entry.turns} turns  ` +
        `${entry.provider}/${entry.model}  ${entry.cwd}\n`,
    );
  }
  return 0;
}

function runShow(argument: string | undefined, opts: SessionsCliOptions): number {
  if (!argument) {
    process.stderr.write('Usage: aragon sessions show <id> [--json]\n');
    return 2;
  }
  if (!isValidSessionId(argument)) {
    process.stderr.write(`${INVALID_ID_MESSAGE(argument)}\n`);
    return 2;
  }
  const path = sessionPathFor(argument);
  const session = readSessionFile(path);
  if (!session) {
    process.stderr.write(`session_not_found: no readable session "${argument}".\n`);
    return 2;
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    return 0;
  }
  // THE BODIES ARE NOT PRINTED WITHOUT `--json`. A session transcript can be
  // megabytes and is frequently the most sensitive thing on the machine; a
  // command whose job is "tell me about this session" should not paste it into a
  // shared terminal because someone typed an id.
  const meta = session.meta;
  process.stdout.write(
    [
      `id        ${meta?.id ?? argument}`,
      `path      ${path}`,
      `saved     ${stamp(session.savedAt)}`,
      `cwd       ${meta?.cwd ?? '(unknown)'}`,
      `turns     ${meta?.turns ?? 0}`,
      `model     ${meta?.provider ?? session.model?.providerId ?? '?'}/${
        meta?.model ?? session.model?.modelId ?? '?'
      }`,
      `messages  ${session.messages.length}`,
      `todos     ${session.todos?.length ?? 0}`,
      `managed   ${meta?.id ? 'yes (aragon exec)' : 'no (TUI /save)'}`,
      '',
    ].join('\n'),
  );
  return 0;
}

function runRemove(argument: string | undefined, opts: SessionsCliOptions): number {
  if (!argument) {
    process.stderr.write('Usage: aragon sessions rm <id> --yes\n');
    return 2;
  }
  if (!opts.yes) {
    process.stderr.write('Refusing to delete without --yes.\n');
    return 2;
  }
  // BEFORE `--yes` IS HONOURED AS PERMISSION TO DELETE. `sessions rm` is
  // documented to accept any file IN THE SESSIONS DIRECTORY, because the user
  // named it - not any file anywhere, which is what an unvalidated id joined to
  // that directory would reach (R-7).
  if (!isValidSessionId(argument)) {
    process.stderr.write(`${INVALID_ID_MESSAGE(argument)}\n`);
    return 2;
  }
  if (!removeSession(argument)) {
    process.stderr.write(`session_not_found: no session "${argument}".\n`);
    return 2;
  }
  process.stdout.write(`Removed ${argument}.\n`);
  return 0;
}

function runPrune(opts: SessionsCliOptions): number {
  const days = parseCount(opts.olderThan);
  if (opts.olderThan !== undefined && days === null) {
    process.stderr.write('--older-than takes a non-negative number of days.\n');
    return 2;
  }
  if (!opts.dryRun && !opts.yes) {
    process.stderr.write('Refusing to prune without --yes. Use --dry-run to preview.\n');
    return 2;
  }
  const doomed = pruneSessions({
    ...(days !== null ? { olderThanDays: days } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.all ? { all: true } : {}),
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(doomed, null, 2)}\n`);
    return 0;
  }
  const verb = opts.dryRun ? 'Would remove' : 'Removed';
  for (const entry of doomed) process.stdout.write(`${verb} ${entry.id}  ${stamp(entry.updatedAt)}\n`);
  const foreign = doomed.filter((e) => !e.managed).length;
  process.stdout.write(
    `${verb.toLowerCase()} ${doomed.length} session(s)` +
      (foreign > 0 ? `, ${foreign} of them saved from the TUI (--all was given).` : '.') +
      '\n',
  );
  return 0;
}

function parseCount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  return Number.parseInt(raw.trim(), 10);
}

/** ISO-8601 without the fractional seconds. ASCII, sortable, unambiguous. */
function stamp(ms: number): string {
  if (!ms) return '-';
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export type { SessionListEntry };
