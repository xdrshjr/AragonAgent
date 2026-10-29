/**
 * The shortcut drawer's geometry and row layout
 * (tui-shortcut-drawer-and-task-summary §4.5).
 *
 * ASCII ONLY: `src/ui/**` is inside the glyph scanner's scope, so every symbol
 * this module emits arrives as a `glyphs` field and is never spelled here.
 *
 * PURE AND TOTAL. No Ink, no clock, no terminal: the drawer component renders
 * what this returns, `OverlayFrame` slices the window this function DERIVED, and
 * `shortcut-panel-layout.test.ts` pins the arithmetic directly. That split is the
 * whole defence against P0-1, which was not a rendering bug: v1 hand-fixed the key
 * column at 21 cells, which left six cells for the keyword at 80 columns, so every
 * keyword was truncated to `promp...` while a "does not overflow" assertion stayed
 * green. The column is therefore DERIVED from the table, and a keyword that does
 * not fit makes its row STACK rather than be cut.
 *
 * THERE IS EXACTLY ONE WINDOW AUTHORITY: `cursor`. v1 took both `cursor` and
 * `scrollOffset`, which meant paging could leave the selected row - and the detail
 * line that belongs to it - off screen. Paging now moves the CURSOR by a page and
 * the window is the smallest one containing it.
 */

import stringWidth from 'string-width';
import { fitCells, padCells, wrapCells } from './cells.js';
import { sliceWindow, type OverlayWindow } from './overlay-window.js';
import { SHORTCUT_GROUPS, widestKeysCells, type ShortcutEntry } from '../shortcuts.js';

export const SHORTCUT_PANEL_LIMITS = {
  /** Below this the drawer is full width: a 30-cell bar on a 40-cell screen is noise. */
  minSplitCols: 64,
  /** Fraction of the terminal the drawer takes when it IS a drawer. */
  widthFraction: 0.34,
  minWidth: 30,
  maxWidth: 46,
  /** Rail (1 cell) + `paddingLeft` (1 cell) that `OverlayFrame` spends below 48 columns. */
  railCells: 2,
  /** Border (2 cells) + `paddingX` (2 cells) that `OverlayFrame` spends at or above 48. */
  boxCells: 4,
  /**
   * The key column is DERIVED: `min(longestKeys, ceil(listCells * 0.55))`.
   *
   * A hard 21 is what turned `prompt library` into `promp...` at 80 columns. The
   * share is a ceiling, not a target: a table of short keys gets a narrow key
   * column and the leftover width goes to the keyword.
   */
  keyColumnShare: 0.55,
  /** The keyword column must be at least this wide, or the row stacks. */
  keywordMinCells: 8,
  /** Hard ceiling for a keyword string; a longer one is a spec bug, not a width problem. */
  keywordMaxCells: 10,
  /** Gap between the key column and the keyword column. */
  keyGapCells: 1,
  /** Indent for the selected row's detail lines, and for a stacked keyword. */
  detailIndent: 2,
  /** Title + footer rows are chrome and are spent out of the row budget. */
  chromeRows: 2,
  /** The task section is capped so the key list always gets the majority of the panel. */
  taskMaxRows: 2,
  /**
   * ABOVE THIS BODY HEIGHT THE GROUP HEADERS GET THEIR OWN ROWS.
   *
   * Below it they are dropped entirely - not compressed into `---- GROUP ----`
   * separators, which was v2's rule and left FOUR entry rows visible on an
   * 80x24 terminal (title + task + rule + five separators = 9 of 13 body rows).
   * A recorded deviation from the original design: the ordering still runs
   * COMPOSE -> RUN -> PANELS -> SESSION -> VIEW, and the requirement ("list every
   * shortcut from top to bottom") is met by the entries themselves.
   */
  groupHeaderMinRows: 18,
  /** The longest detail line the selected row may grow to. */
  detailMaxRows: 2,
} as const;

/**
 * The drawer's width in columns.
 *
 * `cols < 64` is FULL WIDTH on purpose: at 40 columns a right-aligned 30-cell bar
 * spends 10 of the user's columns on empty space. The clamp mirrors
 * `rail.ts::todoRailWidth` (same shape, same reason).
 */
export function shortcutPanelWidth(cols: number): number {
  const width = Number.isFinite(cols) ? Math.floor(cols) : 80;
  const safe = Math.max(0, width);
  if (safe < SHORTCUT_PANEL_LIMITS.minSplitCols) return safe;
  const fraction = Math.round(safe * SHORTCUT_PANEL_LIMITS.widthFraction);
  return Math.min(
    SHORTCUT_PANEL_LIMITS.maxWidth,
    Math.max(SHORTCUT_PANEL_LIMITS.minWidth, fraction),
  );
}

