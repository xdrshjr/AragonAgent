/**
 * The main process's own log: `<home>/logs/desktop-main-YYYY-MM-DD.jsonl`.
 *
 * Every line passes through the engine's redactor, and the secret list it consults is
 * refreshed on each config change - a desktop log that could contain a key would turn
 * "export diagnostics" into a leak. Writing is synchronous and failure-proof by design: a log
 * problem must never take the app down or show a dialog.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogSink {
  log(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  logsDir: string;
  redact(text: string): string;
  now?: () => Date;
}

export function createLogger(options: LoggerOptions): LogSink {
  let ensured = false;
  return {
    log(level, scope, message, fields) {
      try {
        const at = (options.now ?? (() => new Date()))();
        if (!ensured) {
          mkdirSync(options.logsDir, { recursive: true });
          ensured = true;
        }
        const line = options.redact(JSON.stringify({
          t: at.toISOString(), level, scope, message, ...(fields ? { fields } : {}),
        }));
        appendFileSync(join(options.logsDir, `desktop-main-${at.toISOString().slice(0, 10)}.jsonl`), `${line}\n`);
      } catch {
        /* logging is best-effort */
      }
    },
  };
}
