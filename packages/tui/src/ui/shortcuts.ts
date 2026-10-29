/**
 * THE shortcut table (tui-shortcut-drawer-and-task-summary §4.6 / appendix B).
 *
 * ASCII ONLY, AND THAT IS A HARD CONSTRAINT RATHER THAN A STYLE CHOICE: this file
 * is inside `glyphs.test.ts::inScope` (`ui/` prefix), whose `A-1` case fails on a
 * single non-ASCII byte. Every `keyword` and `detail` below is English on
 * purpose; translating them would turn the scanner red, and the only escape
 * hatch - adding this file to the exemptions - is the thing that helper's own
 * comment argues against.
 *
 * THIS IS THE ONLY TRUTH ABOUT SHORTCUTS. The drawer, `/keys` and the tests all
 * derive from it, and `shortcut-table.test.ts` holds it in a BIDIRECTIONAL set
 * relation with `HelpOverlay`'s key column (D-8). The reverse direction is the
 * one that matters: without it `Alt+K`, `Esc twice` and `Esc again` could sit in
 * `/help` forever and never appear in the panel whose entire requirement is
 * "list ALL of them".
 *
 * `keyword` IS CAPPED AT 10 CELLS (`SHORTCUT_PANEL_LIMITS.keywordMaxCells`). A
 * longer one is a spec error, not a width problem: at 80 columns the keyword
 * column is 11 cells wide, and the only remaining remedy would be truncating it -
 * which is the exact defect (a column of `promp...`) this table exists to avoid.
 */

import { cellWidth } from './layout/cells.js';

export type ShortcutGroupId = 'compose' | 'run' | 'panels' | 'session' | 'view';

/**
 * When a row can actually be used. Unavailable rows are STILL LISTED - the user
 * needs to know the key exists - but they render dim and explain themselves in
 * the detail line when selected.
 */
export type ShortcutAvailability = 'always' | 'idle' | 'running' | 'app' | 'native';

export interface ShortcutEntry {
  /** Stable id used by tests and by `/keys <query>`. */
  id: string;
  /** The primary binding, spelled in full the way `HelpOverlay` spells it. */
  keys: string;
  /** One to two words, ASCII only, at most 10 columns. The requirement's second column. */
  keyword: string;
  /** One ASCII sentence, shown when the row is selected. */
  detail: string;
  group: ShortcutGroupId;
  availability: ShortcutAvailability;
  /** Extra spellings that must also resolve in `/keys <query>`. */
  aliases?: readonly string[];
}

export const SHORTCUT_GROUPS: readonly { id: ShortcutGroupId; title: string }[] = [
  { id: 'compose', title: 'COMPOSE' },
  { id: 'run', title: 'RUN' },
  { id: 'panels', title: 'PANELS' },
  { id: 'session', title: 'SESSION' },
  { id: 'view', title: 'VIEW' },
] as const;

/**
 * The 31 rows, in reading order. Group order is fixed by `SHORTCUT_GROUPS`, and
 * within a group the order is "how often a user reaches for it", not alphabetical:
 * a reference panel is scanned from the top.
 */