/**
 * Cells the drawer may draw on INSIDE its frame.
 *
 * THE FORM IS DECIDED BY THE TERMINAL, exactly as `OverlayFrame` decides it
 * (`cols >= BORDERLESS_COLS`), so this function takes the same `cols` the frame
 * receives. Passing the panel's own width instead would make a 46-cell drawer on
 * a 200-column terminal fall back to the rail form for ever, because 46 < 48.
 */
export function shortcutPanelContentCells(cols: number): number {
  const width = shortcutPanelWidth(cols);
  const chrome = Math.max(0, Math.floor(cols)) >= 48
    ? SHORTCUT_PANEL_LIMITS.boxCells
    : SHORTCUT_PANEL_LIMITS.railCells;
  return Math.max(0, width - chrome);
}

/** One rendered row. `text` already measures at most the panel's content width. */
export interface ShortcutRow {
  /** `entry` = key + keyword on one row; `stacked` = key alone, keyword below. */
  kind: 'task' | 'rule' | 'group' | 'entry' | 'stacked' | 'keyword' | 'detail';
  text: string;
  /** Which entry a `detail` / `keyword` row belongs to; `null` for every other kind. */
  entryId: string | null;
  tone: 'accent' | 'primary' | 'muted' | 'dim';
}

/** The task section's inputs, already flattened by the caller. */
export interface ShortcutTaskSection {
  /** The label, or `null` when there is none yet. */
  text: string | null;
  /** `model` / `fallback`, so the row can be coloured by provenance. */
  tone: 'model' | 'fallback' | null;
  /** Why it is a fallback, or `null`. */
  reason: string | null;
  /** `provider:model`, or `''`. */
  by: string;
  /** Age in ms, or `null` when unknown. */
  ageMs: number | null;
  /** `false` when `taskSummary.enabled` is off. */
  enabled: boolean;
  /** A call is in flight. */
  pending: boolean;
}

export interface BuildShortcutRowsInput {
  cols: number;
  /** Body rows available INSIDE the frame (`OverlayFrame` already subtracted its chrome). */
  rows: number;
  /** Index into the FILTERED entry list. The one authority for the window. */
  cursor: number;
  /**
   * THE ENTRIES ARRIVE FILTERED AND WITH THEIR AVAILABILITY, so this module takes
   * neither a `query` nor a `context` for them (review fix RF-2). It used to accept
   * both - and `detailsExpanded` as well - and read none of them, which is the exact
   * "second source of truth that silently does nothing" its own 0-3 rule forbids: a
   * caller could pass `query: 'git'` and get the unfiltered list with nothing
   * failing.
   */
  entries: readonly ShortcutEntry[];
  task: ShortcutTaskSection;
  /** Per-entry availability, so an unavailable row renders dim and explains itself. */
  entryAvailable?: (entry: ShortcutEntry) => boolean;
  /** The sentence appended to an unavailable row's detail line. */
  unavailableReason?: string;
  glyphs: {
    ellipsis: string;
    cursor: string;
    hrule: string;
    midDot: string;
  };
}

export interface BuildShortcutRowsResult {
  rows: ShortcutRow[];
  window: OverlayWindow;
  /** Row index of the selected entry; equal to `window.start + 0` at the top. */
  cursorRow: number;
  /** Total rows the panel holds, which is what the frame's position indicator counts. */
  total: number;
  /** The footer string; `OverlayFrame`'s `hint`, and chrome rather than a row. */
  hint: string;
}

/** Column widths for one geometry. Exported so the tests can assert them directly. */
export interface ShortcutColumns {
  /** The panel's own width. */
  width: number;
  /** Content cells inside the frame. */
  available: number;
  /** Cells left for a list row after the cursor column is spent. */
  listCells: number;
  keyCells: number;
  keywordCells: number;
  /** True when no entry fits the two-column form and every row stacks. */
  stacked: boolean;
}

/**
 * Derive the two columns (P0-1).
 *
 * `stacked` is a GLOBAL flag only when the keyword column is too narrow for any
 * keyword at all; otherwise stacking is decided per row, so one long binding
 * (`Shift+Up / Shift+Down`, 20 cells) does not cost the other thirty rows a line.
 */
