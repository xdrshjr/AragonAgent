/**
 * PromptInput (spec §3.6 / §3.10) — a controlled multiline input on Ink's
 * `useInput` with: full line editing (Home/End, word jump/delete, kill-line via
 * `input/keymap`), multi-line vertical cursor navigation, prompt-history recall
 * at the edges, a slash-command palette, and `@file` path completion.
 *
 * The buffer/cursor transforms (`applyEdit`, `moveVertical`) and the suggestion
 * computations (`slashSuggestions`, `fileTokenAt`) are pure module functions,
 * exported for `input.test.ts`, so the component itself stays thin.
 *
 * THE EDITOR'S FIVE PIECES OF STATE LIVE IN ONE REDUCER, and every branch of the
 * input handler performs AT MOST ONE `dispatch` (tui-input-flicker-fix §3.4).
 * Ink mounts a LEGACY React root, where `setState` outside a React event handler
 * is not batched — and `useInput` runs from a stdin `'data'` listener, which is
 * outside React entirely. The five `setState` calls one keystroke used to make
 * were five commits, five whole-tree Yoga layouts and, through Ink's 32 ms
 * leading+trailing throttle, two full-frame repaints per character. `fileMatches`
 * stays a plain `useState` because it is written from the debounced glob effect
 * rather than from a key.
 */

import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { glob as tinyGlob } from 'tinyglobby';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { recognize, type EditIntent, type KeyState } from '../input/keymap.js';
import { AutocompletePopup, type Suggestion } from './AutocompletePopup.js';
import { buildAutocompleteLayout } from './layout/autocomplete.js';
import {
  editorReducer,
  INITIAL_EDITOR_STATE,
  type EditorState,
  type InputSegment,
} from './editor-reducer.js';
import { hasPasteFrame, splitPasteFrames } from './paste-frames.js';
import { allocatePasteId, expandPastes, expandRangeOverTokens } from './paste-tokens.js';
import { draftMaxRows } from './composer-limits.js';
import { layoutComposer, splitRowAtColumn, type ComposerSegment } from './composer-rows.js';
import {
  PASTE_DRAFT_MAX_BYTES,
  PASTE_MAX_BLOCKS,
  formatPasteSize,
} from '../input/limits.js';
import type { AgentMode } from '../agent/agent-mode.js';

export interface CommandOption {
  name: string;
  description: string;
}

interface PromptInputProps {
  isActive: boolean;
  running: boolean;
  history: string[];
  commands: CommandOption[];
  cwd: string;
  theme: Theme;
  caps: TermCapabilities;
  /**
   * Row budget for the completion popup (§5.2 / R-14).
   *
   * The popup renders INSIDE this component, inside the shell's `flexShrink={0}`
   * bottom chrome, and can add up to 9 rows. On a short terminal that pushes the
   * status bar past the frame height, where the root box's `overflow: hidden`
   * clips it away — the one piece of chrome R2 promises is always visible.
   * `App` derives this from `budget.ts` so the popup shrinks instead.
   */
  popupMaxRows?: number;
  /** Total menu rows, including borders and the overflow hint. */
  popupMaxHeight?: number;
  onPopupRowsChange?: (rows: number) => void;
  onSubmit: (text: string) => void;
  onHelp?: () => void;
  /**
   * Mirror of the session mode. Read for the placeholder only — the toggle
   * itself belongs to `App`, and this component's job is to get out of its way
   * (see the first statement of the input handler).
   */
  agentMode?: AgentMode;
  /**
   * Set by `Composer` in full-screen mode: draw the rounded frame around the
   * input row only, so the autocomplete popup lands OUTSIDE it (spec §4.7)
   * without lifting the editor's buffer/cursor state out of this component.
   * Unset ⇒ the v0.2.0 borderless inline rendering.
   */
  bordered?: { color?: string };
  /**
   * Fires when the draft flips empty ⇄ non-empty (for the border color) OR when
   * its ROW COUNT changes (for `layout/budget.ts`) — never per keystroke.
   *
   * Widened from `(hasDraft: boolean)` by tui-paste-handling section 5.5. The row
   * count is what makes I-8 true: the composer's rendered height and the
   * `draftRows` handed to `viewportRows` have to be the same number, and the only
   * component that knows the first one is this one. It is reported ALREADY
   * CLAMPED, so a 218-line draft and a 400-line draft report the same value and
   * the transcript stops moving once the composer is full (R-12).
   */
  onDraftChange?: (state: { hasDraft: boolean; rows: number }) => void;
  /**
   * Tell the user a paste was refused (D-11 / P1-4).
   *
   * `PASTE_DRAFT_MAX_BYTES` and `PASTE_MAX_BLOCKS` cannot be enforced in the
   * filter (it does not know the draft) and cannot be enforced in the reducer (it
   * is pure, so it can neither raise a toast nor say why it refused). This
   * component is the only place that holds both facts.
   */
  onNotice?: (level: 'warn' | 'error', text: string) => void;
  /**
   * Rows of newer output hidden BELOW the viewport — `ScrollViewport`'s offset
   * (tui-selection-and-scroll-follow §4.2 / G7).
   *
   * Rendered as a right-aligned chip ON THE INPUT ROW, INSIDE THE BORDER, which
   * is what the requirement asks for (输入框内部) and what makes the hint cost
   * zero rows. It used to take the viewport's own last row, which spent a line of
   * the user's content exactly when the transcript was longest AND fed the number
   * back into its own derivation (§3.3).
   *
   * IT IS STATE, NOT A HINT. It deliberately ignores `showHint` / `hintsEnabled`
   * — those govern the teaching row BELOW the box, which fades with experience
   * and is dropped on a short terminal. "You are 12 rows behind the newest
   * output" must survive both (T-23).
   *
   * Only meaningful in full-screen mode, so it renders only when `bordered` is
   * set: inline mode has no self-drawn viewport and this is always 0 there.
   */
  scrolledLines?: number;
}

