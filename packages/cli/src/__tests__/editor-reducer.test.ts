/**
 * The composer's editor reducer (tui-input-flicker-fix §3.4 / §4.3).
 *
 * F3 is the only part of this package that can regress INPUT SEMANTICS (K-7),
 * and the transforms it replaces were five loose `setState` calls with an
 * implicit contract about which of them reset the draft flags. That contract is
 * what these cases pin down.
 */

import { describe, expect, it } from 'vitest';
import {
  editorReducer,
  INITIAL_EDITOR_STATE,
  type EditorState,
  type InputSegment,
} from '../ui/editor-reducer.js';

function state(patch: Partial<EditorState> = {}): EditorState {
  return { ...INITIAL_EDITOR_STATE, ...patch };
}

describe('editorReducer — insert', () => {
  it('inserts at the cursor and advances it by the inserted length', () => {
    const next = editorReducer(state({ buffer: 'ac', cursor: 1 }), { type: 'insert', text: 'b' });
    expect(next.buffer).toBe('abc');
    expect(next.cursor).toBe(2);
  });

  it('inserts multi-character text (Shift+Enter writes a newline this way)', () => {
    const next = editorReducer(state({ buffer: 'ab', cursor: 2 }), { type: 'insert', text: '\n' });
    expect(next.buffer).toBe('ab\n');
    expect(next.cursor).toBe(3);
  });

  it('resets all three draft flags', () => {
    const next = editorReducer(
      state({ buffer: 'x', cursor: 1, historyIndex: 2, dismissed: true, sel: 4 }),
      { type: 'insert', text: 'y' },
    );
    expect(next.historyIndex).toBeNull();
    expect(next.dismissed).toBe(false);
    expect(next.sel).toBe(0);
  });
});

describe('editorReducer — replace', () => {
  it('takes the buffer and cursor verbatim and resets the draft flags', () => {
    const next = editorReducer(state({ buffer: 'old', cursor: 3, dismissed: true, sel: 2 }), {
      type: 'replace',
      buffer: '/help ',
      cursor: 6,
    });
    expect(next).toEqual(state({ buffer: '/help ', cursor: 6 }));
  });
});

describe('editorReducer — backspace', () => {
  it('deletes the character before the cursor', () => {
    const next = editorReducer(state({ buffer: 'abc', cursor: 2 }), { type: 'backspace' });
    expect(next.buffer).toBe('ac');
    expect(next.cursor).toBe(1);
  });

  it('returns the SAME state object at the left edge, so React bails out', () => {
    // The old code guarded with `if (cursor > 0)` and skipped the setStates
    // entirely; identity is what reproduces that.
    const before = state({ buffer: 'abc', cursor: 0 });
    expect(editorReducer(before, { type: 'backspace' })).toBe(before);
  });
});

describe('editorReducer — moveCursor', () => {
  it('moves the caret without touching the draft flags', () => {
    // NOT AN EDIT. Clearing `historyIndex` here would end a history walk the
    // moment the user pressed the left arrow to look at what they recalled.
    const before = state({ buffer: 'recalled', cursor: 8, historyIndex: 3, dismissed: true });
    const next = editorReducer(before, { type: 'moveCursor', cursor: 4 });
    expect(next.cursor).toBe(4);
    expect(next.historyIndex).toBe(3);
    expect(next.dismissed).toBe(true);
  });

  it('returns the same object for a no-op move', () => {
    const before = state({ cursor: 2 });
    expect(editorReducer(before, { type: 'moveCursor', cursor: 2 })).toBe(before);
  });
});

describe('editorReducer — recall (both edges)', () => {
  it('sets buffer, cursor and historyIndex together', () => {
    const next = editorReducer(state(), {
      type: 'recall',
      buffer: 'previous prompt',
      cursor: 15,
      historyIndex: 4,
    });
    expect(next.buffer).toBe('previous prompt');
    expect(next.cursor).toBe(15);
    expect(next.historyIndex).toBe(4);
  });

  it('ends the walk with historyIndex null and an empty buffer', () => {
    const next = editorReducer(state({ buffer: 'old', cursor: 3, historyIndex: 9 }), {
      type: 'recall',
      buffer: '',
      cursor: 0,
      historyIndex: null,
    });
    expect(next.buffer).toBe('');
    expect(next.historyIndex).toBeNull();
  });

  it('leaves dismissed and sel alone (K-7 — the old code did not touch them)', () => {
    const next = editorReducer(state({ dismissed: true, sel: 3 }), {
      type: 'recall',
      buffer: 'a',
      cursor: 1,
      historyIndex: 0,
    });
    expect(next.dismissed).toBe(true);
    expect(next.sel).toBe(3);
  });
});

describe('editorReducer — popup actions', () => {
  it('select moves only the highlight', () => {
    const next = editorReducer(state({ buffer: '/h', cursor: 2 }), { type: 'select', sel: 2 });
    expect(next.sel).toBe(2);
    expect(next.buffer).toBe('/h');
  });

  it('dismiss sets the flag once and then returns the same object', () => {
    const dismissed = editorReducer(state(), { type: 'dismiss' });
    expect(dismissed.dismissed).toBe(true);
    expect(editorReducer(dismissed, { type: 'dismiss' })).toBe(dismissed);
  });
});

