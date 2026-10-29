/**
 * The editor page (quick-prompt-library §4.4 / D-11 / D-12 / AC-8 / AC-41 of the spec's
 * test table).
 *
 * THE SECOND SAVE PATH IS THE ASSERTION THAT MATTERS. `Ctrl+S` is the fast path, and it
 * is a byte a terminal can swallow (XON/XOFF), so `Tab` to `Save` + `Enter` must do the
 * same thing. A page where only the accelerator works is a page a whole class of
 * terminals cannot save from.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PromptEditorPage } from '../ui/overlays/PromptEditorPage.js';
import { EMPTY_PROMPT_DRAFT, type PromptLibraryState } from '../ui/overlays/prompt-library-state.js';
import { promptTextAreaReducer, EMPTY_TEXT_AREA } from '../ui/overlays/PromptTextArea.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from '../testing/terminal-harness.js';

const caps = { unicode: true, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

function editorState(over: Partial<PromptLibraryState> = {}): PromptLibraryState {
  return {
    page: 'editor',
    index: 0,
    focusId: null,
    draft: { ...EMPTY_PROMPT_DRAFT },
    baseline: null,
    escArmed: false,
    pendingDeleteId: null,
    error: null,
    errorField: null,
    consumedIntentNonce: 0,
    ...over,
  };
}

function mountEditor(over: Partial<PromptLibraryState> = {}) {
  const onSave = vi.fn();
  const onEsc = vi.fn();
  const onCancel = vi.fn();
  const onDraft = vi.fn();
  const props = {
    isActive: true,
    state: editorState(over),
    cols: 100,
    maxRows: 24,
    theme,
    caps,
    onDraft,
    onSave,
    onEsc,
    onCancel,
  };
  const terminal = createTerminalHarness(100, 24);
  terminal.mount(<PromptEditorPage {...props} />);
  return { terminal, onSave, onEsc, onCancel, onDraft, props };
}

describe('the field rows', () => {
  it('renders the four fields and both action rows', async () => {
    const { terminal } = mountEditor();
    await settleTerminal();
    const frame = terminal.layoutFrames.at(-1) ?? '';
    expect(frame).toContain('Title');
    expect(frame).toContain('Body');
    expect(frame).toContain('Note');
    expect(frame).toContain('Tags');
    expect(frame).toContain('Save');
    expect(frame).toContain('Cancel');
    expect(frame).toContain('Ctrl+S save');
  });

  it('types into the focused title field at the END of the prefilled text', async () => {
    const { terminal, onDraft } = mountEditor({
      draft: { ...EMPTY_PROMPT_DRAFT, title: 'Base' },
      baseline: { ...EMPTY_PROMPT_DRAFT, title: 'Base' },
    });
    await settleTerminal();
    terminal.input('x');
    await settleTerminal();
    expect(onDraft).toHaveBeenCalledWith({ title: 'Basex' });
  });

  it('backspaces the title', async () => {
    const { terminal, onDraft } = mountEditor({
      draft: { ...EMPTY_PROMPT_DRAFT, title: 'Base' },
    });
    await settleTerminal();
    terminal.input('\x7f');
    await settleTerminal();
    expect(onDraft).toHaveBeenCalledWith({ title: 'Bas' });
  });
});

describe('saving', () => {
  it('saves on Ctrl+S', async () => {
    const { terminal, onSave } = mountEditor();
    await settleTerminal();
    terminal.input('\x13');
    await settleTerminal();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('also saves from the Save action row: Tab to it, then Enter', async () => {
    const { terminal, onSave } = mountEditor();
    await settleTerminal();
    // Four text fields, then `Save`.
    for (let at = 0; at < 4; at += 1) {
      terminal.input('\t');
      await settleTerminal();
    }
    terminal.input('\r');
    await settleTerminal();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('shows the stable error code sentence in the title and keeps the page open', async () => {
    const { terminal } = mountEditor({ error: 'title_required' });
    await settleTerminal();
    // The copy is Chinese (it comes from `prompts/copy.ts`), so the assertion is on the
    // fact that the TITLE is no longer the neutral one, not on the glyphs themselves.
    const frame = terminal.layoutFrames.at(-1) ?? '';
    expect(frame).not.toContain('New prompt');
  });
});

describe('the body field', () => {
  it('inserts a newline rather than saving when Enter is pressed in the body', async () => {
    const { terminal, onDraft, onSave } = mountEditor();
    await settleTerminal();
    terminal.input('\t');
    await settleTerminal();
    terminal.input('\r');
    await settleTerminal();
    expect(onSave).not.toHaveBeenCalled();
    expect(onDraft).toHaveBeenCalledWith({ content: '\n' });
  });
});

describe('Escape', () => {
  it('reports Esc to the owner, which owns the two-step rule', async () => {
    const { terminal, onEsc } = mountEditor();
    await settleTerminal();
    terminal.input('\x1b');
    await settleTerminal();
    expect(onEsc).toHaveBeenCalledOnce();
  });
});

describe('PromptTextArea: the pure editing model (D-11)', () => {
  it('inserts, breaks lines, deletes and moves without losing a grapheme', () => {
    let state = promptTextAreaReducer(EMPTY_TEXT_AREA, { type: 'insert', text: 'ab' });
    expect(state).toEqual({ buffer: 'ab', cursor: 2 });
    state = promptTextAreaReducer(state, { type: 'newline' });
    expect(state).toEqual({ buffer: 'ab\n', cursor: 3 });
    state = promptTextAreaReducer(state, { type: 'backspace' });
    expect(state.buffer).toBe('ab');
    state = promptTextAreaReducer(state, { type: 'left' });
    expect(state.cursor).toBe(1);
    state = promptTextAreaReducer(state, { type: 'delete' });
    expect(state.buffer).toBe('a');
  });

  it('keeps an emoji sequence intact when stepping left', () => {
    const emoji = String.fromCodePoint(0x1f469) + String.fromCodePoint(0x200d)
      + String.fromCodePoint(0x1f4bb);
    let state = promptTextAreaReducer(EMPTY_TEXT_AREA, { type: 'insert', text: emoji });
    state = promptTextAreaReducer(state, { type: 'left' });
    expect(state.cursor).toBe(0);
  });

  it('moves vertically by visual row and stays put at the edge', () => {
    const state = promptTextAreaReducer(EMPTY_TEXT_AREA, { type: 'insert', text: 'a\nb' });
    const up = promptTextAreaReducer(state, { type: 'up', cols: 20 });
    expect(up.cursor).toBe(1);
    // Already on the first row: a vertical move must not jump to a buffer edge.
    expect(promptTextAreaReducer(up, { type: 'up', cols: 20 }).cursor).toBe(1);
  });
});
