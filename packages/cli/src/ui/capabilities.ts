/**
 * Terminal capability detection (spec §3.2).
 *
 * A *pure* `detectCapabilities(env, stdout)` that reports how much color and
 * which glyph set the current terminal can render, so the theme engine can
 * degrade truecolor → 256 → 16 → monochrome and swap Unicode box/round glyphs
 * for ASCII on legacy terminals (e.g. `cmd.exe`). Keeping it env-in / value-out
 * makes it unit-testable without a real TTY.
 */

import chalk from 'chalk';

export interface TermCapabilities {
  /** 0 none · 1 basic-16 · 2 ansi-256 · 3 truecolor. */
  colorLevel: 0 | 1 | 2 | 3;
  /** May we use box/round glyphs, spinners, and emoji-ish symbols? */
  unicode: boolean;
}

type EnvLike = Record<string, string | undefined>;
interface StdoutLike {
  isTTY?: boolean;
}

/** Resolve the effective color depth from environment signals + chalk. */
function detectColorLevel(env: EnvLike): 0 | 1 | 2 | 3 {
  // Explicit opt-outs win (https://no-color.org — any value, even empty).
  if (env.NO_COLOR !== undefined) return 0;
  if (env.TERM === 'dumb') return 0;

  // FORCE_COLOR is an explicit override of the auto-detected depth.
  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    if (force === '2') return 2;
    if (force === '3') return 3;
    return 1; // '1' | 'true' | '' → at least basic color
  }

  // A truecolor-capable terminal advertises itself.
  const colorterm = env.COLORTERM?.toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;

  // Fall back to chalk's own platform detection.
  const level = chalk.level;
  return level >= 0 && level <= 3 ? (level as 0 | 1 | 2 | 3) : 0;
}

/** Decide whether Unicode box/round glyphs are safe to emit. */
function detectUnicode(env: EnvLike): boolean {
  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].filter(Boolean).join(' ').toUpperCase();
  if (locale.includes('UTF')) return true;
  if (env.WT_SESSION) return true; // Windows Terminal
  const program = env.TERM_PROGRAM;
  if (program === 'aragonmesh' || program === 'vscode' || program === 'iTerm.app' || program === 'Apple_Terminal') return true;
  // Legacy cmd.exe (no TERM, no WT_SESSION) and unknown terminals fall back to ASCII.
  return false;
}

/**
 * Detect the terminal's color depth and Unicode support. `stdout` is accepted
 * for future TTY-aware refinements and kept in the signature for callers.
 */
export function detectCapabilities(env: EnvLike, _stdout?: StdoutLike): TermCapabilities {
  return {
    colorLevel: detectColorLevel(env),
    unicode: detectUnicode(env),
  };
}
