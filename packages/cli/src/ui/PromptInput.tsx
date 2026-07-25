/**
 * PromptInput (spec §3.6 / §3.10) — a controlled multiline input on Ink's
 * `useInput` with: full line editing (Home/End, word jump/delete, kill-line via
 * `input/keymap`), multi-line vertical cursor navigation, prompt-history recall
 * at the edges, a slash-command palette, and `@file` path completion.
 *
 * The buffer/cursor transforms (`applyEdit`, `moveVertical`) and the suggestion
 * computations (`slashSuggestions`, `fileTokenAt`) are pure module functions,
 * exported for `input.test.ts`, so the component itself stays thin.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glob as tinyGlob } from 'tinyglobby';
import type { Theme } from './theme.js';
import { recognize, type EditIntent, type KeyState } from '../input/keymap.js';
import { AutocompletePopup, type Suggestion } from './AutocompletePopup.js';

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
  onSubmit: (text: string) => void;
  onHelp?: () => void;
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

/** Apply an edit intent as a pure buffer/cursor transform. */
export function applyEdit(
  buffer: string,
  cursor: number,
  intent: EditIntent,
): { buffer: string; cursor: number } {
  switch (intent) {
    case 'home':
      return { buffer, cursor: lineStart(buffer, cursor) };
    case 'end':
      return { buffer, cursor: lineEnd(buffer, cursor) };
    case 'wordLeft':
      return { buffer, cursor: prevWord(buffer, cursor) };
    case 'wordRight':
      return { buffer, cursor: nextWord(buffer, cursor) };
    case 'deleteWordBack': {
      const start = prevWord(buffer, cursor);
      return { buffer: buffer.slice(0, start) + buffer.slice(cursor), cursor: start };
    }
    case 'killToStart': {
      const start = lineStart(buffer, cursor);
      return { buffer: buffer.slice(0, start) + buffer.slice(cursor), cursor: start };
    }
    case 'killToEnd': {
      const end = lineEnd(buffer, cursor);
      return { buffer: buffer.slice(0, cursor) + buffer.slice(end), cursor };
    }
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

/** Slash-command suggestions when the buffer is a bare `/word` (no space yet). */
export function slashSuggestions(buffer: string, commands: CommandOption[]): Suggestion[] | null {
  const m = /^\/(\w*)$/.exec(buffer);
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
  onSubmit,
  onHelp,
}: PromptInputProps): React.ReactElement {
  const [buffer, setBuffer] = useState('');
  const [cursor, setCursor] = useState(0);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [sel, setSel] = useState(0);
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

  // --- Mutators. -----------------------------------------------------------
  const resetDraftFlags = () => {
    setHistoryIndex(null);
    setDismissed(false);
    setSel(0);
  };

  const insert = (text: string) => {
    setBuffer(buffer.slice(0, cursor) + text + buffer.slice(cursor));
    setCursor(cursor + text.length);
    resetDraftFlags();
  };

  const submit = (text: string) => {
    onSubmit(text);
    setBuffer('');
    setCursor(0);
    resetDraftFlags();
  };

  const recallUp = () => {
    if (history.length === 0) return;
    const idx = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
    const value = history[idx] ?? '';
    setHistoryIndex(idx);
    setBuffer(value);
    setCursor(value.length);
  };

  const recallDown = () => {
    if (historyIndex === null) return;
    const idx = historyIndex + 1;
    if (idx >= history.length) {
      setHistoryIndex(null);
      setBuffer('');
      setCursor(0);
    } else {
      const value = history[idx] ?? '';
      setHistoryIndex(idx);
      setBuffer(value);
      setCursor(value.length);
    }
  };

  const completeSelection = () => {
    const chosen = popupItems[clampedSel];
    if (!chosen) return;
    if (popupKind === 'slash') {
      const next = `${chosen.label} `;
      setBuffer(next);
      setCursor(next.length);
    } else if (popupKind === 'file' && fileTok) {
      const next = buffer.slice(0, fileTok.start) + chosen.label + buffer.slice(fileTok.end);
      setBuffer(next);
      setCursor(fileTok.start + chosen.label.length);
    }
    resetDraftFlags();
  };

  const verticalOrHistory = (dir: 'up' | 'down') => {
    const moved = moveVertical(buffer, cursor, dir);
    if (moved) {
      setCursor(moved.cursor);
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
      // Popup navigation owns Up/Down/Tab/→/Enter/Esc while it is open.
      if (popupItems.length > 0) {
        if (key.upArrow) {
          setSel(Math.max(0, clampedSel - 1));
          return;
        }
        if (key.downArrow) {
          setSel(Math.min(popupItems.length - 1, clampedSel + 1));
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
          setDismissed(true);
          return;
        }
        // Any other key falls through so typing keeps filtering the popup.
      }

      if (key.escape) return; // App owns abort / close-overlay.

      // Line-editing intents (Home/End/word/kill) recognized from raw keys.
      const intent = recognize(input, key as KeyState);
      if (intent) {
        const next = applyEdit(buffer, cursor, intent);
        setBuffer(next.buffer);
        setCursor(next.cursor);
        resetDraftFlags();
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
        if (cursor > 0) {
          setBuffer(buffer.slice(0, cursor - 1) + buffer.slice(cursor));
          setCursor(cursor - 1);
          resetDraftFlags();
        }
        return;
      }

      if (key.leftArrow) {
        setCursor(Math.max(0, cursor - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(buffer.length, cursor + 1));
        return;
      }
      if (key.upArrow) {
        verticalOrHistory('up');
        return;
      }
      if (key.downArrow) {
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

  const marker = running ? '⇢' : '❯';
  const markerColor = running ? theme.toolRunning : theme.primary;
  const placeholder = running
    ? 'Type to steer the run, Esc to abort…'
    : 'Send a message (/ for commands, @ for files)…';
  const lines = renderWithCursor(buffer, cursor, isActive);

  return (
    <Box flexDirection="column">
      {popupItems.length > 0 && (
        <AutocompletePopup items={popupItems} selected={clampedSel} theme={theme} />
      )}
      <Box flexDirection="row">
        <Text color={markerColor} bold>
          {marker}{' '}
        </Text>
        <Box flexDirection="column">
          {buffer.length === 0 ? (
            <Text color={theme.muted}>{placeholder}</Text>
          ) : (
            lines.map((line, i) => <Text key={i}>{line}</Text>)
          )}
        </Box>
      </Box>
    </Box>
  );
}

/** Split the buffer into lines and render an inverse cursor at `cursor`. */
function renderWithCursor(buffer: string, cursor: number, active: boolean): React.ReactNode[] {
  if (!active) return buffer.split('\n');
  const before = buffer.slice(0, cursor);
  const at = buffer[cursor] ?? ' ';
  const after = buffer.slice(cursor + 1);

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const nodes: React.ReactNode[] = [];

  const lastBeforeIdx = beforeLines.length - 1;
  for (let i = 0; i < lastBeforeIdx; i += 1) {
    nodes.push(<Text key={`b${i}`}>{beforeLines[i]}</Text>);
  }

  const cursorChar = at === '\n' ? ' ' : at;
  const firstAfter = afterLines[0] ?? '';
  nodes.push(
    <Text key="cursor-line">
      {beforeLines[lastBeforeIdx]}
      <Text inverse>{cursorChar}</Text>
      {at === '\n' ? '' : firstAfter}
    </Text>,
  );

  const remainingAfter = at === '\n' ? afterLines : afterLines.slice(1);
  for (let i = 0; i < remainingAfter.length; i += 1) {
    nodes.push(<Text key={`a${i}`}>{remainingAfter[i]}</Text>);
  }

  return nodes;
}
