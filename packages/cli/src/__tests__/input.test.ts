import { describe, expect, it } from 'vitest';
import { recognize } from '../input/keymap.js';
import {
  applyEdit,
  draftLimitRefusal,
  fileTokenAt,
  moveVertical,
  overflowChip,
  slashSuggestions,
} from '../ui/PromptInput.js';
import type { InputSegment } from '../ui/editor-reducer.js';
import { makePasteRecord, type PasteRecord } from '../ui/paste-tokens.js';
import { PASTE_MAX_BLOCKS } from '../input/limits.js';
import { pickGlyphs } from '../ui/glyphs.js';

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
  it('Home at the start of an empty first line never moves forward', () => {
    expect(applyEdit('\nnext', 0, 'home')).toEqual({ buffer: '\nnext', cursor: 0 });
  });
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

  it('matches kebab-case and namespaced skill commands (D16)', () => {
    // Skill names are kebab-case; the old `^\/(\w*)$` returned null for them,
    // so `/my-sk` showed no popup at all — indistinguishable, from the user's
    // side, from the command not existing.
    const withSkills = [
      ...commands,
      { name: 'my-skill', description: 'A skill' },
      { name: 'skill:my-skill', description: 'A skill' },
    ];
    expect(slashSuggestions('/my-sk', withSkills)?.map((s) => s.label)).toEqual(['/my-skill']);
    expect(slashSuggestions('/skill:', withSkills)?.map((s) => s.label)).toEqual([
      '/skill:my-skill',
    ]);
  });
});

describe('draftLimitRefusal (section 5.3 / P1-4)', () => {
  const paste = (text: string, id: number): InputSegment => ({ kind: 'paste', text, id });
  const empty = { pastes: new Map<number, PasteRecord>() };

  it('allows an ordinary paste', () => {
    expect(draftLimitRefusal([paste('hello', 1)], empty)).toBeNull();
    expect(draftLimitRefusal([{ kind: 'text', text: 'typed' }], empty)).toBeNull();
  });

  it('refuses the block past the ceiling, naming the limit', () => {
    const live = new Map<number, PasteRecord>();
    for (let i = 0; i < PASTE_MAX_BLOCKS; i += 1) live.set(i, makePasteRecord(i, 'x'));
    const refusal = draftLimitRefusal([paste('one more', 99)], { pastes: live });
    expect(refusal).toContain(String(PASTE_MAX_BLOCKS));
    expect(refusal).toContain('Nothing was inserted');
  });

  it('refuses a paste that would push the draft past the byte ceiling', () => {
    const live = new Map<number, PasteRecord>([[1, makePasteRecord(1, 'x'.repeat(8 * 1024 * 1024))]]);
    const refusal = draftLimitRefusal([paste('y'.repeat(1024), 2)], { pastes: live });
    expect(refusal).toContain('MB');
    expect(refusal).toContain('Nothing was inserted');
  });
});

describe('applyEdit — kill ranges are token-atomic (G5 / D-8)', () => {
  const buffer = 'a [Pasted text #1 +9 lines] b';

  it('Ctrl+W cannot leave half a token behind', () => {
    // A half-deleted label stops matching, so its payload is released and the
    // user sends the REMAINS OF THE LABEL instead of the nine lines. The label
    // contains spaces, so a word jump lands INSIDE it — which is exactly the
    // case `expandRangeOverTokens` exists for.
    const out = applyEdit(buffer, buffer.indexOf(']') + 1, 'deleteWordBack');
    expect(out.buffer).not.toContain('Pasted text');
    expect(out.buffer).toBe('a  b');
    expect(out.cursor).toBe(2);
  });

  it('Ctrl+U from inside the token removes the whole thing', () => {
    const out = applyEdit(buffer, buffer.indexOf(']'), 'killToStart');
    expect(out.buffer).toBe(' b');
  });

  it('Ctrl+K from before the token removes the whole thing', () => {
    const out = applyEdit(buffer, 3, 'killToEnd');
    expect(out.buffer).toBe('a ');
  });

  it('leaves a token-free buffer exactly as it was', () => {
    expect(applyEdit('foo bar', 7, 'deleteWordBack')).toEqual({ buffer: 'foo ', cursor: 4 });
  });
});

describe('overflowChip (section 5.5)', () => {
  const glyphs = pickGlyphs({ colorLevel: 3, unicode: false });

  it('is absent when the whole draft is on screen', () => {
    expect(overflowChip(0, 0, glyphs)).toBeNull();
  });

  it('names both directions and keeps a FIXED cell width', () => {
    const both = overflowChip(3, 7, glyphs)!;
    expect(both.text).toContain('3');
    expect(both.text).toContain('7');
    const one = overflowChip(0, 7, glyphs)!;
    expect(one.cells).toBe(both.cells);
  });

  it('caps the number so a long draft cannot widen the cell', () => {
    expect(overflowChip(0, 5000, glyphs)!.text).toContain('999+');
  });

  it('draws from glyphs, so a legacy console gets ASCII', () => {
    expect(overflowChip(3, 7, glyphs)!.text).not.toMatch(/[^\x00-\x7f]/);
  });
});
