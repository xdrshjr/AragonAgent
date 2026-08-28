/**
 * The screen mirror (tui-selection-and-scroll-follow §7) — the single source of
 * truth for what text is on which row.
 *
 * I-4 RIDES ON THIS OBJECT. The highlight and the clipboard both read the rows
 * stored here, written by the same `decorate` call, so whatever changes under a
 * selection is simultaneously what is highlighted and what would be copied. What
 * you see is what you get BY CONSTRUCTION, rather than by a staleness check that
 * can be wrong.
 *
 * `plain` is computed LAZILY. `decorate` runs on every frame Ink produces —
 * 15-30 times a second during a run — while a copy happens when a human releases
 * a mouse button, so stripping every row eagerly would spend H regex passes per
 * frame to serve an event that may never come. The cache is dropped by `set`, so
 * the laziness is invisible to callers and cannot go stale.
 */

import stripAnsi from 'strip-ansi';

export interface ScreenMirror {
  /** Last frame, ANSI intact — what `decorate` paints over. */
  readonly raw: readonly string[];
  /** The same rows, ANSI stripped — what `selectedText` reads. */
  readonly plain: readonly string[];
  set(lines: readonly string[]): void;
}

export function createScreenMirror(): ScreenMirror {
  let raw: readonly string[] = [];
  let plain: readonly string[] | null = null;

  return {
    get raw(): readonly string[] {
      return raw;
    },
    get plain(): readonly string[] {
      if (plain === null) plain = raw.map((line) => stripAnsi(line));
      return plain;
    },
    set(lines: readonly string[]): void {
      raw = lines;
      plain = null;
    },
  };
}
