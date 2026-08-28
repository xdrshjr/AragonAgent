/**
 * `aragon logs path | list | tail | clear | open` — the non-interactive surface.
 *
 * Exit codes follow the existing convention: 0 success · 1 run-time failure ·
 * 2 usage error.
 *
 * THE WHOLE GROUP IS EXEMPT from the "every subcommand records one info line"
 * rule, and that is a correctness requirement rather than tidiness. Recording a
 * line opens today's log file, and Node opens files without
 * `FILE_SHARE_DELETE`; on Windows — the platform this feature was asked for —
 * `aragon logs clear --yes` would then be unable to delete the very file its own
 * announcement had just created. These commands are the log's operations
 * surface; giving them observable side effects on the log is backwards.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { getLogsDir } from '../config/app-paths.js';
import { loadConfig, type CliFlags } from '../config/load.js';
import { isLogFileName } from './file-sink.js';
import { getLogger } from './logger.js';
import { LOG_LEVELS, isLogLevel, type LogLevelName } from './levels.js';

export interface LogsCliOptions {
  /** `-n <N>` — how many trailing lines `tail` prints (default 100). */
  lines?: string;
  follow?: boolean;
  level?: string;
  json?: boolean;
  /** Required by `clear`; without it the command refuses. */
  yes?: boolean;
}

const EXIT_OK = 0;
const EXIT_RUNTIME = 1;
const EXIT_USAGE = 2;

const DEFAULT_TAIL_LINES = 100;
/** `watchFile` poll interval for `--follow` (Q2). */
const FOLLOW_POLL_MS = 500;

/** The effective log directory for this run (flag › env › file › default). */
function resolveLogsDir(flags: CliFlags): string {
  const configured = loadConfig(flags).log.dir.trim();
  return configured.length > 0 ? configured : getLogsDir();
}

function listLogFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter(isLogFileName)
      .sort();
  } catch {
    return [];
  }
}

export async function runLogsCommand(
  subcommand: string,
  opts: LogsCliOptions,
  flags: CliFlags,
): Promise<number> {
  const dir = resolveLogsDir(flags);
  switch (subcommand) {
    case 'path':
      return runPath(dir);
    case 'list':
      return runList(dir);
    case 'tail':
      return runTail(dir, opts);
    case 'clear':
      return runClear(dir, opts);
    case 'open':
      return runOpen(dir);
    default:
      process.stderr.write(
        `Unknown logs subcommand "${subcommand}". Try: path | list | tail | clear | open.\n`,
      );
      return EXIT_USAGE;
  }
}

function runPath(dir: string): number {
  const logger = getLogger();
  process.stdout.write(`${logger.currentLogPath()}\n`);
  process.stdout.write(`directory: ${dir}\n`);
  // `debug` and `trace` write prompt and tool output verbatim; a user about to
  // attach a log to a bug report should be told that here, not discover it.
  process.stdout.write(
    'level: ' + logger.level + ' (debug/trace record prompt and tool content)\n',
  );
  if (logger.sinkDisabled) {
    process.stdout.write(
      `WARNING: logging is disabled after write failures: ${logger.sinkError}\n`,
    );
  }
  return EXIT_OK;
}

function runList(dir: string): number {
  const files = listLogFiles(dir);
  if (files.length === 0) {
    process.stdout.write(`No log files in ${dir}.\n`);
    return EXIT_OK;
  }
  for (const name of files) {
    try {
      const stat = statSync(join(dir, name));
      process.stdout.write(`${name}  ${stat.size} bytes  ${stat.mtime.toISOString()}\n`);
    } catch {
      process.stdout.write(`${name}  (unreadable)\n`);
    }
  }
  return EXIT_OK;
}

interface ParsedRecord {
  ts?: string;
  lv?: string;
  scope?: string;
  msg?: string;
  data?: Record<string, unknown>;
}

/** Render one JSONL record as a human-readable line; pass unparseable ones through. */
function renderRecord(line: string): string {
  try {
    const record = JSON.parse(line) as ParsedRecord;
    const data = record.data ? ` ${JSON.stringify(record.data)}` : '';
    const level = (record.lv ?? '?').padEnd(5);
    return `${record.ts ?? ''} ${level} ${record.scope ?? '-'}: ${record.msg ?? ''}${data}`;
  } catch {
    return line;
  }
}