export const SHORTCUTS: readonly ShortcutEntry[] = [
  // --- COMPOSE ---------------------------------------------------------------
  {
    id: 'enter', keys: 'Enter', keyword: 'send', group: 'compose', availability: 'always',
    detail: 'Submits when idle; queues as steering while running;'
      + ' re-pins the view to the newest output.',
  },
  {
    id: 'alt-enter', keys: 'Alt+Enter', keyword: 'newline', group: 'compose',
    availability: 'always',
    detail: 'Multiline input; the host may intercept this combination.',
  },
  {
    id: 'shift-enter', keys: 'Shift+Enter', keyword: 'newline', group: 'compose',
    availability: 'always',
    detail: 'Needs keyboard enhancement; /terminal-setup explains how to bind it.',
  },
  {
    id: 'ctrl-j', keys: 'Ctrl+J', keyword: 'newline', group: 'compose', availability: 'always',
    detail: 'Newline fallback that does not depend on keyboard enhancement.',
  },
  {
    id: 'history', keys: 'Up / Down', keyword: 'history', group: 'compose', availability: 'always',
    detail: 'Recalls earlier prompts when the input box is empty.',
  },
  {
    id: 'paste', keys: 'Paste', keyword: 'paste', group: 'compose', availability: 'always',
    detail: 'Up to 6 lines inserted as-is; larger becomes [Pasted text #N]; --no-paste disables.',
  },
  {
    id: 'ctrl-o', keys: 'Ctrl+O', keyword: 'expand', group: 'compose', availability: 'always',
    detail: 'Expands the newest tool output; in native mode it reprints it as a new block.',
  },
  {
    id: 'ctrl-c', keys: 'Ctrl+C', keyword: 'copy/exit', group: 'compose', availability: 'always',
    aliases: ['Ctrl+C (with a selection)'],
    detail: 'Copies a pending selection; with a draft x2 clears and x3 exits;'
      + ' empty input x2 exits.',
  },
  // --- RUN -------------------------------------------------------------------
  {
    id: 'esc', keys: 'Esc', keyword: 'close', group: 'run', availability: 'always',
    detail: 'Closes the open overlay or menu; with nothing open it arms the interrupt ladder.',
  },
  {
    id: 'esc-twice', keys: 'Esc twice', keyword: 'interrupt', group: 'run', availability: 'running',
    aliases: ['Esc again'],
    detail: 'Requests an interrupt within 1.5s; the next press forces the stop.',
  },
  {
    id: 'shift-tab', keys: 'Shift+Tab', keyword: 'plan mode', group: 'run', availability: 'always',
    detail: 'Cycles BUILD / PLAN / GOVERN / PLAN+GOVERN. PLAN refuses writes; GOVERN runs a governed team.',
  },
  {
    id: 'ctrl-n', keys: 'Ctrl+N', keyword: 'plan mode', group: 'run', availability: 'always',
    detail: 'The same cycle (BUILD / PLAN / GOVERN / PLAN+GOVERN), for consoles that cannot deliver Shift+Tab.',
  },
  {
    id: 'ctrl-t', keys: 'Ctrl+T', keyword: 'thinking', group: 'run', availability: 'always',
    detail: "Shows or hides the model's thinking (off by default).",
  },
  {
    id: 'ctrl-r', keys: 'Ctrl+R', keyword: 'redraw', group: 'run', availability: 'always',
    detail: 'Repaints the whole frame; use it when the terminal is garbled.',
  },
  // --- PANELS ----------------------------------------------------------------
  {
    id: 'ctrl-g', keys: 'Ctrl+G', keyword: 'all keys', group: 'panels', availability: 'always',
    detail: 'Opens this panel; a second Ctrl+G closes it. Every shortcut is listed here.',
  },
  {
    id: 'ctrl-b', keys: 'Ctrl+B', keyword: 'agents', group: 'panels', availability: 'always',
    detail: 'Read-only subagent board: every child, its facts and its timeline.',
  },
  {
    id: 'ctrl-p', keys: 'Ctrl+P', keyword: 'prompts', group: 'panels', availability: 'always',
    detail: 'Quick prompt library: pick, edit, reorder.',
  },
  {
    id: 'ctrl-k', keys: 'Ctrl+K', keyword: 'kits', group: 'panels', availability: 'always',
    detail: 'Switch the main / fast / subagent model kit for this session.',
  },
  {
    id: 'ctrl-i', keys: 'Ctrl+I', keyword: 'index', group: 'panels', availability: 'idle',
    detail: 'Unavailable while running; asks first, then runs the project-indexer skill.',
  },
  {
    id: 'alt-k', keys: 'Alt+K', keyword: 'kill line', group: 'panels', availability: 'always',
    detail: 'Deletes from the cursor to the end of the line'
      + ' (this was Ctrl+K before the kit picker).',
  },
  {
    id: 'help', keys: '/help', keyword: 'reference', group: 'panels', availability: 'always',
    detail: 'Full reference: keys, slash commands, plan mode, team, skills.',
  },
  // --- SESSION ---------------------------------------------------------------
  {
    id: 'ctrl-l', keys: 'Ctrl+L', keyword: 'branch', group: 'session', availability: 'always',
    detail: 'Opens this session in a new terminal window with its own session id.',
  },
  {
    id: 'clear', keys: '/clear', keyword: 'new task', group: 'session', availability: 'always',
    detail: 'Archives the old conversation, clears the context;'
      + ' the task summary is cleared with it.',
  },
  {
    id: 'resume', keys: '/resume', keyword: 'switch', group: 'session', availability: 'always',
    detail: 'Loads a saved session; the current session moves to a new id.',
  },
  {
    id: 'session', keys: '/session', keyword: 'identity', group: 'session', availability: 'always',
    detail: 'Shows the session id and file, copies the resume command, pins the id.',
  },
  // --- VIEW ------------------------------------------------------------------
  {
    id: 'page', keys: 'PgUp / PgDn', keyword: 'page', group: 'view', availability: 'always',
    detail: 'Pages the transcript, or the overlay that currently owns the keyboard.',
  },
  {
    id: 'wheel', keys: 'Wheel', keyword: 'scroll', group: 'view', availability: 'app',
    detail: 'Scrolls the transcript in app mode; in native mode the terminal owns this.',
  },
  {
    id: 'shift-wheel', keys: 'Shift+Wheel', keyword: 'page', group: 'view', availability: 'app',
    detail: 'Scrolls a whole page.',
  },
  {
    id: 'shift-arrows', keys: 'Shift+Up / Shift+Down', keyword: 'line', group: 'view',
    availability: 'app',
    detail: 'Scrolls one line; native mode leaves this to the terminal.',
  },
  {
    id: 'drag-edge', keys: 'Drag right edge', keyword: 'scrollbar', group: 'view',
    availability: 'app',
    detail: 'Drags the right-edge scrollbar; the input stays fixed.',
  },
  {
    id: 'drag-text', keys: 'Drag text (left button)', keyword: 'select', group: 'view',
    availability: 'app',
    detail: 'Drags to select on-screen text; the highlight waits for a copy.',
  },
] as const;

