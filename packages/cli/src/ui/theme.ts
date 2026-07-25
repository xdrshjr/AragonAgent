/**
 * Theme — palette + symbols used across the Ink component tree (spec §3.2).
 *
 * A real theming engine: two distinct `DARK` / `LIGHT` hex palettes, an `auto`
 * resolution that is deterministic (`auto → dark`, since terminals cannot
 * reliably report their background), color degradation across terminal depth
 * (truecolor → 256 → 16 → monochrome), and an ASCII symbol swap for terminals
 * without Unicode support. Every field from the v1 flat palette is preserved so
 * existing components keep working; the new fields are additive.
 */

import type { ThemeName } from '../config/schema.js';
import type { TermCapabilities } from './capabilities.js';

/** A resolved color: a hex/name string, or `undefined` (Ink renders plain). */
type Color = string | undefined;

export interface ThemeSymbols {
  user: string;
  assistant: string;
  thinking: string;
  toolPending: string;
  toolRunning: string;
  toolDone: string;
  toolError: string;
  info: string;
  warn: string;
  error: string;
  bullet: string;
  /** Static spinner glyph (reduced motion / no-Unicode fallback). */
  spinnerStill: string;
  gaugeFull: string;
  gaugeEmpty: string;
  keyOn: string;
  keyOff: string;
  wordmark: string;
}

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

  // v0.2 additions.
  gradient: string[]; // wordmark hex stops (empty below ansi-256)
  gauge: { track: Color; low: Color; mid: Color; high: Color };
  diff: { add: Color; remove: Color; meta: Color; context: Color };
  toast: { info: Color; warn: Color; error: Color; success: Color };
  chip: { fg: Color; bg: Color };
}

/**
 * Legacy default symbol set (Unicode). Kept as a named export so components not
 * rewritten in v0.2 (UserEntry / AssistantEntry) keep importing it unchanged;
 * capability-aware components read `theme.symbols` instead.
 */
export const SYMBOLS = {
  user: '›',
  assistant: '●',
  thinking: '✱',
  toolPending: '◦',
  toolRunning: '◍',
  toolDone: '✔',
  toolError: '✖',
  info: 'ℹ',
  warn: '▲',
  error: '✖',
  bullet: '•',
} as const;

const UNICODE_SYMBOLS: ThemeSymbols = {
  user: '›',
  assistant: '●',
  thinking: '✱',
  toolPending: '◦',
  toolRunning: '◍',
  toolDone: '✔',
  toolError: '✖',
  info: 'ℹ',
  warn: '▲',
  error: '✖',
  bullet: '•',
  spinnerStill: '·',
  gaugeFull: '█',
  gaugeEmpty: '░',
  keyOn: '●',
  keyOff: '○',
  wordmark: '◇',
};

const ASCII_SYMBOLS: ThemeSymbols = {
  user: '>',
  assistant: '*',
  thinking: '*',
  toolPending: 'o',
  toolRunning: '*',
  toolDone: '[ok]',
  toolError: '[x]',
  info: 'i',
  warn: '!',
  error: 'x',
  bullet: '-',
  spinnerStill: '*',
  gaugeFull: '#',
  gaugeEmpty: '-',
  keyOn: '*',
  keyOff: 'o',
  wordmark: '<>',
};

// ---------------------------------------------------------------------------
// Palettes (hex). DARK and LIGHT differ on every field.
// ---------------------------------------------------------------------------

interface Palette {
  primary: string;
  accent: string;
  user: string;
  assistant: string;
  thinking: string;
  toolPending: string;
  toolRunning: string;
  toolDone: string;
  toolError: string;
  noticeInfo: string;
  noticeWarn: string;
  noticeError: string;
  muted: string;
  border: string;
  code: string;
  gradient: [string, string, string];
  gauge: { track: string; low: string; mid: string; high: string };
  diff: { add: string; remove: string; meta: string; context: string };
  toast: { info: string; warn: string; error: string; success: string };
  chip: { fg: string; bg: string };
}

const DARK: Palette = {
  primary: '#7aa2f7',
  accent: '#bb9af7',
  user: '#7dcfff',
  assistant: '#c0caf5',
  thinking: '#7a86b8',
  toolPending: '#565f89',
  toolRunning: '#e0af68',
  toolDone: '#9ece6a',
  toolError: '#f7768e',
  noticeInfo: '#7aa2f7',
  noticeWarn: '#e0af68',
  noticeError: '#f7768e',
  muted: '#565f89',
  border: '#3b4261',
  code: '#9ece6a',
  gradient: ['#7aa2f7', '#bb9af7', '#7dcfff'],
  gauge: { track: '#3b4261', low: '#9ece6a', mid: '#e0af68', high: '#f7768e' },
  diff: { add: '#9ece6a', remove: '#f7768e', meta: '#7aa2f7', context: '#7a86b8' },
  toast: { info: '#7aa2f7', warn: '#e0af68', error: '#f7768e', success: '#9ece6a' },
  chip: { fg: '#1a1b26', bg: '#7aa2f7' },
};

const LIGHT: Palette = {
  primary: '#2959aa',
  accent: '#8c4bc9',
  user: '#0f7490',
  assistant: '#1f2430',
  thinking: '#6b7280',
  toolPending: '#9aa0ab',
  toolRunning: '#b5730f',
  toolDone: '#2e7d32',
  toolError: '#c62828',
  noticeInfo: '#2959aa',
  noticeWarn: '#b5730f',
  noticeError: '#c62828',
  muted: '#6b7280',
  border: '#c8cdd6',
  code: '#3f7f2f',
  gradient: ['#2959aa', '#8c4bc9', '#0f7490'],
  gauge: { track: '#c8cdd6', low: '#2e7d32', mid: '#b5730f', high: '#c62828' },
  diff: { add: '#2e7d32', remove: '#c62828', meta: '#2959aa', context: '#6b7280' },
  toast: { info: '#2959aa', warn: '#b5730f', error: '#c62828', success: '#2e7d32' },
  chip: { fg: '#ffffff', bg: '#2959aa' },
};

// ---------------------------------------------------------------------------
// Color degradation (truecolor → 256 → 16 → monochrome)
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

/** `auto` never guesses light — terminals can't report their background. */
function resolvePalette(name: ThemeName): { palette: Palette; resolved: ThemeName } {
  if (name === 'light') return { palette: LIGHT, resolved: 'light' };
  return { palette: DARK, resolved: name === 'auto' ? 'auto' : 'dark' };
}

const cache = new Map<string, Theme>();

export function getTheme(name: ThemeName, caps: TermCapabilities): Theme {
  const key = `${name}|${caps.colorLevel}|${caps.unicode}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const { palette } = resolvePalette(name);
  const level = caps.colorLevel;
  const d = (hex: string): Color => degrade(hex, level);

  const theme: Theme = {
    name,
    symbols: caps.unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS,
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