// ---------------------------------------------------------------------------
// The scroll chip (§4.2)
// ---------------------------------------------------------------------------

/** Below this the full sentence does not fit beside a draft; the chip goes terse. */
const CHIP_FULL_MIN_COLS = 64;
/**
 * Ceiling on the number the chip prints, so `chipCells` is a CONSTANT per branch
 * rather than a function of how far behind the user is (P2-4). Past it the chip
 * reads `999+`.
 */
const CHIP_MAX_N = 999;
/** `↓ 999+ new lines · PgDn` — the widest form the full branch can produce. */
const CHIP_FULL_CELLS = 24;
/** `↓999+` — the widest form the terse branch can produce. */
const CHIP_TERSE_CELLS = 6;

export interface ScrollChip {
  text: string;
  /** FIXED width, so the number gaining a digit cannot re-wrap the draft (P2-4). */
  cells: number;
}

/**
 * Build the chip, or `null` when the viewport is pinned to the newest output.
 *
 * Every glyph comes from `pickGlyphs` and none from a literal (I-5): on a legacy
 * console this renders `v12` rather than mojibake, and `glyphs.test.ts`'s static
 * scan fails the build if that rule is broken here.
 */
export function scrollChip(
  scrolledLines: number,
  cols: number,
  glyphs: ReturnType<typeof pickGlyphs>,
): ScrollChip | null {
  if (!Number.isFinite(scrolledLines) || scrolledLines <= 0) return null;
  const n = Math.floor(scrolledLines);
  const shown = n > CHIP_MAX_N ? `${CHIP_MAX_N}+` : String(n);
  if (cols < CHIP_FULL_MIN_COLS) {
    return { text: `${glyphs.arrowDown}${shown}`, cells: CHIP_TERSE_CELLS };
  }
  const noun = n === 1 ? 'line' : 'lines';
  return {
    text: `${glyphs.arrowDown} ${shown} new ${noun} ${glyphs.midDot} PgDn`,
    cells: CHIP_FULL_CELLS,
  };
}

// ---------------------------------------------------------------------------
// The draft overflow indicator (section 5.5)
// ---------------------------------------------------------------------------

/** `^3 v7` at its widest, so the cell is a CONSTANT (the P2-4 discipline). */
const OVERFLOW_CELLS = 12;
const OVERFLOW_MAX_N = 999;

