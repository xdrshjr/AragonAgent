/**
 * Theme — palette + symbols used across the Ink component tree (spec §3.2).
 *
 * A real theming engine: distinct `WARM` / `COOL` / `LIGHT` hex palettes, an
 * `auto` resolution that is deterministic (`auto -> warm`, since terminals
 * cannot reliably report their background), color degradation across terminal
 * depth (truecolor -> 256 -> 16 -> monochrome), and an ASCII symbol swap for
 * terminals without Unicode support.
 *
 * Two things used to live here and no longer do (spec §4.1 / §4.5):
 *  - the three symbol tables moved to `glyphs.ts`, which is now the single
 *    source of truth for every user-visible character. `symbols` is a VIEW of
 *    `pickGlyphs(caps)`, so every existing `theme.symbols.x` consumer is
 *    unchanged;
 *  - the palette data moved to `palettes.ts`.
 */

import type { ThemeName } from '../config/schema.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs, type Glyphs } from './glyphs.js';
import { resolvePalette, type Palette } from './palettes.js';

/** A resolved color: a hex/name string, or `undefined` (Ink renders plain). */
type Color = string | undefined;

/**
 * Retained name for the symbol view on `Theme`. It is exactly `Glyphs`: the
 * split is by ownership (glyphs.ts owns the data), not by shape.
 */
export type ThemeSymbols = Glyphs;

export interface Theme {
  name: ThemeName;
  symbols: ThemeSymbols;

  // v1 fields (preserved, now degraded to the terminal's color depth).
  primary: Color;
  accent: Color;
  user: Color;
  assistant: Color;
  thinking: Color;
  toolPending: Color;
  toolRunning: Color;
  toolDone: Color;
  toolError: Color;
  noticeInfo: Color;
  noticeWarn: Color;
  noticeError: Color;
  muted: Color;
  border: Color;
  code: Color;

  // v0.3 additions (full-screen chrome).
  /** Composer border while the input holds a draft. */
  focusBorder: Color;
  /** Composer border while idle and empty (matches the legacy `border`). */
  idleBorder: Color;
  /** Hint lines, collapse notices, and the off-bottom indicator. */
  hintFg: Color;
  /** Single-color wordmark fallback below ansi-256. */
  logoShadow: Color;

  // v0.2 additions.
  gradient: string[]; // wordmark hex stops (empty below ansi-256)
  gauge: { track: Color; low: Color; mid: Color; high: Color };
  diff: { add: Color; remove: Color; meta: Color; context: Color };
  toast: { info: Color; warn: Color; error: Color; success: Color };
  chip: { fg: Color; bg: Color };
}

// ---------------------------------------------------------------------------
// Color degradation (truecolor -> 256 -> 16 -> monochrome)
// ---------------------------------------------------------------------------

/** The 16 standard ANSI colours as chalk names + representative RGB. */
const ANSI16: [string, [number, number, number]][] = [
  ['black', [0, 0, 0]],
  ['red', [205, 49, 49]],
  ['green', [13, 188, 121]],
  ['yellow', [229, 229, 16]],
  ['blue', [36, 114, 200]],
  ['magenta', [188, 63, 188]],
  ['cyan', [17, 168, 205]],
  ['white', [229, 229, 229]],
  ['gray', [102, 102, 102]],
  ['redBright', [241, 76, 76]],
  ['greenBright', [35, 209, 139]],
  ['yellowBright', [245, 245, 67]],
  ['blueBright', [59, 142, 234]],
  ['magentaBright', [214, 112, 214]],
  ['cyanBright', [41, 184, 219]],
  ['whiteBright', [255, 255, 255]],
];

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = Number.parseInt(h, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Nearest of the 16 ANSI colours (chalk name) to an arbitrary hex. */
function nearestAnsi16(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  let best = ANSI16[0]![0];
  let bestDist = Infinity;
  for (const [name, [cr, cg, cb]] of ANSI16) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = name;
    }
  }
  return best;
}

/** Degrade a hex colour to the terminal's depth; `undefined` at level 0. */
function degrade(hex: string, level: 0 | 1 | 2 | 3): Color {
  if (level === 0) return undefined;
  if (level === 1) return nearestAnsi16(hex);
  return hex; // level 2/3: Ink/chalk downsamples the hex as needed
}

// ---------------------------------------------------------------------------
// getTheme (memoized)
// ---------------------------------------------------------------------------

const cache = new Map<string, Theme>();

export function getTheme(name: ThemeName, caps: TermCapabilities): Theme {
  const key = `${name}|${caps.colorLevel}|${caps.unicode}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const palette: Palette = resolvePalette(name);
  const level = caps.colorLevel;
  const d = (hex: string): Color => degrade(hex, level);

  const theme: Theme = {
    name,
    symbols: pickGlyphs(caps),
    primary: d(palette.primary),
    accent: d(palette.accent),
    user: d(palette.user),
    assistant: d(palette.assistant),
    thinking: d(palette.thinking),
    toolPending: d(palette.toolPending),
    toolRunning: d(palette.toolRunning),
    toolDone: d(palette.toolDone),
    toolError: d(palette.toolError),
    noticeInfo: d(palette.noticeInfo),
    noticeWarn: d(palette.noticeWarn),
    noticeError: d(palette.noticeError),
    muted: d(palette.muted),
    border: d(palette.border),
    code: d(palette.code),
    focusBorder: d(palette.focusBorder),
    idleBorder: d(palette.idleBorder),
    hintFg: d(palette.hintFg),
    logoShadow: d(palette.logoShadow),
    gradient: level >= 2 ? [...palette.gradient] : [],
    gauge: {
      track: d(palette.gauge.track),
      low: d(palette.gauge.low),
      mid: d(palette.gauge.mid),
      high: d(palette.gauge.high),
    },
    diff: {
      add: d(palette.diff.add),
      remove: d(palette.diff.remove),
      meta: d(palette.diff.meta),
      context: d(palette.diff.context),
    },
    toast: {
      info: d(palette.toast.info),
      warn: d(palette.toast.warn),
      error: d(palette.toast.error),
      success: d(palette.toast.success),
    },
    chip: { fg: d(palette.chip.fg), bg: d(palette.chip.bg) },
  };

  cache.set(key, theme);
  return theme;
}
