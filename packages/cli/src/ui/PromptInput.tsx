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

import React, { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { popupCapacity } from './layout/budget.js';
import { glob as tinyGlob } from 'tinyglobby';
import type { Theme } from './theme.js';
import type { TermCapabilities } from './capabilities.js';
import { pickGlyphs } from './glyphs.js';
import { PromptCaret } from './PromptCaret.js';
import { recognize, type EditIntent, type KeyState } from '../input/keymap.js';
import { AutocompletePopup, type Suggestion } from './AutocompletePopup.js';
import { buildAutocompleteLayout } from './layout/autocomplete.js';
import {
  editorReducer,
  INITIAL_EDITOR_STATE,
  type EditorState,
  type InputSegment,
} from './editor-reducer.js';
import { hasPasteFrame } from './paste-frames.js';
import {
  hasEnterFrame,
  splitEnterFrames,
} from './enter-frames.js';
import { planComposerInput, type ComposerInputIntent,
  type ComposerSubmitResult } from './composer-input.js';
import { allocatePasteId, expandPastes, expandRangeOverTokens } from './paste-tokens.js';
import { draftMaxRows } from './composer-limits.js';
import { layoutComposer, splitRowAtColumn, type ComposerSegment } from './composer-rows.js';
import { moveVisualCursor, snapGrapheme, stepGrapheme } from './editor-navigation.js';
import { interactionCopy } from './interaction-copy.js';
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
  cols?: number;
  terminalRows?: number;
  statusExpanded?: boolean;
  cursorVisible?: boolean;
  onInteraction?: () => void;
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
   * The popup shares the scrolling footer with the editor. Its height budget
   * reserves visible message rows without changing the viewport or TODO rail.
   */
  popupMaxRows?: number;
  /** Total menu rows, including borders and the overflow hint. */
  popupMaxHeight?: number;
  onPopupRowsChange?: (rows: number) => void;
  onCompletionContextChange?: (context: 'none' | 'slash' | 'file') => void;
  /** True only when the stdin filter normalized DEL before Ink parsed it. */
  deleteDisambiguated?: boolean;
  onSubmit: (text: string) => ComposerSubmitResult;
  onHelp?: () => void;
  onEscape?: () => void;
  onEscapeDismiss?: () => void;
  reducedMotion?: boolean;
  /**
   * Mirror of the session mode. Read for the placeholder only — the toggle
   * itself belongs to `App`, and this component's job is to get out of its way
   * (see the first statement of the input handler).
   */
  agentMode?: AgentMode;

  borderColor?: string;
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
/** `↓ 999+ lines below · PgDn` — the widest form the full branch can produce. */
const CHIP_FULL_CELLS = 27;
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
    text: `${glyphs.arrowDown} ${shown} ${noun} below ${glyphs.midDot} PgDn`,
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
  if (cursor <= 0) return 0;
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
  const range = expandRangeOverTokens(buffer,
    snapGrapheme(buffer, from), snapGrapheme(buffer, to, true));
  return { buffer: buffer.slice(0, range.from) + buffer.slice(range.to), cursor: range.from };
}

