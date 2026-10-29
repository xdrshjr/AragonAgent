import { describe, expect, it } from 'vitest';
import { applyMention, detectMention, detectSlash, insertAt, stepIndex } from '../chat-triggers.js';

describe('composer triggers', () => {
  it('opens the slash menu only for a leading / with no space typed yet', () => {
    expect(detectSlash('/cl', 3)).toEqual({ start: 0, query: 'cl' });
    expect(detectSlash('/clear now', 10)).toBeNull();
    expect(detectSlash('hello /x', 8)).toBeNull();
    expect(detectSlash('', 0)).toBeNull();
  });

  it('detects @ at a word start, and not inside an email address', () => {
    expect(detectMention('look at @src/a', 14)).toEqual({ start: 8, query: 'src/a' });
    expect(detectMention('@x', 2)).toEqual({ start: 0, query: 'x' });
    expect(detectMention('mail me@host.com', 16)).toBeNull();
    expect(detectMention('@done and more', 14)).toBeNull();
  });

  it('replaces the trigger and its query with the picked path', () => {
    const edit = applyMention('see @sr please', { start: 4, query: 'sr' }, 7, 'src/app.ts');
    expect(edit.text).toBe('see src/app.ts  please');
    expect(edit.caret).toBe('see src/app.ts '.length);
  });

  it('inserts text at the caret', () => {
    expect(insertAt('abcd', 2, 'XY')).toEqual({ text: 'abXYcd', caret: 4 });
  });

  it('wraps menu navigation in both directions', () => {
    expect(stepIndex(0, -1, 3)).toBe(2);
    expect(stepIndex(2, 1, 3)).toBe(0);
    expect(stepIndex(0, 1, 0)).toBe(0);
  });
});
