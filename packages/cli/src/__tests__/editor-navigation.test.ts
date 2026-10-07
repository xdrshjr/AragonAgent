import { describe, expect, it } from 'vitest';
import { editorReducer, INITIAL_EDITOR_STATE } from '../ui/editor-reducer.js';
import { layoutComposer, splitRowAtColumn } from '../ui/composer-rows.js';
import { draftMaxRows } from '../ui/composer-limits.js';
import { buildEditorVisualMap, moveVisualCursor, snapGrapheme,
  stepGrapheme } from '../ui/editor-navigation.js';

describe('grapheme editing and shared visual rows', () => {
  it.each(['e\u0301', '\ud83d\udc69\u200d\ud83d\udcbb', '\ud83c\uddfa\ud83c\uddf8'])
  ('backspace removes the complete grapheme %s', (grapheme) => {
    const state = { ...INITIAL_EDITOR_STATE, buffer: `a${grapheme}b`, cursor: 1 + grapheme.length };
    const next = editorReducer(state, { type: 'backspace' });
    expect(next.buffer).toBe('ab');
    expect(next.cursor).toBe(1);
  });

  it('renders a ZWJ emoji as one two-cell grapheme and caret', () => {
    const emoji = '\ud83d\udc69\u200d\ud83d\udcbb';
    const layout = layoutComposer({ buffer: `a${emoji}b`, cursor: 1,
      cols: 4, maxRows: 6, active: true });
    expect(layout.totalRows).toBe(1);
    expect(splitRowAtColumn(layout.rows[0]!, 1).at?.text).toBe(emoji);
  });

  it('clamps the editor to a quarter terminal with a six-row maximum', () => {
    expect([12, 20, 24, 30].map(draftMaxRows)).toEqual([3, 5, 6, 6]);
    expect(draftMaxRows(1)).toBe(1);
  });

  it('uses the next row for a soft boundary and leftmost whole CJK boundary', () => {
    const buffer = 'abcde\u4e2d\u6587z';
    const map = buildEditorVisualMap({ buffer, cursor: 5, cols: 5 });
    expect(map.cursor).toEqual({ index: 5, row: 1, column: 0 });
    expect(moveVisualCursor({ buffer, cursor: 3, cols: 5, direction: 'down' }))
      .toEqual({ cursor: 6, preferredVisualColumn: 3 });
  });

  it('retains tabs in the buffer but uses four-cell tab stops for navigation', () => {
    const buffer = 'a\tb\n123456';
    const map = buildEditorVisualMap({ buffer, cursor: 2, cols: 20 });
    expect(map.cursor.column).toBe(4);
    expect(moveVisualCursor({ buffer, cursor: 2, cols: 20, direction: 'down' }))
      .toEqual({ cursor: 8, preferredVisualColumn: 4 });
    expect(buffer).toContain('\t');
  });

  it.each(['e\u0301', '\ud83d\udc69\u200d\ud83d\udcbb', '\ud83c\uddfa\ud83c\uddf8'])
  ('left, right and forward deletion keep %s atomic', (grapheme) => {
    const buffer = `a${grapheme}b`;
    expect(stepGrapheme(buffer, 1, 'right')).toBe(1 + grapheme.length);
    expect(stepGrapheme(buffer, 1 + grapheme.length, 'left')).toBe(1);
    for (let cursor = 2; cursor < 1 + grapheme.length; cursor += 1) {
      expect(snapGrapheme(buffer, cursor)).toBe(1);
    }
    const next = editorReducer({ ...INITIAL_EDITOR_STATE, buffer, cursor: 1 }, { type: 'delete' });
    expect(next.buffer).toBe('ab');
    expect(next.cursor).toBe(1);
  });

  it('deleting newlines joins logical lines in both directions', () => {
    for (const [type, cursor] of [['backspace', 2], ['delete', 1]] as const) {
      const next = editorReducer({ ...INITIAL_EDITOR_STATE, buffer: 'a\nb', cursor }, { type });
      expect(next.buffer).toBe('ab');
      expect(next.cursor).toBe(1);
    }
  });

  it('forward deletion releases a whole paste token and its payload', () => {
    const pasted = editorReducer(INITIAL_EDITOR_STATE, { type: 'input',
      segments: [{ kind: 'paste', text: 'line\n'.repeat(100), id: 77 }] });
    const next = editorReducer({ ...pasted, cursor: 0 }, { type: 'delete' });
    expect(next.buffer).toBe('');
    expect(next.pastes.size).toBe(0);
  });
});