/**
 * The longest `keys` string in cells - the input the column derivation needs.
 *
 * DERIVED, NEVER HARD-CODED: v1 fixed the key column at 21 cells, which left six
 * for the keyword at 80 columns and turned `prompt library` into `promp...`. A
 * derived value cannot go stale the day someone adds a longer binding.
 */
export function widestKeysCells(entries: readonly ShortcutEntry[]): number {
  return entries.reduce((widest, entry) => Math.max(widest, cellWidth(entry.keys)), 0);
}

/**
 * Filter for `/keys <query>`: case-insensitive substring over id, keys, keyword
 * and aliases.
 *
 * NO KEYBOARD SEARCH IN THE PANEL ITSELF (§11 F-2): typing would fight `Esc` for
 * "clear the filter or close the panel", and `Esc` is App-owned. The command is
 * the zero-conflict way to reach the same filter.
 */
export function filterShortcuts(
  entries: readonly ShortcutEntry[],
  query: string,
): ShortcutEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...entries];
  return entries.filter((entry) => {
    const haystack = [entry.id, entry.keys, entry.keyword, ...(entry.aliases ?? [])];
    return haystack.some((field) => field.toLowerCase().includes(needle));
  });
}

/**
 * Whether a row can be used right now.
 *
 * `running` MEANS "ONLY WHILE RUNNING", not "unavailable while running" - the two
 * halves of the table would otherwise need two different predicates, which is the
 * kind of asymmetry a later reader gets backwards.
 */
export function isAvailable(
  entry: ShortcutEntry,
  context: { native: boolean; running: boolean },
): boolean {
  switch (entry.availability) {
    case 'always': return true;
    case 'idle': return !context.running;
    case 'running': return context.running;
    case 'app': return !context.native;
    case 'native': return context.native;
    default: return true;
  }
}
