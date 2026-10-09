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
  /**
   * Checkbox pair for a multi-select question (`allowMultiple`).
   *
   * Distinct from `keyOn` / `keyOff`, which are radios: a user looking at a list
   * has to be able to tell "pick one" from "pick several" without reading the
   * footer, and that distinction is exactly what the two shapes carry.
   */
  boxChecked: string;
  boxEmpty: string;
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

  /**
   * Scroll-position indicator on the viewport's right edge (mouse-wheel §4.8).
   *
   * These are byte-for-byte identical to `railVertical` / `gaugeFull` in both
   * tiers, and that is DELIBERATE (P2-2). This file's header mandates "add a
   * field here instead" of a new exception, and semantic field names are what
   * make the ASCII tier reviewable at a glance. Reusing `gaugeFull` would
   * couple the scroll thumb to the context-window gauge, so that restyling one
   * silently restyles the other — do not "deduplicate" them.
   */
  scrollTrack: string;
  scrollThumb: string;

  /** Redaction dot for `maskSecret` in the settings screen (§4.1 tier B). */
  maskDot: string;

  /**
   * Team mode (team-subagents §6.1). The rail marker for a dispatch card and
   * the prefix on the panel's incoming-message preview.
   *
   * They live HERE rather than in `TeamPanel` / `TeamCard` for the reason this
   * file's header gives: a literal in a component bypasses `pickGlyphs` entirely
   * and shows mojibake on a legacy console, whatever the capability probe said.
   */
  teamAgent: string;
  teamMail: string;

  /**
   * Todo planning (todo-plan-execution §6.1). One marker per item state, plus
   * the rail marker for the transcript card via `tool.todo_write`.
   *
   * THE ASCII TIER USES BRACKETED FORMS FOR THE TWO SETTLED STATES, because a
   * bare single letter cannot distinguish "done" from "failed" on a monochrome
   * terminal. The panel pads the marker cell to 3 columns, which is what makes
   * the mixed widths line up without a per-tier branch.
   */
  todoPending: string;
  todoActive: string;
  todoDone: string;

  /**
   * API retry (llm-api-retry-backoff §6.5). The rail marker on the retry card.
   *
   * HERE RATHER THAN IN `RetryCard`, for the reason this file's header gives: a
   * literal in a component bypasses `pickGlyphs` entirely and shows mojibake on a
   * legacy console whatever the capability probe said. `glyphs.test.ts`'s static
   * scan fails the build if either spelling appears anywhere else.
   */
  retry: string;

  /**
   * A message queued behind a running turn (tui-shift-enter-copy-queue 5.4).
   * The rail marker on the `Queue: ...` row.
   *
   * HERE rather than in `QueuedEntry`, for the reason this file's header
   * gives: a literal in a component bypasses `pickGlyphs` entirely and
   * shows mojibake on a legacy console whatever the capability probe said.
   */
  queued: string;

  /**
   * Context compaction (context-auto-compaction §6.3). The rail marker on the
   * compaction card.
   *
   * HERE RATHER THAN IN `CompactionCard`, for the reason this file's header
   * gives: a literal in a component bypasses `pickGlyphs` entirely and shows
   * mojibake on a legacy console whatever the capability probe said.
   * `glyphs.test.ts`'s static scan fails the build if either spelling appears
   * anywhere else — and `src/compaction/**` is inside that scan's scope too.
   */
  compaction: string;

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
  // U+2714 has conflicting emoji widths in Ink and string-width. U+2713 is
  // consistently one cell, including beside the right-edge scrollbar.
  toolDone: '✓',
  toolError: '×',
  info: 'ⓘ',
  warn: '▲',
  error: '×',
  bullet: '•',
  spinnerStill: '·',
  gaugeFull: '█',
  gaugeEmpty: '░',
  keyOn: '●',
  keyOff: '○',
  boxChecked: '☒',
  boxEmpty: '☐',
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

  scrollTrack: '│',
  scrollThumb: '█',

  maskDot: '•',
  boxStyle: 'round',

  teamAgent: '◆',
  teamMail: '⇄',

  todoPending: '○',
  todoActive: '▸',
  todoDone: '✓',

  retry: '↻',
  compaction: '⤓',
  queued: '◷',

  tool: {
    read_file: '▤',
    write_file: '✎',
    edit_file: '✎',
    bash: '❯',
    glob: '⌕',
    grep: '⌕',
    list_dir: '▤',
    ask_user: '?',
    submit_plan: '◈',
    task: '◆',
    todo_write: '≡',
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
  boxChecked: '[x]',
  boxEmpty: '[ ]',
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

  scrollTrack: '|',
  scrollThumb: '#',

  maskDot: '*',
  boxStyle: 'classic',

  teamAgent: '*',
  teamMail: '@',

  todoPending: '[ ]',
  todoActive: '>',
  todoDone: '[x]',

  retry: '[r]',
  compaction: '[c]',
  queued: '*',

  tool: {
    read_file: '=',
    write_file: '+',
    edit_file: '+',
    bash: '>',
    glob: '/',
    grep: '/',
    list_dir: '=',
    ask_user: '?',
    submit_plan: '#',
    task: '*',
    todo_write: '=',
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
