import { describe, expect, it } from 'vitest';
import { recognize } from '../input/keymap.js';
import { applyEdit, moveVertical, slashSuggestions, fileTokenAt } from '../ui/PromptInput.js';

describe('recognize (keymap)', () => {
  it('maps Ctrl combos to editing intents', () => {
    expect(recognize('a', { ctrl: true })).toBe('home');
    expect(recognize('e', { ctrl: true })).toBe('end');
    expect(recognize('w', { ctrl: true })).toBe('deleteWordBack');
    expect(recognize('u', { ctrl: true })).toBe('killToStart');
    expect(recognize('k', { ctrl: true })).toBe('killToEnd');
  });

  it('maps raw Home/End and word escape sequences', () => {
    expect(recognize('\x1b[H', {})).toBe('home');
    expect(recognize('\x1b[F', {})).toBe('end');
    expect(recognize('\x1b[1;5D', {})).toBe('wordLeft');
    expect(recognize('\x1b[1;5C', {})).toBe('wordRight');
  });

  it('maps Ctrl+Arrow via key flags', () => {
    expect(recognize('', { ctrl: true, leftArrow: true })).toBe('wordLeft');
    expect(recognize('', { ctrl: true, rightArrow: true })).toBe('wordRight');
  });

  it('returns null for an unknown escape sequence so it is dropped', () => {
    expect(recognize('\x1b[15~', {})).toBeNull(); // F5
    expect(recognize('z', {})).toBeNull();
  });
});

describe('applyEdit', () => {
  it('home/end move to line boundaries', () => {
    expect(applyEdit('hello world', 6, 'home')).toEqual({ buffer: 'hello world', cursor: 0 });
    expect(applyEdit('hello world', 6, 'end')).toEqual({ buffer: 'hello world', cursor: 11 });
  });

  it('home/end respect the current line in a multiline buffer', () => {
    const buf = 'ab\ncdef';
    expect(applyEdit(buf, 5, 'home')).toEqual({ buffer: buf, cursor: 3 }); // start of 2nd line
    expect(applyEdit(buf, 4, 'end')).toEqual({ buffer: buf, cursor: 7 });
  });

  it('word jumps move by word', () => {
    expect(applyEdit('foo bar baz', 11, 'wordLeft').cursor).toBe(8);
    expect(applyEdit('foo bar baz', 0, 'wordRight').cursor).toBe(3);
  });

  it('deleteWordBack removes the previous word', () => {
    expect(applyEdit('foo bar', 7, 'deleteWordBack')).toEqual({ buffer: 'foo ', cursor: 4 });
  });

  it('kill-line trims to line start / end', () => {
    expect(applyEdit('hello world', 6, 'killToStart')).toEqual({ buffer: 'world', cursor: 0 });
    expect(applyEdit('hello world', 5, 'killToEnd')).toEqual({ buffer: 'hello', cursor: 5 });
  });
});

describe('moveVertical (multiline nav)', () => {
  const buf = 'line1\nline2\nline3';

  it('moves the cursor between lines preserving the column', () => {
    // cursor at col 3 of line 2 (index 5+3 = 9 → "lin|e2")
    const up = moveVertical(buf, 9, 'up');
    expect(up).toEqual({ cursor: 3 }); // col 3 of line 1
    const down = moveVertical(buf, 9, 'down');
    expect(down).toEqual({ cursor: 15 }); // col 3 of line 3
  });

  it('returns null at the top and bottom edges (→ history recall)', () => {
    expect(moveVertical(buf, 2, 'up')).toBeNull(); // on first line
    expect(moveVertical(buf, 14, 'down')).toBeNull(); // on last line
  });

  it('returns null for a single-line buffer', () => {
    expect(moveVertical('single', 3, 'up')).toBeNull();
    expect(moveVertical('', 0, 'down')).toBeNull();
  });
});

describe('autocomplete suggestion computation', () => {
  const commands = [
    { name: 'help', description: 'Show help' },
    { name: 'model', description: 'Model picker' },
    { name: 'theme', description: 'Switch theme' },
  ];

  it('filters slash commands by prefix, and only for a bare /word', () => {
    expect(slashSuggestions('/', commands)?.map((s) => s.label)).toEqual(['/help', '/model', '/theme']);
    expect(slashSuggestions('/m', commands)?.map((s) => s.label)).toEqual(['/model']);
    expect(slashSuggestions('/model arg', commands)).toBeNull(); // has a space
    expect(slashSuggestions('not a slash', commands)).toBeNull();
  });

  it('finds the @file token under the cursor', () => {
    expect(fileTokenAt('see @READ', 9)).toEqual({ start: 4, end: 9, query: 'READ' });
    expect(fileTokenAt('plain text', 4)).toBeNull();
  });
});