describe('editorReducer — clear', () => {
  it('returns the initial state after a submit', () => {
    const next = editorReducer(
      state({ buffer: 'sent', cursor: 4, historyIndex: 1, dismissed: true, sel: 2 }),
      { type: 'clear' },
    );
    expect(next).toEqual(INITIAL_EDITOR_STATE);
  });
});

/**
 * Paste segments and token-atomic editing (tui-paste-handling section 5.3).
 *
 * Every case below is about a payload SURVIVING or being RELEASED at the right
 * moment. Both failures are silent: a leaked payload is invisible until the
 * session runs out of memory, and a released-too-early one makes the user send
 * the LABEL instead of the 218 lines it stood for.
 */
describe('editorReducer — the input action (section 5.3)', () => {
  const seg = (text: string, id?: number): InputSegment =>
    id === undefined ? { kind: 'text', text } : { kind: 'paste', text, id };

  const big = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');

  it('collapses a large paste to a token and keeps its payload', () => {
    const next = editorReducer(state(), { type: 'input', segments: [seg(big, 1)] });
    expect(next.buffer).toBe('[Pasted text #1 +15 lines]');
    expect(next.pastes.get(1)?.text).toBe(big);
  });

  it('inserts a SMALL paste verbatim and creates no token at all (G3)', () => {
    const next = editorReducer(state(), { type: 'input', segments: [seg('a\nb\nc', 2)] });
    expect(next.buffer).toBe('a\nb\nc');
    expect(next.pastes.size).toBe(0);
  });

  it('applies mixed runs IN ORDER, in ONE dispatch (I-6)', () => {
    const next = editorReducer(state({ buffer: 'x', cursor: 1 }), {
      type: 'input',
      segments: [seg('pre '), seg(big, 3), seg(' post')],
    });
    expect(next.buffer).toBe('xpre [Pasted text #3 +15 lines] post');
    expect(next.cursor).toBe(next.buffer.length);
  });

  it('resets the draft flags, exactly as every other buffer-changing action does', () => {
    const next = editorReducer(state({ historyIndex: 2, dismissed: true, sel: 4 }), {
      type: 'input',
      segments: [seg('hi')],
    });
    expect(next.historyIndex).toBeNull();
    expect(next.dismissed).toBe(false);
    expect(next.sel).toBe(0);
  });

  it('snaps a caret out of a token before inserting (D-8 / G5)', () => {
    const withToken = editorReducer(state(), { type: 'input', segments: [seg(big, 4)] });
    const inside = { ...withToken, cursor: 3 };
    const next = editorReducer(inside, { type: 'input', segments: [seg('Z')] });
    // Typing landed at an EDGE, never inside the label.
    expect(next.buffer.startsWith('Z[Pasted text #4')).toBe(true);
  });
});

describe('editorReducer — token-atomic deletion (T-27 / G5)', () => {
  const big = Array.from({ length: 15 }, (_, i) => `line ${i}`).join('\n');
  const withToken = (): EditorState =>
    editorReducer(state(), {
      type: 'input',
      segments: [{ kind: 'paste', text: big, id: 9 }],
    });

  it('removes the whole token, and its payload, in ONE backspace', () => {
    const before = withToken();
    expect(before.pastes.size).toBe(1);
    const next = editorReducer(before, { type: 'backspace' });
    expect(next.buffer).toBe('');
    expect(next.pastes.size).toBe(0);
  });

  it('releases the payload when `replace` deletes the token (I-7 / P1-6)', () => {
    // `replace` is the action behind Ctrl+U / Ctrl+K / Ctrl+W and every
    // `applyEdit`. Pruning only inside `input` — the shape v1 of the design had —
    // leaves all of them able to drop a token without releasing anything.
    const next = editorReducer(withToken(), { type: 'replace', buffer: '', cursor: 0 });
    expect(next.pastes.size).toBe(0);
  });

  it('releases the payload when `recall` replaces the draft', () => {
    const next = editorReducer(withToken(), {
      type: 'recall',
      buffer: 'older prompt',
      cursor: 12,
      historyIndex: 0,
    });
    expect(next.pastes.size).toBe(0);
  });

  it('KEEPS the payload while the token is still referenced', () => {
    const next = editorReducer(withToken(), { type: 'insert', text: ' explain' });
    expect(next.pastes.get(9)?.text).toBe(big);
  });

  it('prunes by MEMBERSHIP, not by count (I-7)', () => {
    // REGRESSION. `withPrune` used to skip the walk whenever
    // `referencedIds(buffer).size === pastes.size`, but equal counts do not
    // mean equal sets: `referencedIds` reads the BUFFER, which can name an id
    // the map never held. One hand-typed label balances out the deleted real
    // one, the cheap check returns early, and the payload outlives every
    // reference to it -- the exact leak I-7 forbids.
    const before = withToken();
    const next = editorReducer(before, {
      type: 'replace',
      buffer: '[Pasted text #77 +4 lines]',
      cursor: 26,
    });
    expect(next.pastes.has(9)).toBe(false);
  });

  it('`clear` empties the map, so submitting releases everything', () => {
    expect(editorReducer(withToken(), { type: 'clear' }).pastes.size).toBe(0);
  });

  it('leaves an ordinary backspace byte-for-byte as it was', () => {
    const next = editorReducer(state({ buffer: 'abc', cursor: 3 }), { type: 'backspace' });
    expect(next.buffer).toBe('ab');
    expect(next.cursor).toBe(2);
  });
});
