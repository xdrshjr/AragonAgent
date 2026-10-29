/**
 * The fill intent inside the composer's single transaction (quick-prompt-library P0-1 /
 * §4.6 / AC-37 / AC-40).
 *
 * THE FOUR ASSERTIONS BELOW ARE THE WHOLE POINT OF THE DESIGN CHANGE:
 *   1. a fill lands in `nextEditor`, before any submission side effect;
 *   2. `submit: true` produces the SAME `submission` a manual Enter would, token
 *      expansion included;
 *   3. a REFUSED submission leaves the FILLED text in `rejectedEditor` - v1 dispatched
 *      `clear` here and lost the prompt the user had just chosen;
 *   4. a fill never becomes a paste token, so an eight-line body stays eight lines.
 */

import { describe, expect, it } from 'vitest';
import { planComposerInput, type ComposerInputIntent } from '../ui/composer-input.js';
import { INITIAL_EDITOR_STATE, editorReducer, type EditorState } from '../ui/editor-reducer.js';
import { expandPastes } from '../ui/paste-tokens.js';

const BODY = 'line 1\nline 2\nline 3';

function plan(intents: ComposerInputIntent[], editor: EditorState = INITIAL_EDITOR_STATE) {
  return planComposerInput({
    editor,
    intents,
    resolveSubmit: (state) => (state.buffer.trim().length > 0
      ? expandPastes(state.buffer, state.pastes) : null),
    checkPasteLimit: () => null,
  });
}

describe('planComposerInput: the fill intent', () => {
  it('fills the draft without submitting (AC-16)', () => {
    const result = plan([{ kind: 'fill', text: BODY, mode: 'insert', submit: false }]);
    expect(result.nextEditor.buffer).toBe(BODY);
    expect(result.rejectedEditor.buffer).toBe(BODY);
    expect(result.submission).toBeUndefined();
  });

  it('fills and submits in one transaction, through the ONE submit path (AC-20)', () => {
    const result = plan([{ kind: 'fill', text: BODY, mode: 'insert', submit: true }]);
    expect(result.submission).toBe(BODY);
    // The accepted draft is cleared exactly as a manual Enter clears it.
    expect(result.nextEditor.buffer).toBe('');
  });

  it('keeps the FILLED text in the rejected draft when the host refuses (AC-37)', () => {
    const result = plan([{ kind: 'fill', text: BODY, mode: 'insert', submit: true }]);
    // This is the assertion that fails if the planner ever applies the fill only to
    // `nextEditor`: `rejectedEditor` is what `transact` adopts on `accepted: false`.
    expect(result.rejectedEditor.buffer).toBe(BODY);
    expect(result.rejectedEditor.buffer.trim().length).toBeGreaterThan(0);
  });

  it('inserts into an existing draft and keeps it (AC-18)', () => {
    const editor = editorReducer(INITIAL_EDITOR_STATE, { type: 'insert', text: 'mine' });
    const result = plan([{ kind: 'fill', text: BODY, mode: 'insert', submit: false }], editor);
    expect(result.nextEditor.buffer).toBe(`mine\n\n${BODY}`);
  });

  it('overwrites when prompt.insertMode is replace (AC-19)', () => {
    const editor = editorReducer(INITIAL_EDITOR_STATE, { type: 'insert', text: 'mine' });
    const result = plan([{ kind: 'fill', text: BODY, mode: 'replace', submit: false }], editor);
    expect(result.nextEditor.buffer).toBe(BODY);
  });

  it('does not collapse an eight-line body into a paste token (AC-17)', () => {
    const eight = Array.from({ length: 8 }, (_unused, at) => `row ${at}`).join('\n');
    const result = plan([{ kind: 'fill', text: eight, mode: 'insert', submit: false }]);
    expect(result.nextEditor.buffer).toBe(eight);
    expect(result.nextEditor.buffer).not.toContain('[Pasted text');
    expect(result.nextEditor.pastes.size).toBe(0);
  });

  it('expands an existing paste token when the filled draft is submitted (AC-40)', () => {
    const withToken = planComposerInput({
      editor: INITIAL_EDITOR_STATE,
      intents: [{ kind: 'paste', text: 'a\nb\nc\nd\ne\nf\ng\nh', id: 1 }],
      resolveSubmit: () => null,
      checkPasteLimit: () => null,
    }).nextEditor;
    expect(withToken.buffer).toContain('[Pasted text');
    const result = plan([{ kind: 'fill', text: 'tail', mode: 'insert', submit: true }], withToken);
    // The token is restored on submit, and the fill did not land INSIDE it.
    expect(result.submission).toContain('a\nb\nc');
    expect(result.submission).toContain('tail');
    expect(result.submission).not.toContain('[Pasted text');
  });

  it('treats a fill + a later submit intent as fill-then-send', () => {
    const result = plan([
      { kind: 'fill', text: BODY, mode: 'insert', submit: false },
      { kind: 'submit' },
    ]);
    expect(result.submission).toBe(BODY);
  });
});
