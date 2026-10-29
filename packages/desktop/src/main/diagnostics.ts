/**
 * "Export diagnostics": a zip a user can attach to a bug report.
 *
 * It contains the last three days of the desktop's own logs (already redacted when written),
 * the engine's doctor report, a version/platform summary and the desktop state file. It
 * deliberately does NOT contain `config.json`: that file holds the API keys, and no amount of
 * masking is as safe as not shipping it.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DiagnosticsInput {
  logsDir: string;
  now: number;
  /** Redactor applied to every text file, as a second line of defence. */
  redact(text: string): string;
  doctor: unknown;
  summary: unknown;
  desktopStatePath: string;
}

/** Log files modified within the last three days, newest first. */
export function recentLogFiles(dir: string, now: number): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => /^(desktop-|aragon-).*\.(jsonl|log)$/.test(name))
      .map((name) => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .filter((file) => now - file.mtime <= 3 * DAY_MS)
      .sort((a, b) => b.mtime - a.mtime)
      .map((file) => file.name);
  } catch {
    return [];
  }
}

export function buildDiagnosticsZip(input: DiagnosticsInput): Uint8Array {
  const files: Record<string, Uint8Array> = {
    'summary.json': strToU8(input.redact(JSON.stringify(input.summary, null, 2))),
    'doctor.json': strToU8(input.redact(JSON.stringify(input.doctor, null, 2))),
  };
  try {
    files['desktop-state.json'] = strToU8(input.redact(readFileSync(input.desktopStatePath, 'utf8')));
  } catch {
    /* no state file yet */
  }
  for (const name of recentLogFiles(input.logsDir, input.now)) {
    try {
      files[`logs/${name}`] = strToU8(input.redact(readFileSync(join(input.logsDir, name), 'utf8')));
    } catch {
      /* a log that vanished mid-export is simply left out */
    }
  }
  return zipSync(files, { level: 6 });
}
