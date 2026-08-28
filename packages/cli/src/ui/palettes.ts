/**
 * Palettes (spec §4.5) — the raw hex data behind `getTheme()`, split out of
 * `theme.ts` so the color decisions live in one readable place and can be
 * contrast-tested without pulling in the degradation machinery.
 *
 * `WARM` is the new default. The old Tokyo-Night-derived palette survives under
 * its accurate name `COOL` and stays reachable via `--theme cool`, so nobody's
 * screen changes without them being able to change it back (R-4).
 *
 * Theme names describe COLOR TEMPERATURE on purpose. Naming a theme after
 * another company's product would imply an affiliation or an asset licence that
 * does not exist; `warm` / `cool` are accurate and carry no such claim.
 */

import type { ThemeName } from '../config/schema.js';

export interface Palette {
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
  focusBorder: string;
  idleBorder: string;
  hintFg: string;
  logoShadow: string;
  /**
   * Drag-selection highlight (tui-selection-and-scroll-follow §4.4.4).
   *
   * A PAIR, not a background alone: the selected run has its inner SGR stripped
   * before it is repainted, so whatever foreground the row had is gone by the
   * time the highlight is applied and a background on its own would leave the
   * text at the terminal's default colour over an arbitrary hue. The two are
   * contrast-pinned against EACH OTHER in `palettes.test.ts` — the surface a
   * selected glyph sits on is `selectionBg`, not `DARK_SURFACE`.
   *
   * Below ansi-256 these never reach the terminal at all: `highlight.ts` emits
   * plain reverse video there, because `getTheme` has degraded them to chalk
   * colour NAMES by then and a name is not an escape sequence.
   */
  selectionBg: string;
  selectionFg: string;
  gradient: [string, string, string];
  gauge: { track: string; low: string; mid: string; high: string };
  diff: { add: string; remove: string; meta: string; context: string };
  toast: { info: string; warn: string; error: string; success: string };
  chip: { fg: string; bg: string };
}

/**
 * The reference dark background these palettes are contrast-checked against.
 * `palettes.test.ts` (A-7) pins `assistant` / `muted` / `hintFg` at WCAG AA
 * (>= 4.5:1) here so a later "just nudging the hue" cannot quietly make body
 * text unreadable.
 */
export const DARK_SURFACE = '#1c1917';

/** Terracotta + amber over warm neutrals — the v0.4.0 default. */
export const WARM: Palette = {
  primary: '#d08c60',
  accent: '#c9a227',
  user: '#7fb08a',
  assistant: '#e6ddd1',
  thinking: '#a2968a',
  toolPending: '#8a7f74',
  toolRunning: '#c9a227',
  toolDone: '#7fb08a',
  toolError: '#cf6b5c',
  noticeInfo: '#d08c60',
  noticeWarn: '#c9a227',
  noticeError: '#cf6b5c',
  muted: '#a2968a',
  border: '#4a423b',
  code: '#c9a97a',
  focusBorder: '#d08c60',
  idleBorder: '#4a423b',
  hintFg: '#9c9086',
  logoShadow: '#4a423b',
  selectionBg: '#e0b088',
  selectionFg: '#1c1917',
  gradient: ['#d08c60', '#c9a227', '#b0916a'],
  gauge: { track: '#4a423b', low: '#7fb08a', mid: '#c9a227', high: '#cf6b5c' },
  diff: { add: '#7fb08a', remove: '#cf6b5c', meta: '#d08c60', context: '#a2968a' },
  toast: { info: '#d08c60', warn: '#c9a227', error: '#cf6b5c', success: '#7fb08a' },
  chip: { fg: '#1c1917', bg: '#d08c60' },
};

/** The v0.3.0 palette, renamed. Reachable via `--theme cool` / `theme: "dark"`. */
export const COOL: Palette = {
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
  focusBorder: '#7aa2f7',
  idleBorder: '#3b4261',
  hintFg: '#565f89',
  logoShadow: '#3b4261',
  selectionBg: '#7aa2f7',
  selectionFg: '#1a1b26',
  gradient: ['#7aa2f7', '#bb9af7', '#7dcfff'],
  gauge: { track: '#3b4261', low: '#9ece6a', mid: '#e0af68', high: '#f7768e' },
  diff: { add: '#9ece6a', remove: '#f7768e', meta: '#7aa2f7', context: '#7a86b8' },
  toast: { info: '#7aa2f7', warn: '#e0af68', error: '#f7768e', success: '#9ece6a' },
  chip: { fg: '#1a1b26', bg: '#7aa2f7' },
};

export const LIGHT: Palette = {
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
  focusBorder: '#2959aa',
  idleBorder: '#c8cdd6',
  hintFg: '#6b7280',
  logoShadow: '#c8cdd6',
  selectionBg: '#2959aa',
  selectionFg: '#ffffff',
  gradient: ['#2959aa', '#8c4bc9', '#0f7490'],
  gauge: { track: '#c8cdd6', low: '#2e7d32', mid: '#b5730f', high: '#c62828' },
  diff: { add: '#2e7d32', remove: '#c62828', meta: '#2959aa', context: '#6b7280' },
  toast: { info: '#2959aa', warn: '#b5730f', error: '#c62828', success: '#2e7d32' },
  chip: { fg: '#ffffff', bg: '#2959aa' },
};

/**
 * Resolve a theme name to its palette.
 *
 * `auto` never guesses light: terminals cannot reliably report their background
 * colour, and guessing wrong makes the app unreadable. `dark` is accepted here
 * as well as in `clampTheme` because a persisted config written by v0.3.0 can
 * still be sitting on disk when this runs.
 */
export function resolvePalette(name: ThemeName | 'dark'): Palette {
  if (name === 'light') return LIGHT;
  if (name === 'cool' || name === 'dark') return COOL;
  return WARM;
}