/** Apply an edit intent as a pure buffer/cursor transform. */
export function applyEdit(
  buffer: string,
  cursor: number,
  intent: EditIntent,
): { buffer: string; cursor: number } {
  cursor = snapGrapheme(buffer, cursor);
  switch (intent) {
    // Navigation may enter a token label; insertion and range deletion retain
    // the existing token snapping and expansion contracts.
    case 'home':
      return { buffer, cursor: lineStart(buffer, cursor) };
    case 'end':
      return { buffer, cursor: lineEnd(buffer, cursor) };
    case 'wordLeft':
      return { buffer, cursor: snapGrapheme(buffer, prevWord(buffer, cursor)) };
    case 'wordRight':
      return { buffer, cursor: snapGrapheme(buffer, nextWord(buffer, cursor), true) };
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
  const moved = moveVisualCursor({ buffer, cursor, direction: dir, cols: Number.MAX_SAFE_INTEGER });
  return moved ? { cursor: moved.cursor } : null;
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
  cols: colsProp, terminalRows: terminalRowsProp, statusExpanded = false, cursorVisible = true, onInteraction,
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
  onCompletionContextChange,
  deleteDisambiguated = false,
  agentMode,
  onSubmit,
  onHelp,
  onEscape,
  onEscapeDismiss,
  reducedMotion = false,
  borderColor,
  onDraftChange,
  onNotice,
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
  const cols = colsProp ?? stdout?.columns ?? 80;
  const terminalRows = terminalRowsProp ?? stdout?.rows ?? 24;
  // Err NARROW. Wrapping wider than the box Ink gives us would make Ink wrap a
  // second time, and then `layout.rows.length` is a lie — which is the one thing
  // this module may not be.
  const chromeCols = 2 /* border */ + 2 /* paddingX */ + 2 /* marker */;
  const baseCols = Math.max(8, cols - chromeCols);
  const measure = (wrapCols: number) =>
    layoutComposer({
      buffer,
      cursor,
      cols: wrapCols,
      maxRows: draftMaxRows(terminalRows),
      // Scrolling may hide the caret, but must not change the measured draft.
      // Otherwise visibility can toggle wrapping and feed back into scrolling.
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
  const preferredColumnWidth = useRef<number>();
  useLayoutEffect(() => { preferredColumnWidth.current = undefined; }, [usableCols]);
  const draftRowCount = Math.max(1, layout.rows.length);
  const menuCapacity = Math.min(popupMaxHeight ?? Infinity,
    popupCapacity(terminalRows, draftRowCount, statusExpanded));
  const popupLayout = buildAutocompleteLayout({
    itemCount: isActive ? popupItems.length : 0,
    selected: clampedSel,
    maxRows: popupMaxRows,
    maxHeight: menuCapacity,
  });
  const popupVisible = isActive && popupLayout.rowCount > 0;
  // Report on every mount, including zero. Cleanup belongs to a separate
  // effect so changing height does not publish an intermediate zero budget.
  useLayoutEffect(() => {
    onPopupRowsChange?.(popupLayout.rowCount);
  }, [onPopupRowsChange, popupLayout.rowCount]);
  useLayoutEffect(() => () => onPopupRowsChange?.(0), [onPopupRowsChange]);
  const completion = popupVisible ? popupKind ?? 'none' : 'none';
  const completionCallback = useRef(onCompletionContextChange);
  completionCallback.current = onCompletionContextChange;
  const lastCompletion = useRef<typeof completion>();
  useLayoutEffect(() => {
    if (!onCompletionContextChange || lastCompletion.current === completion) return;
    lastCompletion.current = completion;
    onCompletionContextChange?.(completion);
  }, [onCompletionContextChange, completion]);
  useLayoutEffect(() => () => completionCallback.current?.('none'), []);

  const caretResetKey = useMemo(() => ({}), [buffer, cursor, isActive, usableCols]);

  // --- Draft presence and height, reported only on a transition. -----------
  // Notifying on every keystroke would re-render the whole App tree per key. The
  // row count changes on a line break or a wrap boundary, not per character
  // (R-6), so widening this callback does not widen how often it fires.
  const hasDraft = buffer.length > 0;
  const lastReportedDraft = useRef<{ hasDraft: boolean; rows: number } | null>(null);
  useLayoutEffect(() => {
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
    onInteraction?.();
    dispatch({ type: 'insert', text });
  };

  const resolveSubmit = (state: EditorState): string | null => {
    const suggestions = state.dismissed ? null : slashSuggestions(state.buffer, commands);
    const selectedIndex = Math.min(state.sel, (suggestions?.length ?? 0) - 1);
    const suggestionLayout = buildAutocompleteLayout({
      itemCount: isActive ? suggestions?.length ?? 0 : 0,
      selected: selectedIndex, maxRows: popupMaxRows, maxHeight: menuCapacity,
    });
    const selected = suggestionLayout.rowCount > 0 ? suggestions?.[selectedIndex] : undefined;
    const text = selected?.label ?? expandPastes(state.buffer, state.pastes);
    return text.trim().length > 0 ? text : null;
  };

  const transact = (intents: ComposerInputIntent[]): void => {
    const plan = planComposerInput({
      editor, intents, resolveSubmit, checkPasteLimit: draftLimitRefusal,
    });
    if (plan.refusal) { onNotice?.('warn', plan.refusal); return; }
    onInteraction?.();
    let result: ComposerSubmitResult = { accepted: true };
    if (plan.submission !== undefined) {
      try {
        result = onSubmit(plan.submission);
      } catch (error) {
        result = { accepted: false, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    dispatch({ type: 'adopt', state: result.accepted ? plan.nextEditor : plan.rejectedEditor });
    if (!result.accepted) {
      onNotice?.('error', result.reason ?? 'Message was not accepted; input is kept in the draft.');
    } else if (plan.notice) {
      onNotice?.('warn', plan.notice);
    }
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
    onInteraction?.();
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
    onInteraction?.();
    const moved = moveVisualCursor({ buffer, cursor, cols: usableCols, direction: dir,
      preferredVisualColumn: preferredColumnWidth.current === usableCols
        ? editor.preferredVisualColumn : undefined });
    if (moved) {
      preferredColumnWidth.current = usableCols;
      dispatch({ type: 'moveCursor', ...moved });
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
      if (key.pageUp || key.pageDown || (key.shift && (key.upArrow || key.downArrow))) return;
      if ((key.return || input === '\r') && (key.meta || key.shift)) {
        insert('\n');
        return;
      }

      if (hasPasteFrame(input) || hasEnterFrame(input) || /[\r\n]/.test(input)) {
        const intents: ComposerInputIntent[] = splitEnterFrames(input).map((frame) =>
          frame.kind === 'paste' ? { ...frame, id: allocatePasteId() } : frame,
        );
        if (intents.length > 0) transact(intents);
        return;
      }

      // Popup navigation owns Up/Down/Tab/→/Enter/Esc while it is open.
      if (popupVisible) {
        if (key.upArrow) {
          onInteraction?.();
          dispatch({ type: 'select', sel: Math.max(0, clampedSel - 1) });
          return;
        }
        if (key.downArrow) {
          onInteraction?.();
          dispatch({ type: 'select', sel: Math.min(popupItems.length - 1, clampedSel + 1) });
          return;
        }
        if (key.tab || (key.rightArrow && cursor >= buffer.length)) {
          completeSelection();
          return;
        }
        if (key.return && popupKind === 'slash') {
          transact([{ kind: 'submit' }]);
          return;
        }
        if (key.escape) {
          dispatch({ type: 'dismiss' });
          onEscapeDismiss?.();
          return;
        }
        // Any other key falls through so typing keeps filtering the popup.
      }

      if (key.escape) {
        onEscape?.();
        return;
      }

      // Line-editing intents (Home/End/word/kill) recognized from raw keys.
      const intent = key.meta && (key.backspace || key.delete)
        ? 'deleteWordBack' : recognize(input, key as KeyState);
      if (intent) {
        onInteraction?.();
        const next = applyEdit(buffer, cursor, intent);
        const moving = intent === 'home' || intent === 'end'
          || intent === 'wordLeft' || intent === 'wordRight';
        dispatch(moving ? { type: 'moveCursor', cursor: next.cursor }
          : { type: 'replace', buffer: next.buffer, cursor: next.cursor });
        return;
      }

      if (key.ctrl) return; // App owns Ctrl+C / L / T / O.

      if (key.return) {
        if (key.meta || key.shift) {
          insert('\n');
          return;
        }
        if (buffer.trim().length === 0) return;
        transact([{ kind: 'submit' }]);
        return;
      }

      if (key.backspace || key.delete) {
        onInteraction?.();
        // The `cursor > 0` guard lives in the reducer now, so this branch is one
        // unconditional dispatch and a no-op at the left edge returns the same
        // state object — which React bails out on, exactly as the old
        // `if (cursor > 0)` skipped the `setState`s.
        dispatch({ type: key.delete && deleteDisambiguated ? 'delete' : 'backspace' });
        return;
      }

      if (key.leftArrow) {
        onInteraction?.();
        dispatch({ type: 'moveCursor', cursor: stepGrapheme(buffer, cursor, 'left') });
        return;
      }
      if (key.rightArrow) {
        onInteraction?.();
        dispatch({ type: 'moveCursor', cursor: stepGrapheme(buffer, cursor, 'right') });
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

      // Printable input — drop any unrecognized control/escape byte.
      if (input && !key.tab && !isControlSeq(input)) insert(input);
    },
    { isActive },
  );

  const marker = running ? glyphs.steer : glyphs.caret;
  const markerColor = running ? theme.toolRunning : theme.primary;
  const placeholder = running ? interactionCopy.runningPlaceholder : interactionCopy.idlePlaceholder;
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
        <PromptCaret text={split.at ? split.at.text : ' '} active={isActive && cursorVisible}
          reducedMotion={reducedMotion} colorLevel={caps.colorLevel} resetKey={caretResetKey}
          color={split.at?.kind === 'token' ? tokenColor : undefined} />
        {renderSegments(split.after, `a${i}.`)}
      </>
    );
  });

  const inputRow = (
    <Box flexDirection="row">
      <Text color={markerColor} bold>
        {marker}{' '}
      </Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {buffer.length === 0 ? (
          <Text wrap="truncate" color={theme.muted}>
            <PromptCaret text={String.fromCodePoint(placeholder.codePointAt(0)!)} active={isActive && cursorVisible}
              reducedMotion={reducedMotion} colorLevel={caps.colorLevel} color={theme.muted}
              resetKey={caretResetKey} />
            {placeholder.slice(String.fromCodePoint(placeholder.codePointAt(0)!).length)}
          </Text>
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
      {(
        <Box
          flexDirection="column"
          flexShrink={0}
          borderStyle={glyphs.boxStyle}
          borderColor={borderColor}
          paddingX={1}
        >
          {inputRow}
        </Box>
      )}
    </Box>
  );
}