export function shortcutColumns(
  cols: number,
  entries: readonly ShortcutEntry[],
  glyphs: { cursor: string },
): ShortcutColumns {
  const width = shortcutPanelWidth(cols);
  const available = shortcutPanelContentCells(cols);
  // The cursor glyph owns one cell on the selected row, so it comes out of the
  // LIST's budget rather than out of the keyword's.
  const cursorCells = stringWidth(glyphs.cursor) > 0 ? 1 : 0;
  const listCells = Math.max(0, available - cursorCells);
  const longest = widestKeysCells(entries);
  const share = Math.ceil(listCells * SHORTCUT_PANEL_LIMITS.keyColumnShare);
  const keyCells = Math.min(longest, Math.max(0, share));
  const keywordCells = Math.max(0, listCells - keyCells - SHORTCUT_PANEL_LIMITS.keyGapCells);
  return {
    width,
    available,
    listCells,
    keyCells,
    keywordCells,
    stacked: keywordCells < SHORTCUT_PANEL_LIMITS.keywordMinCells,
  };
}

/** `12s ago` / `3m ago` / `1h ago`, without introducing a second clock. */
function ageLabel(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs) || ageMs < 0) return '';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** The task section's status line, or the reason there is none. */
function taskStatusLine(task: ShortcutTaskSection, glyphs: { midDot: string }): string {
  if (!task.enabled) return 'task summary is off (config taskSummary.enabled)';
  if (task.pending) return 'summarizing' + ` ${glyphs.midDot} ` + 'r refresh';
  if (task.text === null) {
    const reason = task.reason === null ? '' : ` ${glyphs.midDot} ${task.reason}`;
    return `no summary yet${reason} ${glyphs.midDot} r refresh`;
  }
  const age = ageLabel(task.ageMs);
  const who = task.tone === 'fallback' ? 'fallback' : task.by;
  const parts = [who, age].filter((part) => part.length > 0);
  return `${parts.join(` ${glyphs.midDot} `)} ${glyphs.midDot} r refresh`;
}

/**
 * The footer, built by DROPPING clauses from the right (never by re-wording).
 *
 * `Esc close` is never dropped: it is the one thing a user must be able to find on
 * a terminal too narrow to explain anything else. The rest go in a fixed order so
 * the footer is stable across resizes instead of shuffling.
 */
export function shortcutFooter(
  cols: number,
  glyphs: { midDot: string },
  opts: { canRefresh: boolean } = { canRefresh: true },
): string {
  const available = shortcutPanelContentCells(cols);
  // SHORT SPELLINGS ON PURPOSE. The drawer is 30 cells wide at 80 columns and 46 at
  // most, so a footer that spelled `Up/Down select · PgUp/PgDn page · d details ·
  // r refresh · Esc close` (67 cells) would lose three clauses at EVERY width - the
  // ladder would never be exercised, only its last rung. These forms fit four of the
  // five at the maximum width and still keep the one that matters at the minimum.
  const clauses = [
    'Up/Dn',
    'PgUp/PgDn',
    'd details',
    ...(opts.canRefresh ? ['r refresh'] : []),
    'Esc close',
  ];
  // Drop order: the least essential clause first. `Esc close` is never dropped - on a
  // terminal too narrow to explain anything else, that is the one key a user must be
  // able to find.
  const droppable = ['r refresh', 'Up/Dn', 'PgUp/PgDn', 'd details'];
  const sep = ` ${glyphs.midDot} `;
  let kept = [...clauses];
  while (kept.length > 1 && stringWidth(kept.join(sep)) > available) {
    const victim = droppable.find((clause) => kept.includes(clause));
    if (victim === undefined) break;
    kept = kept.filter((clause) => clause !== victim);
  }
  return kept.join(sep);
}

/**
 * Build every row the drawer can show, and derive the window from the cursor.
 *
 * @param input.cols Terminal columns (the frame receives the same number).
 * @param input.rows Body rows inside the frame - `overlayBodyRows(maxRows, cols)`.
 * @param input.cursor Index into `input.entries`; clamped, never trusted.
 */