export interface OverflowChip {
  text: string;
  /** FIXED width, so a number gaining a digit cannot re-wrap the draft. */
  cells: number;
}

/**
 * Build the "there is more draft above / below this window" indicator, or `null`
 * when the whole draft is on screen.
 *
 * Every glyph comes from `pickGlyphs` and none from a literal (I-5): on a legacy
 * console this renders `^3 v7` rather than mojibake, and `glyphs.test.ts`'s
 * static scan fails the build if that rule is broken here.
 */
export function overflowChip(
  hiddenAbove: number,
  hiddenBelow: number,
  glyphs: ReturnType<typeof pickGlyphs>,
): OverflowChip | null {
  if (hiddenAbove <= 0 && hiddenBelow <= 0) return null;
  const show = (n: number): string => (n > OVERFLOW_MAX_N ? `${OVERFLOW_MAX_N}+` : String(n));
  const parts: string[] = [];
  if (hiddenAbove > 0) parts.push(`${glyphs.arrowUp}${show(hiddenAbove)}`);
  if (hiddenBelow > 0) parts.push(`${glyphs.arrowDown}${show(hiddenBelow)}`);
  return { text: parts.join(' '), cells: OVERFLOW_CELLS };
}

// ---------------------------------------------------------------------------
// Draft-level paste limits (section 5.3, the P1-4 enforcement point)
// ---------------------------------------------------------------------------

/**
 * Would these segments push the draft past a limit? Returns the refusal text, or
 * `null` when the paste is allowed.
 *
 * Checked BEFORE `dispatch`, so a refusal dispatches nothing at all and the draft
 * is left byte-for-byte unchanged (AC-9). The one-dispatch-per-key rule is
 * unaffected for the same reason.
 */
