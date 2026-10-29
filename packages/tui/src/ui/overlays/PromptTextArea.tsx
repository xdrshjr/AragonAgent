/**
 * The one editable multi-line field in this feature (quick-prompt-library D-11).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`.
 *
 * RENDER AND CARET COME FROM THE SAME FUNCTION. `layoutComposer` wraps the buffer and
 * reports the caret's row and column from ONE `buildEditorVisualMap` pass, and the
 * drawing below splits that same row at that same column. Every second authority
 * here - a prose wrapper, a second width table, a "count the characters instead" -
 * puts the caret on a cell that does not hold the character it points at, and the
 * only symptom is that the user's edits land one column off in Chinese text.
 *
 * WHY `layout/wrap-rows.ts::wrapToRows` IS BANNED HERE (it is used one directory
 * away, for the list's read-only preview): it splits on whitespace and rejoins with
 * single spaces, so it eats indentation and destroys the character-index-to-cell
 * mapping. `composer-rows.ts:16-20` says so in as many words, and that is the module
 * this one borrows from.
 *
 * NO PASTE-COLLAPSE TOKENS, deliberately. The token machinery exists so a 218-line
 * paste does not have to live in a one-line input; this IS a multi-line field, and a
 * token inside a saved prompt body would be data corruption the user could not undo.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { layoutComposer, splitRowAtColumn, type ComposerSegment } from '../composer-rows.js';
import { moveVisualCursor, snapGrapheme, stepGrapheme } from '../editor-navigation.js';
import { PromptCaret } from '../PromptCaret.js';

export interface PromptTextAreaState {
  buffer: string;
  cursor: number;
  /** Kept across vertical moves, cleared by any horizontal one (composer parity). */
  preferredVisualColumn?: number;
}

export const EMPTY_TEXT_AREA: PromptTextAreaState = { buffer: '', cursor: 0 };

