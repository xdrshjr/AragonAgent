/**
 * The paste token vocabulary (tui-paste-handling section 5.3, T-6..T-10).
 *
 * These functions are the whole of "the placeholder is a single editable unit"
 * (G5). Every one of them fails SILENTLY when it is wrong: a half-deleted token
 * stops matching, so its payload is released and the user sends the LABEL
 * instead of the 218 lines it stood for, with nothing on screen to say so.
 */

import { describe, expect, it } from 'vitest';
import {
  allocatePasteId,
  expandPastes,
  expandRangeOverTokens,
  formatPasteToken,
  makePasteRecord,
  pasteTokenRe,
  referencedIds,
  shouldCollapse,
  snapOutOfToken,
  tokenAt,
  type PasteRecord,
} from '../ui/paste-tokens.js';
import {
  PASTE_INLINE_MAX_CHARS,
  PASTE_INLINE_MAX_LINES,
} from '../ui/composer-limits.js';

const record = (id: number, text: string): PasteRecord => makePasteRecord(id, text);

describe('formatPasteToken (T-6)', () => {
  it('names lines for a multi-line paste and characters for a single long one', () => {
    expect(formatPasteToken(record(1, 'a\nb\nc'))).toBe('[Pasted text #1 +3 lines]');
    // "+1 lines" is not a sentence, and for a one-liner the number the user
    // cares about is its length.
    expect(formatPasteToken(record(2, 'x'.repeat(1204)))).toBe('[Pasted text #2 +1204 chars]');
  });

  it('produces a label that matches its own pattern and contains no non-ASCII', () => {
    for (const text of ['a\nb', 'x'.repeat(500), 'CJK 中文\nsecond']) {
      const label = formatPasteToken(record(7, text));
      expect(label.match(pasteTokenRe())).toHaveLength(1);
      expect(label).not.toMatch(/[^\x00-\x7f]/);
    }
  });

  it('counts characters by code point, so an emoji is one char and not two', () => {
    expect(formatPasteToken(record(3, '\u{1F600}'))).toBe('[Pasted text #3 +1 chars]');
  });
});

describe('pasteTokenRe (P2-2)', () => {
  it('returns a FRESH regex, so `lastIndex` cannot make detection intermittent', () => {
    // A module-level /g regex returns false on every SECOND `.test()` with the
    // same input — "token detection works, then randomly does not".
    const label = '[Pasted text #1 +3 lines]';
    for (let i = 0; i < 4; i += 1) expect(pasteTokenRe().test(label)).toBe(true);
    expect(pasteTokenRe()).not.toBe(pasteTokenRe());
  });

  it('does not match a near-miss label', () => {
    expect(pasteTokenRe().test('[Pasted text #1 +3 rows]')).toBe(false);
    expect(pasteTokenRe().test('[Pasted text #x +3 lines]')).toBe(false);
  });
});

describe('shouldCollapse (G3 / G4)', () => {
  it('inserts verbatim at or below BOTH inline bounds', () => {
    expect(shouldCollapse('a\nb\nc\nd')).toBe(false);
    expect(shouldCollapse('x'.repeat(PASTE_INLINE_MAX_CHARS))).toBe(false);
    expect(shouldCollapse(Array(PASTE_INLINE_MAX_LINES).fill('x').join('\n'))).toBe(false);
  });

  it('collapses above EITHER bound', () => {
    expect(shouldCollapse(Array(PASTE_INLINE_MAX_LINES + 1).fill('x').join('\n'))).toBe(true);
    expect(shouldCollapse('x'.repeat(PASTE_INLINE_MAX_CHARS + 1))).toBe(true);
  });
});

describe('expandPastes (T-7)', () => {
  const pastes = new Map([[1, record(1, 'ONE\nTWO')]]);

  it('replaces a known id and leaves an unknown one verbatim', () => {
    expect(expandPastes('see [Pasted text #1 +2 lines] ok', pastes)).toBe('see ONE\nTWO ok');
    expect(expandPastes('see [Pasted text #9 +2 lines] ok', pastes)).toBe(
      'see [Pasted text #9 +2 lines] ok',
    );
  });

  it('handles two tokens on one line', () => {
    const two = new Map([
      [1, record(1, 'A')],
      [2, record(2, 'B')],
    ]);
    expect(expandPastes('[Pasted text #1 +1 chars]/[Pasted text #2 +1 chars]', two)).toBe('A/B');
  });

  it('returns the buffer untouched when there is nothing to expand', () => {
    const buffer = 'plain text';
    expect(expandPastes(buffer, new Map())).toBe(buffer);
  });
});

describe('expandRangeOverTokens (T-8 / G5)', () => {
  const buffer = 'a [Pasted text #1 +3 lines] b';
  const start = buffer.indexOf('[');
  const end = buffer.indexOf(']') + 1;

  it('grows a range that clips a token tail out to the token start', () => {
    expect(expandRangeOverTokens(buffer, end - 1, end)).toEqual({ from: start, to: end });
  });

  it('grows a range that clips a token head out to the token end', () => {
    expect(expandRangeOverTokens(buffer, start, start + 1)).toEqual({ from: start, to: end });
  });

  it('returns a range fully outside a token unchanged', () => {
    expect(expandRangeOverTokens(buffer, 0, 1)).toEqual({ from: 0, to: 1 });
    expect(expandRangeOverTokens(buffer, end, buffer.length)).toEqual({
      from: end,
      to: buffer.length,
    });
  });
});

describe('snapOutOfToken (T-9 / D-8)', () => {
  const buffer = 'a [Pasted text #1 +3 lines] b';
  const start = buffer.indexOf('[');
  const end = buffer.indexOf(']') + 1;

  it('moves an interior index to the nearer edge', () => {
    expect(snapOutOfToken(buffer, start + 1)).toBe(start);
    expect(snapOutOfToken(buffer, end - 1)).toBe(end);
  });

  it('leaves an index at either edge, or outside every token, alone', () => {
    expect(snapOutOfToken(buffer, start)).toBe(start);
    expect(snapOutOfToken(buffer, end)).toBe(end);
    expect(snapOutOfToken(buffer, 0)).toBe(0);
    expect(snapOutOfToken('no tokens here', 5)).toBe(5);
  });
});

describe('tokenAt and referencedIds (T-10)', () => {
  const buffer = 'a [Pasted text #4 +3 lines] b';

  it('finds the token containing or touching an index', () => {
    const start = buffer.indexOf('[');
    expect(tokenAt(buffer, start)).toMatchObject({ id: 4 });
    expect(tokenAt(buffer, start + 3)).toMatchObject({ id: 4 });
    expect(tokenAt(buffer, 0)).toBeNull();
  });

  it('drops an id once its text is gone', () => {
    expect([...referencedIds(buffer)]).toEqual([4]);
    expect([...referencedIds('a  b')]).toEqual([]);
  });
});

describe('allocatePasteId (D-14 / P1-5)', () => {
  it('is monotonic, so two drafts never show #1 for different content', () => {
    const a = allocatePasteId();
    const b = allocatePasteId();
    expect(b).toBe(a + 1);
  });
});
