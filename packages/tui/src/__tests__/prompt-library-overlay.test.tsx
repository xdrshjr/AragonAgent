/**
 * The prompt manager overlay (quick-prompt-library §4.4 / AC-1 / AC-12 / AC-13 / AC-14 /
 * AC-35).
 *
 * THE INTENT IS THE INTERESTING PART. `/prompts edit 2` has to land on row 2's editor,
 * and a replayed intent must not open it twice - the two failures a state machine gets
 * wrong and a screenshot never shows. Both are asserted here: one through the reducer,
 * one through a real mount.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryOverlay } from '../ui/overlays/PromptLibraryOverlay.js';
import {
  INITIAL_PROMPT_LIBRARY_STATE,
  libraryRows,
  promptLibraryReducer,
  type PromptLibraryState,
} from '../ui/overlays/prompt-library-state.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from '../testing/terminal-harness.js';
import type { PromptLibrary, PromptMutationResult } from '../model/prompts/types.js';

const caps = { unicode: true, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

function library(titles: string[] = ['Clean code review', 'Fix lint']): PromptLibrary {
  return {
    schema: 1,
    updatedAt: 0,
    prompts: titles.map((title, at) => ({
      id: `id-${at}`, title, content: `${title} body\nsecond line`, useCount: at,
      createdAt: 0, updatedAt: 0,
    })),
  };
}

const ok = (next: PromptLibrary): PromptMutationResult => ({ ok: true, library: next });

function mountOverlay(overrides: Partial<React.ComponentProps<typeof PromptLibraryOverlay>> = {}) {
  const onMutate = vi.fn((action: { kind: string }) =>
    ok(overrides.library ?? library()));
  const onClose = vi.fn();
  const props = {
    isActive: true,
    library: library(),
    cols: 100,
    maxRows: 24,
    scrollOffset: 0,
    theme,
    caps,
    onMutate,
    onClose,
    ...overrides,
  } as React.ComponentProps<typeof PromptLibraryOverlay>;
  const terminal = createTerminalHarness(100, 24);
  terminal.mount(<PromptLibraryOverlay {...props} />);
  return { terminal, onMutate, onClose, props };
}

describe('the list page', () => {
  it('renders the title, every row and the footer that explains how to leave', async () => {
    const { terminal } = mountOverlay();
    await settleTerminal();
    // `layoutFrames` keeps the last COMPLETE layout write; the very first `data` event of
    // a mount can be cursor bookkeeping with no content in it.
    const frame = terminal.layoutFrames.at(-1) ?? '';
    expect(frame).toContain('Prompts (2)');
    expect(frame).toContain('Clean code review');
    expect(frame).toContain('Fix lint');
    expect(frame).toContain('Esc close');
  });

  it('renders the two-line empty state instead of a blank screen', async () => {
    const { terminal } = mountOverlay({ library: library([]) });
    await settleTerminal();
    const frame = terminal.layoutFrames.at(-1) ?? '';
    expect(frame).toContain('No prompts yet.');
    expect(frame).toContain('Press a to create your first prompt.');
  });

  it('closes on Esc', async () => {
    const { terminal, onClose } = mountOverlay();
    await settleTerminal();
    terminal.input('\x1b');
    await settleTerminal();
    expect(onClose).toHaveBeenCalled();
  });

  it('opens the editor with `a`', async () => {
    const { terminal } = mountOverlay();
    await settleTerminal();
    terminal.input('a');
    await settleTerminal();
    expect(terminal.lastFrame()).toContain('New prompt');
    expect(terminal.lastFrame()).toContain('Save');
  });

  it('opens the editor on Enter, prefilled', async () => {
    const { terminal } = mountOverlay();
    await settleTerminal();
    terminal.input('\r');
    await settleTerminal();
    const frame = terminal.lastFrame();
    expect(frame).toContain('Edit prompt');
    expect(frame).toContain('Clean code review');
  });

  it('toggles the favourite of the focused row with `f` (AC-14)', async () => {
    const { terminal, onMutate } = mountOverlay();
    await settleTerminal();
    terminal.input('f');
    await settleTerminal();
    expect(onMutate).toHaveBeenCalledWith({ kind: 'favorite', id: 'id-0', favorite: true });
  });

  it('deletes through the confirmation page, and `n` cancels (AC-13)', async () => {
    const { terminal, onMutate } = mountOverlay();
    await settleTerminal();
    terminal.input('d');
    await settleTerminal();
    expect(terminal.lastFrame()).toContain('Delete prompt');
    expect(terminal.lastFrame()).toContain('cannot be undone');
    terminal.input('n');
    await settleTerminal();
    expect(onMutate).not.toHaveBeenCalled();
    terminal.input('d');
    await settleTerminal();
    terminal.input('y');
    await settleTerminal();
    expect(onMutate).toHaveBeenCalledWith({ kind: 'delete', id: 'id-0' });
  });
});

describe('the reorder keys arrive as BYTES (AC-12 / AC-39, D-23)', () => {
  it('moves the focused row on the real Ctrl+Down sequence', async () => {
    const { terminal, onMutate } = mountOverlay();
    await settleTerminal();
    // `\x1b[1;5B` is what a terminal sends for Ctrl+Down; Ink reports it as
    // `ctrl + downArrow` with an empty `input`, so the handler accepts either shape.
    terminal.input('\x1b[1;5B');
    await settleTerminal();
    expect(onMutate).toHaveBeenCalledWith({ kind: 'move', id: 'id-0', delta: 1 });
  });

  it('only moves the FOCUS on a plain Down arrow', async () => {
    const { terminal, onMutate } = mountOverlay();
    await settleTerminal();
    terminal.input('\x1b[B');
    await settleTerminal();
    expect(onMutate).not.toHaveBeenCalled();
  });
});

describe('D-21 / I-8: the intent is consumed exactly once', () => {
  const reducerState = (nonce: number): PromptLibraryState =>
    promptLibraryReducer(
      INITIAL_PROMPT_LIBRARY_STATE,
      { type: 'init', entry: { kind: 'create' }, library: library(), nonce },
      library(),
    );

  it('sends an edit intent straight to the editor with its draft', () => {
    const state = promptLibraryReducer(
      INITIAL_PROMPT_LIBRARY_STATE,
      { type: 'init', entry: { kind: 'edit', id: 'id-1' }, library: library(), nonce: 1 },
      library(),
    );
    expect(state.page).toBe('editor');
    expect(state.draft.title).toBe('Fix lint');
    expect(state.draft.id).toBe('id-1');
  });

  it('ignores a repeated nonce', () => {
    const first = reducerState(3);
    const again = promptLibraryReducer(
      first,
      { type: 'init', entry: { kind: 'create' }, library: library(), nonce: 3 },
      library(),
    );
    expect(again).toBe(first);
  });

  it('lands on the delete page for a delete intent', () => {
    const state = promptLibraryReducer(
      INITIAL_PROMPT_LIBRARY_STATE,
      { type: 'init', entry: { kind: 'delete', id: 'id-0' }, library: library(), nonce: 2 },
      library(),
    );
    expect(state.page).toBe('delete');
    expect(state.pendingDeleteId).toBe('id-0');
  });

  it('walks back to the list when the referenced entry is gone', () => {
    const state = promptLibraryReducer(
      INITIAL_PROMPT_LIBRARY_STATE,
      { type: 'init', entry: { kind: 'edit', id: 'missing' }, library: library(), nonce: 1 },
      library(),
    );
    expect(state.page).toBe('list');
  });
});

describe('the two-step Esc on a dirty draft', () => {
  const dirty = (): PromptLibraryState => promptLibraryReducer(
    INITIAL_PROMPT_LIBRARY_STATE,
    { type: 'init', entry: { kind: 'create' }, library: library(), nonce: 1 },
    library(),
  );

  it('arms on the first Esc and discards on the second', () => {
    const typed = promptLibraryReducer(dirty(), { type: 'draft', patch: { title: 'x' } }, library());
    const armed = promptLibraryReducer(typed, { type: 'esc' }, library());
    expect(armed.page).toBe('editor');
    expect(armed.escArmed).toBe(true);
    const discarded = promptLibraryReducer(armed, { type: 'esc' }, library());
    expect(discarded.page).toBe('list');
    expect(discarded.draft.title).toBe('');
  });

  it('closes immediately when nothing was typed', () => {
    const closed = promptLibraryReducer(dirty(), { type: 'esc' }, library());
    expect(closed.page).toBe('list');
  });

  it('takes TWO real Esc presses to discard, because one keypress is one Esc', async () => {
    // THIS IS A MOUNTED CASE ON PURPOSE. The manager and the editor page are two live
    // `useInput` subscribers, and a handler on both of them dispatches `esc` TWICE for
    // one keypress - the first arms the discard and the second executes it, so a single
    // Esc used to throw away a drafted body with no prompt. A reducer test cannot see
    // that, because the reducer is correct; the double dispatch is.
    const { terminal } = mountOverlay();
    await settleTerminal();
    terminal.input('a');
    await settleTerminal();
    terminal.input('x');
    await settleTerminal();
    expect(terminal.lastFrame()).toContain('New prompt');

    terminal.input('\x1b');
    await settleTerminal();
    expect(terminal.lastFrame()).toContain('New prompt');
    expect(terminal.lastFrame()).toContain('Esc again discards');

    terminal.input('\x1b');
    await settleTerminal();
    expect(terminal.lastFrame()).toContain('Prompts (2)');
  });
});

describe('libraryRows', () => {
  it('prefixes duplicate titles with an id fragment (I-2)', () => {
    const rows = libraryRows(library(['Same', 'Same']));
    expect(rows[0]!.label.startsWith('#')).toBe(true);
    expect(rows[1]!.label.startsWith('#')).toBe(true);
    expect(rows[0]!.label).not.toBe(rows[1]!.label);
  });

  it('carries machine-checkable markers, not just text', () => {
    const rows = libraryRows({
      schema: 1, updatedAt: 0,
      prompts: [{
        id: 'x', title: 'T', content: 'body', tags: ['a', 'b'], favorite: true,
        useCount: 4, createdAt: 0, updatedAt: 0,
      }],
    });
    expect(rows[0]!.markers).toEqual({ favorite: true, hasTags: true, uses: 4 });
  });
});
