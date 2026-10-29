/**
 * The logging PORT the terminal-UI code writes to (tui-package-split S1 / D10).
 *
 * WHY A PORT AND NOT THE LOGGER. The process-wide `Logger` (file sink, redaction, session
 * id, the four process hooks) is infrastructure that belongs to the executable, not to the
 * terminal runtime. Four view-model / renderer modules used to call `getLogger()`
 * directly; once those modules live in their own package they must not reach back into
 * the CLI to do it. They call `getTuiLogger()` instead, with the SAME arguments, and the
 * CLI connects the real logger when `logging/logger.ts` is loaded (see the bottom of that file).
 *
 * THE DEFAULT IS A NO-OP, AND THAT IS DELIBERATE: a consumer that never installs a
 * logger (the package's own tests, an embedder) gets silence rather than a crash or a
 * stray file. `getTuiLogger()` NEVER returns `undefined`, so a call site needs no guard.
 *
 * `TuiLogScope` must stay a SUBSET of the CLI's `LogScope`: that is what lets the CLI's
 * `Logger` be assigned to this port with no cast. The compiler enforces it at the single
 * wiring site at the bottom of `logger.ts`; widening this union without widening `LogScope` there is a
 * compile error, not a silently dropped record.
 */

export type TuiLogScope = 'cli' | 'config' | 'compaction' | 'llm';

export type TuiLogData = Record<string, unknown>;

export interface TuiScopedLogger {
  error(msg: string, data?: TuiLogData): void;
  warn(msg: string, data?: TuiLogData): void;
  info(msg: string, data?: TuiLogData): void;
  debug(msg: string, data?: TuiLogData): void;
}

export interface TuiLogger {
  error(scope: TuiLogScope, msg: string, data?: TuiLogData): void;
  warn(scope: TuiLogScope, msg: string, data?: TuiLogData): void;
  info(scope: TuiLogScope, msg: string, data?: TuiLogData): void;
  debug(scope: TuiLogScope, msg: string, data?: TuiLogData): void;
  child(scope: TuiLogScope): TuiScopedLogger;
}

const NOOP_SCOPED: TuiScopedLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

const NOOP_LOGGER: TuiLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => NOOP_SCOPED,
};

let installed: TuiLogger | null = null;

/** Installs the real logger; `null` restores the no-op default (tests, teardown). */
export function setTuiLogger(logger: TuiLogger | null): void {
  installed = logger;
}

/** Never `undefined`: the default is a no-op, so call sites need no guard. */
export function getTuiLogger(): TuiLogger {
  return installed ?? NOOP_LOGGER;
}