function passesLevel(line: string, min: LogLevelName | undefined): boolean {
  if (!min) return true;
  try {
    const record = JSON.parse(line) as ParsedRecord;
    if (!isLogLevel(record.lv)) return true;
    return LOG_LEVELS[record.lv] <= LOG_LEVELS[min];
  } catch {
    return true;
  }
}

function printLines(lines: string[], opts: LogsCliOptions, min: LogLevelName | undefined): void {
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    if (!passesLevel(line, min)) continue;
    process.stdout.write(`${opts.json ? line : renderRecord(line)}\n`);
  }
}

function runTail(dir: string, opts: LogsCliOptions): number {
  const files = listLogFiles(dir);
  const target = files.length > 0 ? join(dir, files[files.length - 1] as string) : null;
  if (!target) {
    process.stdout.write(`No log files in ${dir}.\n`);
    return EXIT_OK;
  }

  if (opts.level !== undefined && !isLogLevel(opts.level)) {
    process.stderr.write(`Unknown level "${opts.level}".\n`);
    return EXIT_USAGE;
  }
  const min = opts.level as LogLevelName | undefined;
  const count = Number.parseInt(opts.lines ?? '', 10);
  const wanted = Number.isFinite(count) && count > 0 ? count : DEFAULT_TAIL_LINES;

  let consumed = 0;
  try {
    const raw = readFileSync(target, 'utf-8');
    consumed = raw.length;
    printLines(raw.split('\n').slice(-wanted), opts, min);
  } catch (err) {
    process.stderr.write(`Could not read ${target}: ${err instanceof Error ? err.message : err}\n`);
    return EXIT_RUNTIME;
  }

  if (!opts.follow) return EXIT_OK;

  // `watchFile` (polling) rather than `fs.watch`: these files are ROTATED by
  // rename, which is exactly the case `fs.watch` reports inconsistently across
  // platforms. Half a second of latency is invisible to someone reading a log.
  watchFile(target, { interval: FOLLOW_POLL_MS }, () => {
    try {
      const raw = readFileSync(target, 'utf-8');
      if (raw.length < consumed) consumed = 0; // truncated or rotated underneath us
      printLines(raw.slice(consumed).split('\n'), opts, min);
      consumed = raw.length;
    } catch {
      // The file may vanish mid-rotation; the next poll picks the new one up.
    }
  });
  process.on('SIGINT', () => unwatchFile(target));
  return EXIT_OK;
}

/**
 * Delete every log file.
 *
 * Closes this process's own sink first — otherwise the day's file is held open
 * by the very command trying to remove it. Failures are reported PER FILE
 * rather than aborting: another `aragon` window holding one file open should
 * not stop the other nine from being cleared.
 */
function runClear(dir: string, opts: LogsCliOptions): number {
  if (!opts.yes) {
    process.stderr.write('Refusing to delete log files without --yes.\n');
    return EXIT_USAGE;
  }

  getLogger().closeSink();

  const files = listLogFiles(dir);
  const blocked: string[] = [];
  let removed = 0;
  for (const name of files) {
    try {
      rmSync(join(dir, name), { force: true });
      removed += 1;
    } catch {
      blocked.push(name);
    }
  }

  process.stdout.write(`Deleted ${removed} log file(s).\n`);
  if (blocked.length === 0) return EXIT_OK;
  process.stderr.write(`In use, not deleted: ${blocked.join(', ')}\n`);
  return EXIT_RUNTIME;
}

/**
 * Open the log directory in the platform file manager.
 *
 * A convenience, so a failure degrades to printing the path and still exits 0 —
 * being unable to launch a file manager is not an error in a logging command.
 */
function runOpen(dir: string): number {
  const opener =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    const child = spawn(opener, [dir], { stdio: 'ignore', detached: true });
    child.on('error', () => process.stdout.write(`${dir}\n`));
    child.unref();
  } catch {
    process.stdout.write(`${dir}\n`);
  }
  return EXIT_OK;
}
