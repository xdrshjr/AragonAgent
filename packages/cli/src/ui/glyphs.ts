/**
 * Glyphs — the SINGLE SOURCE OF TRUTH for every user-visible non-ASCII
 * character in `src/ui/**` (spec §4.1).
 *
 * `capabilities.ts` already decides whether the terminal can render Unicode, and
 * the theme already carried an `ASCII_SYMBOLS` table — but 16 files wrote their
 * glyphs as bare literals and bypassed the whole mechanism, so a legacy
 * `cmd.exe` showed mojibake for the prompt caret, the assistant marker, every
 * list bullet, the scroll indicator and all four overlay titles.
 *
 * The fix is structural rather than per-site: EVERY glyph lives in one of the
 * two tables below, components read them through `pickGlyphs(caps)`, and
 * `glyphs.test.ts` runs a static scan that fails the build if any other file
 * under the scanned tree grows a non-ASCII literal again.
 *
 * THIS FILE AND `Logo.tsx`'s art block are the only two files allowed to hold
 * non-ASCII literals under `src/ui/**` (plus the explicit `agent/headless.ts`
 * exemption). Adding a third exception means the guard rail stops guarding —
 * add a field here instead.
 */

import type { TermCapabilities } from './capabilities.js';

export interface Glyphs {
  // --- Roles and status (the former `ThemeSymbols`, moved here verbatim). ---
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

  // --- Punctuation and arrows (collected from the 16 offending files). ---
  ellipsis: string;
  emDash: string;
  midDot: string;
  arrowUp: string;
  arrowDown: string;
  arrowLeft: string;
  arrowRight: string;
  check: string;
  times: string;
  caret: string;
  steer: string;
  enterKey: string;
  /**
   * The Shift+Enter CHORD, not the modifier alone.
   *
   * Concatenating a separate `shiftKey` + `enterKey` works in the Unicode tier
   * but spells "ShiftEnter" in ASCII: the modifier symbol carries an implicit
   * "+" that the word does not. One field per chord keeps both tiers readable.
   */
  shiftEnter: string;
  /** Horizontal rule fill used by the markdown `---` block (§4.7). */
  hrule: string;

  // --- Entry gutter rail (§4.3). ---
  railVertical: string;
  railBranch: string;
  railEnd: string;

  /** Redaction dot for `maskSecret` in the settings screen (§4.1 tier B). */
  maskDot: string;

  /**
   * Ink `borderStyle` name for every boxed region (composer, completion popup,
   * overlay frame).
   *
   * Not a glyph we spell ourselves, which is exactly why it was missed: Ink
   * draws `round` borders from `cli-boxes`, and those are Unicode. Every one of
   * our own literals could degrade perfectly and a legacy console would still
   * show a frame of mojibake around the input. `classic` is the ASCII box.
   */
  boxStyle: 'round' | 'classic';

  // --- Per-tool icons (formerly inline in `ToolCard.tsx`). ---
  tool: Readonly<Record<string, string>>;
  toolDefault: string;
}

const UNICODE_GLYPHS: Glyphs = {
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

  ellipsis: '…',
  emDash: '—',
  midDot: '·',
  arrowUp: '↑',
  arrowDown: '↓',
  arrowLeft: '←',
  arrowRight: '→',
  check: '✓',
  times: '×',
  caret: '❯',
  steer: '⇢',
  enterKey: '⏎',
  shiftEnter: '⇧⏎',
  hrule: '─',

  railVertical: '│',
  railBranch: '├',
  railEnd: '╰',

  maskDot: '•',
  boxStyle: 'round',

  tool: {
    read_file: '▤',
    write_file: '✎',
    edit_file: '✎',
    bash: '❯',
    glob: '⌕',
    grep: '⌕',
    list_dir: '▤',
  },
  toolDefault: '•',
};

const ASCII_GLYPHS: Glyphs = {
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

  ellipsis: '...',
  emDash: '--',
  midDot: '-',
  arrowUp: '^',
  arrowDown: 'v',
  arrowLeft: '<',
  arrowRight: '->',
  check: '*',
  times: 'x',
  caret: '>',
  steer: '>>',
  enterKey: 'Enter',
  shiftEnter: 'Shift+Enter',
  hrule: '-',

  railVertical: '|',
  railBranch: '|',
  railEnd: '\\',

  maskDot: '*',
  boxStyle: 'classic',

  tool: {
    read_file: '=',
    write_file: '+',
    edit_file: '+',
    bash: '>',
    glob: '/',
    grep: '/',
    list_dir: '=',
  },
  toolDefault: '*',
};

/**
 * The glyph set for a terminal. Memoized on `caps.unicode` — the only input —
 * so the returned object is referentially stable and safe in `useMemo` deps.
 */
export function pickGlyphs(caps: TermCapabilities): Glyphs {
  return caps.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
}

/** Per-tool icon with the shared fallback (formerly `ToolCard::toolGlyph`). */
export function toolGlyph(glyphs: Glyphs, name: string): string {
  return glyphs.tool[name] ?? glyphs.toolDefault;
}
