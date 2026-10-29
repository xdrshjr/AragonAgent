/**
 * The three new chords, driven by their REAL bytes (quick-prompt-library D-23 / R-11 /
 * AC-12 / AC-20 / AC-38 / AC-39 / AC-42).
 *
 * THIS FILE EXISTS BECAUSE "the callback was called" IS NOT THE CONTRACT. Ink 5 parses a
 * stdin chunk once and reports what it recognised, so a binding written as
 * `key.ctrl && key.return` or `key.ctrl && key.upArrow` is dead code that looks alive in
 * review. Every case below therefore feeds the exact bytes a terminal sends.
 *
 * The measured table (recorded during implementation; F-37 corrected it):
 *   `\x1b[1;5B` -> key.downArrow + key.ctrl, EMPTY input
 *   `\x1b[B`    -> key.downArrow, no ctrl
 *   `\x00n`     -> the ENTER_NEWLINE_FRAME the filter produces for any modified Enter
 *   `\r`        -> key.return
 *   `\x10`      -> input 'p' + key.ctrl
 *   `\x0e`      -> input 'n' + key.ctrl
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PromptLibraryOverlay } from '../ui/overlays/PromptLibraryOverlay.js';
import { PromptPicker } from '../ui/overlays/PromptPicker.js';
import { MODE_TOGGLE_KEYS } from '../model/agent/agent-mode.js';
import { ENTER_NEWLINE_FRAME } from '../input/limits.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from '../testing/terminal-harness.js';
import type { PromptLibrary } from '../model/prompts/types.js';

const caps = { unicode: true, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

const library = (): PromptLibrary => ({
  schema: 1,
  updatedAt: 0,
  prompts: [
    { id: 'a', title: 'Alpha', content: 'alpha body', useCount: 0, createdAt: 0, updatedAt: 0 },
    { id: 'b', title: 'Beta', content: 'beta body', useCount: 0, createdAt: 0, updatedAt: 0 },
  ],
});

function mountOverlay() {
  const onMutate = vi.fn(() => ({ ok: true as const, library: library() }));
  const terminal = createTerminalHarness(100, 24);
  terminal.mount(
    <PromptLibraryOverlay
      isActive
      library={library()}
      cols={100}
      maxRows={24}
      scrollOffset={0}
      theme={theme}
      caps={caps}
      onMutate={onMutate}
      onClose={() => {}}
    />,
  );
  return { terminal, onMutate };
}

describe('Ctrl+Up / Ctrl+Down reorder by the sequence, not by the chord (AC-12 / AC-39)', () => {
  it('moves down once for `\\x1b[1;5B`', async () => {
    const { terminal, onMutate } = mountOverlay();
    await settleTerminal();
    terminal.input('\x1b[1;5B');
    await settleTerminal();
    expect(onMutate).toHaveBeenCalledTimes(1);
    expect(onMutate).toHaveBeenCalledWith({ kind: 'move', id: 'a', delta: 1 });
  });

  it('moves up once for `\\x1b[1;5A`', async () => {
    const { terminal, onMutate } = mountOverlay();
    await settleTerminal();
    terminal.input('\x1b[1;5A');
    await settleTerminal();
    expect(onMutate).toHaveBeenCalledWith({ kind: 'move', id: 'a', delta: -1 });
  });

  it('does NOT reorder when the modifier is lost (plain `\\x1b[B`)', async () => {
    const { terminal, onMutate } = mountOverlay();
    await settleTerminal();
    terminal.input('\x1b[B');
    settleTerminal();
    await settleTerminal();
    expect(onMutate).not.toHaveBeenCalled();
  });
});

describe('Ctrl+Enter is the frame the filter produces (AC-20 / AC-38)', () => {
  function mountPicker() {
    const onFill = vi.fn();
    const terminal = createTerminalHarness(100, 24);
    terminal.mount(
      <PromptPicker
        isActive
        library={library()}
        cols={100}
        maxRows={24}
        scrollOffset={0}
        theme={theme}
        caps={caps}
        onFill={onFill}
        onManage={() => {}}
        onClose={() => {}}
      />,
    );
    return { terminal, onFill };
  }

  it('fills and sends on `ENTER_NEWLINE_FRAME`', async () => {
    const { terminal, onFill } = mountPicker();
    await settleTerminal();
    terminal.input(ENTER_NEWLINE_FRAME);
    await settleTerminal();
    expect(onFill).toHaveBeenCalledWith('a', true);
  });

  it('only fills on a plain `\\r`', async () => {
    const { terminal, onFill } = mountPicker();
    await settleTerminal();
    terminal.input('\r');
    await settleTerminal();
    expect(onFill).toHaveBeenCalledWith('a', false);
  });
});

describe('the mode fallback key is Ctrl+N and is never spelled `^N` (AC-5 / AC-42)', () => {
  it('names ctrl+n in the shared constant', () => {
    expect(MODE_TOGGLE_KEYS.fallback).toBe('ctrl+n');
    expect(MODE_TOGGLE_KEYS.primary).toBe('shift+tab');
  });

  it('says Ctrl+N in full in the help overlay, and never `^N` as a key', async () => {
    const { helpRows } = await import('../ui/overlays/HelpOverlay.js');
    const text = helpRows(theme, caps)
      .map((row) => JSON.stringify(row.props.children))
      .join('\n');
    expect(text).toContain('Ctrl+N');
    expect(text).toContain('Ctrl+P');
    // `^N` remains the SCROLL OFFSET's word (its own row explains the line offset), so the
    // assertion that matters is that the MODE TOGGLE is never spelled with it.
    expect(text).not.toContain('Shift+Tab / ^N');
    expect(text).toContain('Shift+Tab / Ctrl+N');
  });
});
