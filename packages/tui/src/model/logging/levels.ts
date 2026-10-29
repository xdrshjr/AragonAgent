/**
 * Log levels — the ordering, the names, and the two coercion helpers.
 *
 * Kept in its own module because it is the one piece of the logging subsystem
 * the config layer (`schema.ts`) and the settings screen need, and neither
 * should have to pull in a file sink to learn what "debug" is called.
 *
 * PRIVACY IS PART OF THE LADDER, not a side effect of it:
 *
 *   error  crashes, failed requests, config write/parse failures
 *   warn   degraded migrations, clamped values, dropped records
 *   info   lifecycle, config writes, turn boundaries + token counts, tool
 *          names and durations — NO conversation content at all
 *   debug  the above plus prompts / replies / tool args truncated to
 *          `previewChars`
 *   trace  full message bodies, full tool arguments and output
 *
 * `info` is the default precisely so that "send me your log" is a safe thing to
 * ask a user. `debug` and above are not, and the README says so.
 */

export const LOG_LEVELS = {
  silent: 0,
  error: 10,
  warn: 20,
  info: 30,
  debug: 40,
  trace: 50,
} as const;

export type LogLevelName = keyof typeof LOG_LEVELS;

export const LOG_LEVEL_NAMES: readonly LogLevelName[] = [
  'silent',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
];

export function isLogLevel(v: unknown): v is LogLevelName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(LOG_LEVELS, v);
}

/**
 * Coerce anything into a level, falling back rather than throwing.
 *
 * Same discipline as `clampTheme` / `clampThinkingLevel`: a nonsense value in
 * the config file must not stop the CLI from starting.
 */
export function clampLogLevel(v: unknown, fallback: LogLevelName): LogLevelName {
  if (isLogLevel(v)) return v;
  if (typeof v === 'string' && isLogLevel(v.trim().toLowerCase())) {
    return v.trim().toLowerCase() as LogLevelName;
  }
  return fallback;
}

/** True when a record at `level` should be emitted under `threshold`. */
export function isLevelEnabled(level: LogLevelName, threshold: LogLevelName): boolean {
  if (threshold === 'silent') return false;
  return LOG_LEVELS[level] <= LOG_LEVELS[threshold];
}