export type PromptTextAreaAction =
  | { type: 'insert'; text: string }
  | { type: 'newline' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' }
  | { type: 'right' }
  | { type: 'home' }
  | { type: 'end' }
  /** Vertical moves need the wrap width; it is part of the ACTION, not of the state. */
  | { type: 'up'; cols: number }
  | { type: 'down'; cols: number }
  | { type: 'replace'; buffer: string; cursor: number };

function withCursor(
  state: PromptTextAreaState,
  buffer: string,
  cursor: number,
): PromptTextAreaState {
  return { buffer, cursor: snapGrapheme(buffer, cursor, true) };
}

/**
 * Pure. No React, no Ink, no filesystem - so the twelve editing cases are a table
 * test rather than a rendered frame assertion.
 */
export function promptTextAreaReducer(
  state: PromptTextAreaState,
  action: PromptTextAreaAction,
): PromptTextAreaState {
  switch (action.type) {
    case 'insert': {
      const cursor = snapGrapheme(state.buffer, state.cursor);
      const buffer = state.buffer.slice(0, cursor) + action.text + state.buffer.slice(cursor);
      return {
        buffer,
        cursor: snapGrapheme(buffer, cursor + action.text.length, true),
      };
    }
    case 'newline': {
      const cursor = snapGrapheme(state.buffer, state.cursor);
      const buffer = `${state.buffer.slice(0, cursor)}\n${state.buffer.slice(cursor)}`;
      return { buffer, cursor: cursor + 1 };
    }
    case 'backspace':
    case 'delete': {
      const cursor = snapGrapheme(state.buffer, state.cursor);
      if (action.type === 'backspace') {
        if (cursor <= 0) return state;
        const from = stepGrapheme(state.buffer, cursor, 'left');
        return withCursor(state, state.buffer.slice(0, from) + state.buffer.slice(cursor), from);
      }
      if (cursor >= state.buffer.length) return state;
      const to = stepGrapheme(state.buffer, cursor, 'right');
      return withCursor(state, state.buffer.slice(0, cursor) + state.buffer.slice(to), cursor);
    }
    case 'left':
      return {
        buffer: state.buffer,
        cursor: stepGrapheme(state.buffer, state.cursor, 'left'),
      };
    case 'right':
      return {
        buffer: state.buffer,
        cursor: stepGrapheme(state.buffer, state.cursor, 'right'),
      };
    case 'home':
      return { buffer: state.buffer, cursor: 0 };
    case 'end':
      return { buffer: state.buffer, cursor: snapGrapheme(state.buffer, state.buffer.length) };
    case 'up':
    case 'down': {
      const moved = moveVisualCursor({
        buffer: state.buffer,
        cursor: state.cursor,
        cols: action.cols,
        direction: action.type,
        ...(state.preferredVisualColumn === undefined
          ? {}
          : { preferredVisualColumn: state.preferredVisualColumn }),
      });
      // A vertical move at the first or last visual row stays put rather than
      // jumping to the buffer's edge: the composer behaves the same way, and a jump
      // here would silently relocate the caret in a field the user is editing.
      return moved === null
        ? state
        : {
            buffer: state.buffer,
            cursor: moved.cursor,
            preferredVisualColumn: moved.preferredVisualColumn,
          };
    }
    case 'replace':
      return withCursor(state, action.buffer, action.cursor);
  }
}

export interface PromptTextAreaProps {
  state: PromptTextAreaState;
  /** Wrap width, in cells, already net of the field's own chrome. */
  cols: number;
  /** Rows the field may occupy. `1` is the single-line case for title/description. */
  rows: number;
  focused: boolean;
  theme: Theme;
  caps: TermCapabilities;
  reducedMotion?: boolean;
}

function renderSegments(segments: ComposerSegment[], keyPrefix: string): React.ReactNode[] {
  return segments.map((segment, at) => (
    <Text key={`${keyPrefix}${at}`}>{segment.text}</Text>
  ));
}

/**
 * One field's worth of rows.
 *
 * The overflow chip is a plain `+N` on the LAST row rather than a row of its own:
 * an extra row would make this component draw one more line than the caller budgeted
 * for, and the frame it lives in has no way to find out.
 */
export function PromptTextArea(props: PromptTextAreaProps): React.ReactElement {
  const { state, cols, rows, focused } = props;
  const glyphs = pickGlyphs(props.caps);
  const layout = layoutComposer({
    buffer: state.buffer,
    cursor: state.cursor,
    cols: Math.max(4, cols),
    maxRows: Math.max(1, rows),
    active: focused,
  });
  const hidden = layout.hiddenAbove + layout.hiddenBelow;
  const resetKey = React.useMemo(
    () => ({}),
    [state.buffer, state.cursor, focused, props.cols, rows],
  );
  if (state.buffer.length === 0) {
    return (
      <Text wrap="truncate" color={props.theme.muted}>
        <PromptCaret
          text=" "
          active={focused}
          reducedMotion={props.reducedMotion ?? false}
          colorLevel={props.caps.colorLevel}
          color={props.theme.muted}
          resetKey={resetKey}
        />
        {glyphs.ellipsis}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      {layout.rows.map((row, at) => {
        if (at !== layout.cursorRow) {
          return <Text key={at} wrap="truncate">{renderSegments(row.segments, `r${at}.`)}</Text>;
        }
        const split = splitRowAtColumn(row, layout.cursorCol);
        return (
          <Text key={at} wrap="truncate">
            {renderSegments(split.before, `b${at}.`)}
            <PromptCaret
              text={split.at ? split.at.text : ' '}
              active={focused}
              reducedMotion={props.reducedMotion ?? false}
              colorLevel={props.caps.colorLevel}
              resetKey={resetKey}
            />
            {renderSegments(split.after, `a${at}.`)}
            {at === layout.rows.length - 1 && hidden > 0
              ? <Text color={props.theme.muted}>{` +${hidden}`}</Text>
              : null}
          </Text>
        );
      })}
    </Box>
  );
}