export function draftLimitRefusal(
  segments: InputSegment[],
  editor: Pick<EditorState, 'pastes'>,
): string | null {
  let liveBytes = 0;
  for (const record of editor.pastes.values()) liveBytes += Buffer.byteLength(record.text, 'utf8');
  let blocks = editor.pastes.size;

  for (const segment of segments) {
    if (segment.kind !== 'paste') continue;
    liveBytes += Buffer.byteLength(segment.text, 'utf8');
    blocks += 1;
  }
  if (blocks > PASTE_MAX_BLOCKS) {
    return (
      `Too many pasted blocks in one message (limit is ${PASTE_MAX_BLOCKS}). ` +
      'Nothing was inserted.'
    );
  }
  if (liveBytes > PASTE_DRAFT_MAX_BYTES) {
    return (
      `Pasted content in this message would reach ${formatPasteSize(liveBytes)}; ` +
      `limit is ${formatPasteSize(PASTE_DRAFT_MAX_BYTES)}. Nothing was inserted.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pure editing helpers (unit-tested in input.test.ts)
// ---------------------------------------------------------------------------

const isSpace = (ch: string | undefined): boolean => !!ch && /\s/.test(ch);

function lineStart(buffer: string, cursor: number): number {
  const nl = buffer.lastIndexOf('\n', cursor - 1);
  return nl === -1 ? 0 : nl + 1;
}

function lineEnd(buffer: string, cursor: number): number {
  const nl = buffer.indexOf('\n', cursor);
  return nl === -1 ? buffer.length : nl;
}

function prevWord(buffer: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && isSpace(buffer[i - 1])) i -= 1;
  while (i > 0 && !isSpace(buffer[i - 1])) i -= 1;
  return i;
}

function nextWord(buffer: string, cursor: number): number {
  let i = cursor;
  while (i < buffer.length && isSpace(buffer[i])) i += 1;
  while (i < buffer.length && !isSpace(buffer[i])) i += 1;
  return i;
}

/**
 * Delete `[from, to)`, first growing the range over any token it clips (G5 /
 * D-8).
 *
 * A no-op growth on a buffer with no tokens, so every pre-existing assertion in
 * `input.test.ts` holds byte-for-byte. With a token present it is what stops
 * `Ctrl+W` / `Ctrl+U` / `Ctrl+K` leaving half a label behind — which would be a
 * label the user then sends INSTEAD of the text it stands for.
 */
function killRange(
  buffer: string,
  from: number,
  to: number,
): { buffer: string; cursor: number } {
  const range = expandRangeOverTokens(buffer, from, to);
  return { buffer: buffer.slice(0, range.from) + buffer.slice(range.to), cursor: range.from };
}

/** Apply an edit intent as a pure buffer/cursor transform. */
export function applyEdit(
  buffer: string,
  cursor: number,
  intent: EditIntent,
): { buffer: string; cursor: number } {
  switch (intent) {
    // Cursor MOVEMENT is deliberately not token-aware (D-8): arrows, Home/End
    // and word jumps step by character, because re-deriving `moveVertical` around
    // a synthetic unit buys a correctness the user cannot notice.
    case 'home':
      return { buffer, cursor: lineStart(buffer, cursor) };
    case 'end':
      return { buffer, cursor: lineEnd(buffer, cursor) };
    case 'wordLeft':
      return { buffer, cursor: prevWord(buffer, cursor) };
    case 'wordRight':
      return { buffer, cursor: nextWord(buffer, cursor) };
    case 'deleteWordBack':
      return killRange(buffer, prevWord(buffer, cursor), cursor);
    case 'killToStart':
      return killRange(buffer, lineStart(buffer, cursor), cursor);
    case 'killToEnd':
      return killRange(buffer, cursor, lineEnd(buffer, cursor));
  }
}

/**
 * Move the cursor up/down one line preserving the column. Returns `null` at the
 * top/bottom edge (or for a single-line buffer) so the caller can fall back to
 * prompt-history recall.
 */
export function moveVertical(
  buffer: string,
  cursor: number,
  dir: 'up' | 'down',
): { cursor: number } | null {
  const lines = buffer.split('\n');
  if (lines.length < 2) return null;
  const before = buffer.slice(0, cursor);
  const idx = before.split('\n').length - 1;
  const col = before.length - (before.lastIndexOf('\n') + 1);
  const target = dir === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= lines.length) return null;
  let start = 0;
  for (let i = 0; i < target; i += 1) start += lines[i]!.length + 1;
  return { cursor: start + Math.min(col, lines[target]!.length) };
}

/**
 * Slash-command suggestions when the buffer is a bare `/word` (no space yet).
 *
 * The character class covers `-` and `:` as well as `\w` (D16). Skill names are
 * kebab-case and the namespaced fallback is `/skill:<name>`; with the original
 * `^\/(\w*)$` a user typing `/my-sk` got NO popup at all — not an error message,
 * just silence, which reads as "that command does not exist".
 */
export function slashSuggestions(buffer: string, commands: CommandOption[]): Suggestion[] | null {
  const m = /^\/([\w:-]*)$/.exec(buffer);
  if (!m) return null;
  const q = m[1]!.toLowerCase();
  return commands
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .map((c) => ({ label: `/${c.name}`, hint: c.description }));
}

/** The `@file` token under the cursor (`@` + non-space run), if any. */
export function fileTokenAt(
  buffer: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  let start = cursor;
  while (start > 0 && !isSpace(buffer[start - 1])) start -= 1;
  if (buffer[start] !== '@') return null;
  let end = cursor;
  while (end < buffer.length && !isSpace(buffer[end])) end += 1;
  return { start, end, query: buffer.slice(start + 1, end) };
}

/** A leading C0 control byte or ESC sequence should never be inserted raw. */
function isControlSeq(input: string): boolean {
  if (input.length === 0) return true;
  const code = input.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PromptInput({
  isActive,
  running,
  history,
  commands,
  cwd,
  theme,
  caps,
  popupMaxRows,
  popupMaxHeight,
  onPopupRowsChange,
  agentMode,
  onSubmit,
  onHelp,
  bordered,
  onDraftChange,
  onNotice,
  scrolledLines = 0,
}: PromptInputProps): React.ReactElement {
  const { stdout } = useStdout();
  const [editor, dispatch] = useReducer(editorReducer, INITIAL_EDITOR_STATE);
  const { buffer, cursor, historyIndex, dismissed, sel } = editor;
  const [fileMatches, setFileMatches] = useState<string[]>([]);

  // --- Derived suggestion state (shared by render + input handler). --------
  const slashSug = dismissed ? null : slashSuggestions(buffer, commands);
  const fileTok = fileTokenAt(buffer, cursor);
  const fileQuery = fileTok ? fileTok.query : null;
  const fileActive = !dismissed && !!fileTok && fileTok.query.length >= 1 && fileMatches.length > 0;
  const popupKind: 'slash' | 'file' | null =
    slashSug && slashSug.length > 0 ? 'slash' : fileActive ? 'file' : null;
  const popupItems: Suggestion[] =
    popupKind === 'slash'
      ? slashSug!
      : popupKind === 'file'
      ? fileMatches.map((p) => ({ label: p }))
      : [];
  const clampedSel = popupItems.length > 0 ? Math.min(sel, popupItems.length - 1) : 0;
  const popupLayout = buildAutocompleteLayout({
    itemCount: isActive ? popupItems.length : 0,
    selected: clampedSel,
    maxRows: popupMaxRows,
    maxHeight: popupMaxHeight,
  });
  const popupVisible = isActive && popupLayout.rowCount > 0;
  // Report on every mount, including zero. Cleanup belongs to a separate
  // effect so changing height does not publish an intermediate zero budget.
  useLayoutEffect(() => {
    onPopupRowsChange?.(popupLayout.rowCount);
  }, [onPopupRowsChange, popupLayout.rowCount]);
  useLayoutEffect(() => () => onPopupRowsChange?.(0), [onPopupRowsChange]);

  // --- Debounced `@file` scan. ---------------------------------------------
  useEffect(() => {
    if (fileQuery === null || fileQuery.length < 1) {
      setFileMatches([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      tinyGlob('**/*', {
        cwd,
        dot: false,
        onlyFiles: true,
        ignore: ['**/node_modules/**', '**/.git/**'],
      })
        .then((matches) => {
          if (cancelled) return;
          const q = fileQuery.toLowerCase();
          setFileMatches(matches.filter((m) => m.toLowerCase().includes(q)).slice(0, 20));
        })
        .catch(() => {
          if (!cancelled) setFileMatches([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [fileQuery, cwd]);

  // --- Layout (section 5.5). -----------------------------------------------
  //
  // COMPUTED HERE, ABOVE THE REPORTING EFFECT, because the number the effect
  // sends upward has to be the number this component actually renders (I-8).
  // Deriving it twice — once for the frame and once for the budget — is exactly
  // the trap `BottomStatusRow.tsx:5-27` documents.
  const glyphs = pickGlyphs(caps);
  const cols = stdout?.columns ?? 80;
  const terminalRows = stdout?.rows ?? 24;
  // Full-screen only: inline mode has no self-drawn viewport, so `scrolledLines`
  // is always 0 there and the branch is unreachable rather than merely unused.
  // The guard is explicit so it stays that way.
  const chip = bordered ? scrollChip(scrolledLines, cols, glyphs) : null;
  // Err NARROW. Wrapping wider than the box Ink gives us would make Ink wrap a
  // second time, and then `layout.rows.length` is a lie — which is the one thing
  // this module may not be.
  const chromeCols = bordered ? 2 /* border */ + 2 /* paddingX */ + 2 /* marker */ : 2;
  const baseCols = Math.max(8, cols - chromeCols - (chip ? chip.cells + 1 : 0));
  const measure = (wrapCols: number) =>
    layoutComposer({
      buffer,
      cursor,
      cols: wrapCols,
      maxRows: draftMaxRows(terminalRows),
      active: isActive,
    });
  // TWO PASSES, AND THE SECOND ONE IS LOAD-BEARING (I-8). The overflow indicator
  // rides the last rendered row INSIDE the box the draft wraps in, so its cells
  // have to come out of the wrap width. Measured at the full width instead, a
  // last row that fills the line is wrapped a SECOND time by Ink, and the
  // composer then draws one row more than `layout.rows.length` — which is the
  // number this component hands to `viewportRows`. That is defect C again, in
  // precisely the situation this feature exists for: a draft too tall to show.
  //
  // It settles in two. Narrowing can only ADD rows, so a draft that overflowed
  // the first pass still overflows the second, and a third pass would measure
  // the same width as the second.
  const wide = measure(baseCols);
  const overflows = wide.hiddenAbove > 0 || wide.hiddenBelow > 0;
  const usableCols = overflows ? Math.max(8, baseCols - OVERFLOW_CELLS - 1) : baseCols;
  const layout = overflows ? measure(usableCols) : wide;
  const draftRowCount = Math.max(1, layout.rows.length);

  // --- Draft presence and height, reported only on a transition. -----------
  // Notifying on every keystroke would re-render the whole App tree per key. The
  // row count changes on a line break or a wrap boundary, not per character
  // (R-6), so widening this callback does not widen how often it fires.
  const hasDraft = buffer.length > 0;
  const lastReportedDraft = useRef<{ hasDraft: boolean; rows: number } | null>(null);
  useEffect(() => {
    if (!onDraftChange) return;
    const last = lastReportedDraft.current;
    if (last && last.hasDraft === hasDraft && last.rows === draftRowCount) return;
    lastReportedDraft.current = { hasDraft, rows: draftRowCount };
    onDraftChange({ hasDraft, rows: draftRowCount });
  }, [hasDraft, draftRowCount, onDraftChange]);

  // --- Mutators. -----------------------------------------------------------
  // ONE DISPATCH EACH, and that is the rule §3.4 asks a reviewer to check line
  // by line. Two dispatches from one key would put the legacy root back to two
  // commits and undo the whole of F3 for that branch.
  const insert = (text: string) => {
    dispatch({ type: 'insert', text });
  };

  /**
   * Expand every token back to its payload, then send (D-7 / D-9).
   *
   * `onSubmit`'s signature is unchanged, so `Composer`, `App.handleSubmit`,
   * `runSlashInput` and `submitMessage` are all untouched — and a slash command
   * therefore sees the EXPANDED text, which is what `/skill foo <pasted body>`
   * needs. `clear` releases every payload in the same dispatch.
   */
  const submit = (text: string) => {
    onSubmit(expandPastes(text, editor.pastes));
    dispatch({ type: 'clear' });
  };

  const recallUp = () => {
    if (history.length === 0) return;
    const idx = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
    const value = history[idx] ?? '';
    dispatch({ type: 'recall', buffer: value, cursor: value.length, historyIndex: idx });
  };

  const recallDown = () => {
    if (historyIndex === null) return;
    const idx = historyIndex + 1;
    // Past the newest entry the walk ends and the draft goes back to empty —
    // `historyIndex: null` is what tells `verticalOrHistory` the user is editing
    // again rather than still stepping.
    if (idx >= history.length) {
      dispatch({ type: 'recall', buffer: '', cursor: 0, historyIndex: null });
      return;
    }
    const value = history[idx] ?? '';
    dispatch({ type: 'recall', buffer: value, cursor: value.length, historyIndex: idx });
  };

  const completeSelection = () => {
    const chosen = popupItems[clampedSel];
    if (!chosen) return;
    if (popupKind === 'slash') {
      const next = `${chosen.label} `;
      dispatch({ type: 'replace', buffer: next, cursor: next.length });
    } else if (popupKind === 'file' && fileTok) {
      const next = buffer.slice(0, fileTok.start) + chosen.label + buffer.slice(fileTok.end);
      dispatch({ type: 'replace', buffer: next, cursor: fileTok.start + chosen.label.length });
    }
  };

  const verticalOrHistory = (dir: 'up' | 'down') => {
    const moved = moveVertical(buffer, cursor, dir);
    if (moved) {
      dispatch({ type: 'moveCursor', cursor: moved.cursor });
      return;
    }
    // At an edge: recall history only from an empty buffer or while already
    // stepping through it — never clobber an in-progress draft (see spec note).
    if (buffer.length === 0 || historyIndex !== null) {
      if (dir === 'up') recallUp();
      else recallDown();
    }
  };

  // --- Input handling. -----------------------------------------------------
  useInput(
    (input, key) => {
      // FIRST STATEMENT, BEFORE THE POPUP BRANCH, AND IT HAS TO STAY THERE.
      // `App` owns the Shift+Tab mode toggle. The popup branch below treats
      // `key.tab` as "accept the highlighted completion", so without this guard
      // pressing Shift+Tab with the `/` palette or an `@` file popup open would
      // BOTH rewrite the user's draft and change the mode — a bug that only
      // appears with a popup open and is therefore easy to ship (AC-P3 / R-P2).
      if (key.tab && key.shift) return;

      // Popup navigation owns Up/Down/Tab/→/Enter/Esc while it is open.
      if (popupVisible) {
        if (key.upArrow) {
          dispatch({ type: 'select', sel: Math.max(0, clampedSel - 1) });
          return;
        }
        if (key.downArrow) {
          dispatch({ type: 'select', sel: Math.min(popupItems.length - 1, clampedSel + 1) });
          return;
        }
        if (key.tab || (key.rightArrow && cursor >= buffer.length)) {
          completeSelection();
          return;
        }
        if (key.return && popupKind === 'slash') {
          const label = popupItems[clampedSel]?.label;
          if (label) submit(label);
          return;
        }
        if (key.escape) {
          dispatch({ type: 'dismiss' });
          return;
        }
        // Any other key falls through so typing keeps filtering the popup.
      }

      if (key.escape) return; // App owns abort / close-overlay.

      // Line-editing intents (Home/End/word/kill) recognized from raw keys.
      const intent = recognize(input, key as KeyState);
      if (intent) {
        const next = applyEdit(buffer, cursor, intent);
        dispatch({ type: 'replace', buffer: next.buffer, cursor: next.cursor });
        return;
      }

      if (key.ctrl) return; // App owns Ctrl+C / L / T / O.

      if (key.return) {
        if (key.meta || key.shift) {
          insert('\n');
          return;
        }
        if (buffer.trim().length === 0) return;
        submit(buffer);
        return;
      }

      if (key.backspace || key.delete) {
        // The `cursor > 0` guard lives in the reducer now, so this branch is one
        // unconditional dispatch and a no-op at the left edge returns the same
        // state object — which React bails out on, exactly as the old
        // `if (cursor > 0)` skipped the `setState`s.
        dispatch({ type: 'backspace' });
        return;
      }

      if (key.leftArrow) {
        dispatch({ type: 'moveCursor', cursor: Math.max(0, cursor - 1) });
        return;
      }
      if (key.rightArrow) {
        dispatch({ type: 'moveCursor', cursor: Math.min(buffer.length, cursor + 1) });
        return;
      }
      // `!key.shift` is load-bearing: Shift+↑/↓ is the viewport's line-scroll
      // binding (§4.10). Without the guard the history recall below swallows it
      // and scrolling appears to be broken for no visible reason.
      if (key.upArrow && !key.shift) {
        verticalOrHistory('up');
        return;
      }
      if (key.downArrow && !key.shift) {
        verticalOrHistory('down');
        return;
      }

      // `?` on an empty idle input opens the help overlay.
      if (input === '?' && buffer.length === 0 && !running && onHelp) {
        onHelp();
        return;
      }

      // A PASTE (section 5.4). It sits AFTER every key branch so a paste can
      // never be shadowed by a key test, and BEFORE `isControlSeq` because a
      // framed string starts with NUL and would otherwise be dropped.
      //
      // The text runs inside `segments` are already sanitised (I-14): Ink drains
      // its whole buffer in one `read()`, so this same string can carry the `\r`
      // of a user who pasted and pressed Enter inside the burst window.
      if (hasPasteFrame(input)) {
        const runs = splitPasteFrames(input);
        const segments: InputSegment[] = runs.map((run) =>
          run.kind === 'paste' ? { kind: 'paste', text: run.text, id: allocatePasteId() } : run,
        );
        if (segments.length === 0) return;
        const refusal = draftLimitRefusal(segments, editor);
        if (refusal) {
          // A refusal dispatches NOTHING, so the draft is byte-for-byte
          // unchanged (AC-9) — and it is never silent (D-11).
          onNotice?.('warn', refusal);
          return;
        }
        dispatch({ type: 'input', segments });
        return;
      }

      // Printable input — drop any unrecognized control/escape byte.
      if (input && !key.tab && !isControlSeq(input)) insert(input);
    },
    { isActive },
  );

  const marker = running ? glyphs.steer : glyphs.caret;
  const markerColor = running ? theme.toolRunning : theme.primary;
  const placeholder = running
    ? `Type to steer the run, Esc to abort${glyphs.ellipsis}`
    : agentMode === 'plan'
    ? `Describe what you want to build; I'll research and plan it first${glyphs.ellipsis}`
    : `Send a message (/ for commands, @ for files)${glyphs.ellipsis}`;
  const overflow = overflowChip(layout.hiddenAbove, layout.hiddenBelow, glyphs);
  const tokenColor = theme.hintFg ?? theme.muted;
  const renderSegments = (segments: ComposerSegment[], keyPrefix: string): React.ReactNode[] =>
    segments.map((segment, i) => (
      <Text key={`${keyPrefix}${i}`} color={segment.kind === 'token' ? tokenColor : undefined}>
        {segment.text}
      </Text>
    ));
  const rowNodes = layout.rows.map((row, i) => {
    if (i !== layout.cursorRow) return <>{renderSegments(row.segments, `s${i}.`)}</>;
    // The caret is drawn as one inverse cell, split at the column
    // `layoutComposer` reported — the same width table it wrapped with (I-9).
    const split = splitRowAtColumn(row, layout.cursorCol);
    return (
      <>
        {renderSegments(split.before, `b${i}.`)}
        <Text inverse>{split.at ? split.at.text : ' '}</Text>
        {renderSegments(split.after, `a${i}.`)}
      </>
    );
  });

  const inputRow = (
    <Box flexDirection="row">
      <Text color={markerColor} bold>
        {marker}{' '}
      </Text>
      {/*
        `flexShrink={1}` here and `flexShrink={0}` on the chip: under pressure the
        DRAFT wraps, never the chip. A half-truncated `↓ 12 new li` reads as a
        rendering bug and cuts off the very number it exists to show (I-8).
      */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {buffer.length === 0 ? (
          <Text wrap="truncate" color={theme.muted}>{placeholder}</Text>
        ) : (
          rowNodes.map((node, i) =>
            overflow && i === rowNodes.length - 1 ? (
              // The overflow indicator rides the LAST rendered row rather than
              // taking one of its own: an extra row would put the composer's
              // real height one above the `draftRows` it just reported (I-8).
              <Box key={i} flexDirection="row">
                <Box flexGrow={1} flexShrink={1}>
                  <Text>{node}</Text>
                </Box>
                <Box flexShrink={0} width={overflow.cells} justifyContent="flex-end">
                  <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
                    {overflow.text}
                  </Text>
                </Box>
              </Box>
            ) : (
              <Text key={i}>{node}</Text>
            ),
          )
        )}
      </Box>
      {chip && (
        // `alignSelf="flex-start"` pins the chip to the FIRST row of a multi-line
        // draft. Yoga's default `stretch` sizes this box to the full height of the
        // editor; it renders on the top row either way today, and relying on that
        // is how a later `justifyContent` edit moves it without failing anything.
        //
        // `width={chip.cells}` is a FIXED cell, not the chip's natural width
        // (P2-4). The chip is the only thing on this row whose width changes while
        // the user is typing — `↓ 9` becomes `↓ 10` becomes `↓ 100` — and every
        // change would otherwise re-wrap a draft that fills the line.
        <Box
          flexShrink={0}
          alignSelf="flex-start"
          marginLeft={1}
          width={chip.cells}
          justifyContent="flex-end"
        >
          <Text wrap="truncate" color={theme.hintFg ?? theme.muted}>
            {chip.text}
          </Text>
        </Box>
      )}
    </Box>
  );

  return (
    <Box flexDirection="column" flexShrink={0}>
      {popupVisible && (
        <AutocompletePopup
          items={popupItems}
          selected={clampedSel}
          theme={theme}
          caps={caps}
          maxRows={popupMaxRows}
          layout={popupLayout}
        />
      )}
      {bordered ? (
        <Box
          flexDirection="column"
          flexShrink={0}
          borderStyle={glyphs.boxStyle}
          borderColor={bordered.color}
          paddingX={1}
        >
          {inputRow}
        </Box>
      ) : (
        inputRow
      )}
    </Box>
  );
}