export function buildShortcutRows(input: BuildShortcutRowsInput): BuildShortcutRowsResult {
  const { glyphs } = input;
  const columns = shortcutColumns(input.cols, input.entries, glyphs);
  const rows: ShortcutRow[] = [];
  const push = (row: ShortcutRow): void => { rows.push(row); };
  const wrapped = (text: string, cells: number, maxRows: number): string[] =>
    wrapCells(text, cells, maxRows, glyphs.ellipsis).lines;

  // --- title ---------------------------------------------------------------
  // NO TITLE ROW (a recorded deviation from the original design's sketch):
  // `OverlayFrame` already draws `title` as chrome,
  // and the `details on|off` marker rides there instead - one string on a row
  // that is already paid for, rather than a whole body row spent on it.

  // --- task section (at most `taskMaxRows`) --------------------------------
  const statusText = (): string =>
    fitCells(taskStatusLine(input.task, glyphs), columns.available, glyphs.ellipsis);
  if (!input.task.enabled) {
    push({ kind: 'task', text: statusText(), entryId: null, tone: 'dim' });
  } else if (input.task.text !== null) {
    for (const line of wrapped(input.task.text, columns.available, 1)) {
      push({
        kind: 'task',
        text: line,
        entryId: null,
        tone: input.task.tone === 'fallback' ? 'dim' : 'primary',
      });
    }
    if (input.rows >= SHORTCUT_PANEL_LIMITS.groupHeaderMinRows) {
      push({ kind: 'task', text: statusText(), entryId: null, tone: 'muted' });
    }
  } else {
    push({ kind: 'task', text: statusText(), entryId: null, tone: 'muted' });
  }

  // --- rule ----------------------------------------------------------------
  if (input.rows >= SHORTCUT_PANEL_LIMITS.groupHeaderMinRows) {
    push({
      kind: 'rule',
      text: glyphs.hrule.repeat(columns.available),
      entryId: null,
      tone: 'muted',
    });
  }

  // --- entries -------------------------------------------------------------
  const entries = input.entries;
  const total = entries.length;
  const cursor = total === 0 ? 0 : Math.min(total - 1, Math.max(0, Math.floor(input.cursor)));
  /** Indent shared by the detail lines and a stacked keyword. */
  const indent = ' '.repeat(SHORTCUT_PANEL_LIMITS.detailIndent);
  let cursorRow = 0;
  const groupHeaders = input.rows >= SHORTCUT_PANEL_LIMITS.groupHeaderMinRows;
  let currentGroup = '';
  entries.forEach((entry, index) => {
    const selected = index === cursor;
    if (groupHeaders && entry.group !== currentGroup) {
      currentGroup = entry.group;
      const title = SHORTCUT_GROUPS.find((group) => group.id === entry.group)?.title ?? '';
      push({
        kind: 'group',
        text: fitCells(title, columns.available, glyphs.ellipsis),
        entryId: null,
        tone: 'accent',
      });
    }
    const usable = input.entryAvailable ? input.entryAvailable(entry) : true;
    const tone: ShortcutRow['tone'] = usable ? (selected ? 'primary' : 'muted') : 'dim';
    const lead = selected ? glyphs.cursor : ' ';
    if (selected) cursorRow = rows.length;
    const keyRoom = columns.keyCells;
    if (columns.stacked || stringWidth(entry.keys) > keyRoom) {
      push({
        kind: 'stacked',
        text: fitCells(`${lead}${entry.keys}`, columns.listCells, glyphs.ellipsis),
        entryId: entry.id,
        tone,
      });
      push({
        kind: 'keyword',
        text: indent
          + fitCells(
            entry.keyword,
            Math.max(0, columns.available - SHORTCUT_PANEL_LIMITS.detailIndent),
            glyphs.ellipsis,
          ),
        entryId: entry.id,
        tone: 'muted',
      });
    } else {
      const keyCell = padCells(`${lead}${entry.keys}`, 1 + keyRoom);
      const keyword = fitCells(entry.keyword, columns.keywordCells, glyphs.ellipsis);
      push({
        kind: 'entry',
        text: `${keyCell}${' '.repeat(SHORTCUT_PANEL_LIMITS.keyGapCells)}${keyword}`,
        entryId: entry.id,
        tone,
      });
    }
    if (!selected) return;
    // The detail line belongs to the selected row and is the reason the window is
    // derived from the cursor rather than from an independent offset (P1-7).
    const detailRoom = Math.max(0, columns.available - SHORTCUT_PANEL_LIMITS.detailIndent);
    // THE UNAVAILABILITY SENTENCE COMES FIRST, not last: the detail line is capped at
    // two rows, and a reason appended after a long explanation is the first thing the
    // cap removes - leaving a dim row with no explanation, which is the one outcome
    // this line exists to prevent.
    const detail = usable
      ? entry.detail
      : `Unavailable now - ${input.unavailableReason ?? 'not in this mode'}. ${entry.detail}`;
    for (const line of wrapped(detail, detailRoom, SHORTCUT_PANEL_LIMITS.detailMaxRows)) {
      push({ kind: 'detail', text: `${indent}${line}`, entryId: entry.id, tone: 'dim' });
    }
  });

  // --- the window ----------------------------------------------------------
  const height = Math.max(1, Math.floor(Number.isFinite(input.rows) ? input.rows : 1));
  // THE SMALLEST WINDOW CONTAINING THE CURSOR: the cursor sits on the last visible
  // row while scrolling down and the window never starts past it.
  const desired = Math.max(0, cursorRow - height + 1);
  const window = sliceWindow(rows.length, desired, height);
  return {
    rows,
    window,
    cursorRow,
    total: rows.length,
    hint: shortcutFooter(input.cols, glyphs, {
      canRefresh: input.task.enabled && !input.task.pending,
    }),
  };
}
