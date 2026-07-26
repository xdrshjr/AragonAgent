/**
 * Console bridge — invariant I-4 (spec §4.9).
 *
 * `patchConsole: true` makes Ink do `log.clear() → stdout.write(data) →
 * log(lastOutput)`. Under a fixed frame that write pushes the frame down a row
 * and permanently corrupts the line accounting described in §4.2: from then on
 * `eraseLines(previousLineCount)` is off by one and the frame slowly eats the
 * content above it.
 *
 * So full-screen mode runs with `patchConsole: false` and routes `console.*`
 * into the transcript as notice entries, where the output is actually READABLE
 * instead of merely being somewhere on screen. Inline mode keeps Ink's patching.
 */

import { format } from 'node:util';
import type { NoticeLevel } from '../agent/reducer.js';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';

const LEVEL_BY_METHOD: Record<ConsoleMethod, NoticeLevel> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'info',
};

/**
 * Hijack `console.*` for the lifetime of the returned restore function.
 * Returns a restore callback; calling it twice is harmless.
 */
export function installConsoleBridge(
  sink: (level: NoticeLevel, text: string) => void,
): () => void {
  const methods = Object.keys(LEVEL_BY_METHOD) as ConsoleMethod[];
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();

  for (const method of methods) {
    originals.set(method, console[method].bind(console));
    console[method] = (...args: unknown[]): void => {
      const text = format(...args);
      if (text.length === 0) return;
      try {
        sink(LEVEL_BY_METHOD[method], text);
      } catch {
        // A failing sink must never turn a stray console.log into a crash.
      }
    };
  }

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [method, original] of originals) {
      console[method] = original as typeof console.log;
    }
  };
}
