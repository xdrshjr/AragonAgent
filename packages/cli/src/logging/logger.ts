/**
 * The logger: level filtering, record shape, redaction, and the module-level
 * singleton every other file reaches through `getLogger()`.
 *
 * WIRE FORMAT — one `JSON.stringify(record)` per line, UTF-8, no BOM:
 *
 *   {"ts":"2026-07-27T12:11:02.913+08:00","lv":"info","sid":"7f3a91c2",
 *    "pid":24188,"scope":"agent","msg":"turn_end",
 *    "data":{"provider":"anthropic","in":1284,"out":377,"ms":4210}}
 *
 * THE SHORT KEYS ARE DELIBERATE AND MUST NOT BE "FIXED". The package's clean-code
 * guide forbids names like `data`, and rightly so for TypeScript identifiers.
 * These are not identifiers: they are the on-disk contract, repeated on every
 * line of a file that reaches megabytes, and already parsed by whatever `jq`
 * one-liner a user has written. Renaming them breaks every existing log and
 * every existing script for a readability gain nobody experiences. Variable and
 * function names in this file get no such exemption.
 *
 * `sid` and `pid` both exist because several `aragon` processes append to the
 * same day's file: `sid` separates their interleaved lines, and `pid` is what
 * still matches up with what the OS recorded after a crash.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';
import { getLogsDir } from '../config/app-paths.js';
import type { LogConfig } from '../config/schema.js';
import { FileSink, currentLogFileName } from './file-sink.js';
import { isLevelEnabled, type LogLevelName } from './levels.js';
import { redactRecord } from './redact.js';
import { getSecrets } from './secret-registry.js';

/** Closed set, not free text: a typo'd scope is a record nobody can filter on. */
export type LogScope =
  | 'cli'
  | 'config'
  | 'agent'
  | 'tool'
  | 'skills'
  | 'llm'
  | 'migrate'
  | 'log'
  // The fast model tier: tier resolution, the periodic review and its registry
  // (fast-model-tier-hardening W4). Its own scope rather than `agent` because a
  // support reader filtering on `agent` wants the LEAD's records, and an
  // unrequested background call is not one of them. `LogConfig` filters by
  // LEVEL, not by scope, so there is no enumerated list to keep in sync here.
  | 'fast'
  // Prompt-history store failures. Its own scope rather than `config`, because
  // the whole point of config-state-separation is that the two are different
  // things and a support reader filtering on `config` wants config records.
  | 'history'
  // The background auto-updater: the registry check, the detached install and
  // its outcome (cli-auto-update §3.10 / C-13). Its own scope rather than `cli`
  // because this is the one subsystem whose entire contract is that the user
  // never sees it, so the log file is the ONLY place its behaviour is
  // observable — and a support reader filtering on `cli` wants the records of
  // what the human asked for.
  | 'update'
  // Context compaction: the trigger, the splice, the failure ladder and the
  // anti-loop guards (context-auto-compaction §3.10). Its own scope rather than
  // `agent` for the reason `fast` records — a support reader filtering on
  // `agent` wants the LEAD's records, and a summarization the user never asked
  // for is not one of them.
  //
  // NEVER THE SUMMARY TEXT AND NEVER MESSAGE CONTENT, which is the same rule
  // `todo-plan-followthrough` states for item text: this scope records what
  // compaction DID, not what the conversation SAID.
  | 'compaction';

export interface LogRecord {
  ts: string;
  lv: LogLevelName;
  sid: string;
  pid: number;
  scope: LogScope;
  msg: string;
  data?: Record<string, unknown>;
}

export interface ScopedLogger {
  error(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
  trace(msg: string, data?: Record<string, unknown>): void;
}

const DISABLED_CONFIG: LogConfig = {
  level: 'silent',
  toFile: false,
  dir: '',
  maxFileBytes: 5 * 1024 * 1024,
  maxFiles: 10,
  redactSecrets: true,
  previewChars: 512,
};

/**
 * ISO 8601 with the LOCAL offset, matching the local date in the file name.
 * `toISOString()` would put an evening record west of UTC into the next day
 * while the file it lands in is named for the previous one.
 */
export function localIsoTimestamp(date = new Date()): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

export class Logger {
  private config: LogConfig;
  private sink: FileSink | null = null;
  private readonly sid = randomUUID().slice(0, 8);
  private failureHandler: ((reason: string) => void) | null = null;

  constructor(config: LogConfig = DISABLED_CONFIG) {
    this.config = { ...config };
  }

  error(scope: LogScope, msg: string, data?: Record<string, unknown>): void {
    this.emit('error', scope, msg, data);
  }

  warn(scope: LogScope, msg: string, data?: Record<string, unknown>): void {
    this.emit('warn', scope, msg, data);
  }

  info(scope: LogScope, msg: string, data?: Record<string, unknown>): void {
    this.emit('info', scope, msg, data);
  }

  debug(scope: LogScope, msg: string, data?: Record<string, unknown>): void {
    this.emit('debug', scope, msg, data);
  }

  trace(scope: LogScope, msg: string, data?: Record<string, unknown>): void {
    this.emit('trace', scope, msg, data);
  }

  child(scope: LogScope): ScopedLogger {
    return {
      error: (msg, data) => this.error(scope, msg, data),
      warn: (msg, data) => this.warn(scope, msg, data),
      info: (msg, data) => this.info(scope, msg, data),
      debug: (msg, data) => this.debug(scope, msg, data),
      trace: (msg, data) => this.trace(scope, msg, data),
    };
  }

