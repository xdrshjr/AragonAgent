/**
 * The prompt picker (quick-prompt-library §4.5 / AC-15 / AC-21 / AC-22 / AC-23 / AC-38).
 *
 * `Ctrl+Enter` IS DRIVEN AS THE FRAME BYTE the stdin filter actually produces
 * (`ENTER_NEWLINE_FRAME`), not as `key.ctrl && key.return`. That distinction is the whole
 * of D-23: a picker written the second way looks implemented and never sends anything.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { PromptPicker } from '../ui/overlays/PromptPicker.js';
import { NO_PROMPTS_HINT, pickerDigitTarget, pickerHint } from '../ui/overlays/prompt-picker-state.js';
import { ENTER_NEWLINE_FRAME } from '../input/limits.js';
import { getTheme } from '../ui/theme.js';
import { createTerminalHarness, settleTerminal } from '../testing/terminal-harness.js';
import type { PromptLibrary } from '../model/prompts/types.js';

const caps = { unicode: true, colorLevel: 0 } as const;
const theme = getTheme('cool', caps);

function library(titles: string[] = ['Clean code review', 'Fix lint', 'Write changelog']): PromptLibrary {
  return {
    schema: 1,
    updatedAt: 0,
    prompts: titles.map((title, at) => ({
      id: `id-${at}`, title, content: `${title} body`, useCount: at,
      createdAt: 0, updatedAt: 0,
    })),
  };
}

function mountPicker(lib: PromptLibrary = library()) {
  const onFill = vi.fn();
  const onManage = vi.fn();
  const onClose = vi.fn();
  const terminal = createTerminalHarness(100, 24);
  terminal.mount(
    <PromptPicker
      isActive
      library={lib}
      cols={100}
      maxRows={24}
      scrollOffset={0}
      theme={theme}
      caps={caps}
      onFill={onFill}
      onManage={onManage}
      onClose={onClose}
    />,
  );
  return { terminal, onFill, onManage, onClose };
}

describe('the list and its footer', () => {
  it('numbers the rows and names the always-available path first (§9.11)', async () => {
    const { terminal } = mountPicker();
    await settleTerminal();
    const frame = terminal.layoutFrames.at(-1) ?? '';
    expect(frame).toContain('1. Clean code review');
    expect(frame).toContain('2. Fix lint');
    expect(frame).toContain('Enter fill');
    expect(frame.indexOf('Enter fill')).toBeLessThan(frame.indexOf('^Enter fill & send'));
    expect(frame).toContain('Esc close');
  });

  it('closes on Esc', async () => {
    const { terminal, onClose } = mountPicker();
    await settleTerminal();
    terminal.input('\x1b');
    await settleTerminal();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('filtering and choosing', () => {
  it('filters as the user types (AC-15)', async () => {
    const { terminal } = mountPicker();
    await settleTerminal();
    terminal.input('lint');
    await settleTerminal();
    const frame = terminal.layoutFrames.at(-1) ?? '';
    expect(frame).toContain('Fix lint');
    expect(frame).not.toContain('Clean code review');
  });

  it('fills the draft on Enter without sending (AC-15 / AC-16)', async () => {
    const { terminal, onFill } = mountPicker();
    await settleTerminal();
    terminal.input('\r');
    await settleTerminal();
    expect(onFill).toHaveBeenCalledWith('id-0', false);
  });

  it('fills AND sends on the Ctrl+Enter frame byte (AC-38)', async () => {
    const { terminal, onFill } = mountPicker();
    await settleTerminal();
    terminal.input(ENTER_NEWLINE_FRAME);
    await settleTerminal();
    expect(onFill).toHaveBeenCalledWith('id-0', true);
  });

  it('picks the third row with `3` while the query is empty (AC-21)', async () => {
    const { terminal, onFill } = mountPicker();
    await settleTerminal();
    terminal.input('3');
    await settleTerminal();
    expect(onFill).toHaveBeenCalledWith('id-2', false);
  });

  it('types `3` into the query once the query is not empty (AC-21)', async () => {
    const { terminal, onFill } = mountPicker();
    await settleTerminal();
    terminal.input('a');
    await settleTerminal();
    terminal.input('3');
    await settleTerminal();
    expect(onFill).not.toHaveBeenCalled();
    expect(terminal.layoutFrames.at(-1) ?? '').toContain('a3');
  });

  it('moves the selection with the arrow keys', async () => {
    const { terminal, onFill } = mountPicker();
    await settleTerminal();
    terminal.input('\x1b[B');
    await settleTerminal();
    terminal.input('\r');
    await settleTerminal();
    expect(onFill).toHaveBeenCalledWith('id-1', false);
  });
});

describe('the view switch (AC-22)', () => {
  it('cycles manual -> recent -> favorite in the footer', async () => {
    const { terminal } = mountPicker();
    await settleTerminal();
    expect(terminal.layoutFrames.at(-1) ?? '').toContain('sort: manual');
    terminal.input('\x13');
    await settleTerminal();
    expect(terminal.layoutFrames.at(-1) ?? '').toContain('sort: recent');
    terminal.input('\x13');
    await settleTerminal();
    expect(terminal.layoutFrames.at(-1) ?? '').toContain('sort: favorite');
    terminal.input('\x13');
    await settleTerminal();
    expect(terminal.layoutFrames.at(-1) ?? '').toContain('sort: manual');
  });
});

describe('handing over to the manager (AC-23)', () => {
  it('`Tab` asks for the list page and does not close the stack', async () => {
    const { terminal, onManage, onClose } = mountPicker();
    await settleTerminal();
    terminal.input('\t');
    await settleTerminal();
    expect(onManage).toHaveBeenCalledWith({ kind: 'list' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('`Tab` on an empty library asks for the editor instead', async () => {
    const { terminal, onManage } = mountPicker(library([]));
    await settleTerminal();
    terminal.input('\t');
    await settleTerminal();
    expect(onManage).toHaveBeenCalledWith({ kind: 'create' });
  });

  it('an empty library explains both ways to create one', async () => {
    const { terminal } = mountPicker(library([]));
    await settleTerminal();
    const frame = terminal.layoutFrames.at(-1) ?? '';
    expect(frame).toContain('No prompts yet.');
    expect(frame).toContain('Ctrl+P');
  });
});

describe('the pure view model', () => {
  it('never treats a digit as a shortcut while a query is active', () => {
    expect(pickerDigitTarget([{ id: 'a', index: 1, title: 'A', tags: [], favorite: false }], '1'))
      .toBe('a');
    expect(pickerDigitTarget([], '1')).toBeNull();
    expect(pickerDigitTarget([{ id: 'a', index: 1, title: 'A', tags: [], favorite: false }], '0'))
      .toBeNull();
  });

  it('names the exit in every footer variant', () => {
    expect(pickerHint({ count: 0, query: '', view: 'manual' })).toContain(NO_PROMPTS_HINT);
    expect(pickerHint({ count: 0, query: 'zzz', view: 'manual' })).toContain('Esc close');
    expect(pickerHint({ count: 3, query: '', view: 'manual' })).toContain('Esc close');
    expect(pickerHint({ count: 3, query: '', view: 'favorite' })).toContain('favorite');
  });
});