  /** Whether a record at `level` would be written — lets callers skip the work. */
  isEnabled(level: LogLevelName): boolean {
    return isLevelEnabled(level, this.config.level);
  }

  /** Truncation budget for user content at `debug`. `trace` ignores it. */
  get previewChars(): number {
    return this.config.previewChars;
  }

  get level(): LogLevelName {
    return this.config.level;
  }

  setLevel(level: LogLevelName): void {
    this.config = { ...this.config, level };
  }

  /**
   * THE authoritative-level hand-off (§4.4.5).
   *
   * `installLogging()` resolves a bootstrap level from `process.env`, the config
   * file and a tiny argv scan, because it has to run before commander exists and
   * before `loadDotenv()`. That bootstrap level covers migrations and early
   * crashes and nothing else. Once `loadConfig()` has produced the real answer,
   * every path calls this exactly once. Without it the fully-resolved level —
   * including anything from `.env` — would simply never take effect.
   *
   * Idempotent, and safe after writing has already begun.
   */
  reconfigure(config: LogConfig): void {
    this.config = { ...config };
    if (!this.sink) return;
    if (!config.toFile) {
      this.sink.close();
      this.sink = null;
      return;
    }
    // `FileSink.reconfigure` handles a changed directory itself: it flushes and
    // closes, and the next record lazily opens the new one.
    this.sink.reconfigure(this.sinkOptions());
  }

  /** Registered by whoever owns a user-visible channel (toast, or stderr). */
  onFailure(cb: (reason: string) => void): void {
    this.failureHandler = cb;
  }

  /** Idempotent; `exit`, the signal hook and the crash hooks all call it. */
  flushSync(): void {
    this.sink?.flushSync();
  }

  /**
   * Where records are going, for `aragon logs path`.
   *
   * Answers with a FILE path even before the sink has been created — the
   * question is "where would I look?", and a bare directory is not that answer.
   */
  currentLogPath(): string {
    if (this.sink) return this.sink.currentPath;
    return join(this.resolveDir(this.config), currentLogFileName());
  }

  get sinkError(): string | undefined {
    return this.sink?.lastError;
  }

  get sinkDisabled(): boolean {
    return this.sink?.disabled ?? false;
  }

  /** Closes the fd so a caller may delete the files (`aragon logs clear`). */
  closeSink(): void {
    this.sink?.close();
    this.sink = null;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private emit(
    level: LogLevelName,
    scope: LogScope,
    msg: string,
    data?: Record<string, unknown>,
  ): void {
    if (!isLevelEnabled(level, this.config.level)) return;
    if (!this.config.toFile) return;

    const record: LogRecord = {
      ts: localIsoTimestamp(),
      lv: level,
      sid: this.sid,
      pid: process.pid,
      scope,
      msg,
      // An empty `data` is omitted rather than written as `{}` — noise on every
      // line of a file measured in megabytes.
      ...(data && Object.keys(data).length > 0 ? { data } : {}),
    };

    const safe = this.config.redactSecrets ? redactRecord(record, getSecrets()) : record;
    this.ensureSink()?.write(`${JSON.stringify(safe)}\n`);
  }

  private resolveDir(config: LogConfig): string {
    return config.dir.trim().length > 0 ? config.dir : getLogsDir();
  }

  private sinkOptions(): ConstructorParameters<typeof FileSink>[0] {
    return {
      dir: this.resolveDir(this.config),
      maxFileBytes: this.config.maxFileBytes,
      maxFiles: this.config.maxFiles,
      formatDropNotice: (count) => this.renderDropNotice(count),
      onFailure: (reason) => this.failureHandler?.(reason),
    };
  }

  /**
   * Created on the FIRST record that actually passes the filters, never in
   * `installLogging()`. `aragon --version`, `aragon config path` and anyone
   * running with `--no-log-file` must not leave an empty directory behind.
   */
  private ensureSink(): FileSink | null {
    if (!this.config.toFile) return null;
    if (!this.sink) this.sink = new FileSink(this.sinkOptions());
    return this.sink;
  }

  private renderDropNotice(count: number): string {
    const record: LogRecord = {
      ts: localIsoTimestamp(),
      lv: 'warn',
      sid: this.sid,
      pid: process.pid,
      scope: 'log',
      msg: 'records_dropped',
      data: { count },
    };
    return `${JSON.stringify(record)}\n`;
  }
}

// ---------------------------------------------------------------------------
// Module singleton
// ---------------------------------------------------------------------------

/**
 * The pre-install logger: silent, file-less, allocates nothing.
 *
 * Its existence is what lets any module call `getLogger().info(...)`
 * unconditionally — no null checks scattered across the codebase, and no import
 * order that can accidentally create a log directory.
 */
const NOOP_LOGGER = new Logger(DISABLED_CONFIG);

let active: Logger | null = null;

export function getLogger(): Logger {
  return active ?? NOOP_LOGGER;
}

/** Called by `installLogging()`; not part of the general API. */
export function setActiveLogger(logger: Logger): void {
  active = logger;
}

/** Tests only — returns the singleton to its pre-install state. */
export function resetLoggerForTest(): void {
  active?.closeSink();
  active = null;
}
