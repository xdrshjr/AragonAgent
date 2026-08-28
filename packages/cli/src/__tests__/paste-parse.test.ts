/**
 * Paste recognition primitives (tui-paste-handling section 5.1, T-1..T-4).
 *
 * PURE-FUNCTION ASSERTIONS ON PURPOSE. Everything these cover is decided BELOW
 * Ink, on a byte stream whose chunk boundaries no component can see — so a
 * rendered-output test could only ever observe the consequences, and the
 * consequences of getting this wrong (a submitted half-message, an overwritten
 * row) are exactly the ones that leave nothing behind to assert on.
 */

import { describe, expect, it } from 'vitest';
import {
  PASTE_BEGIN_MARK,
  PASTE_END_MARK,
  classifyChunk,
  isPastePrefix,
  sanitisePaste,
  trailingPastePrefixLength,
} from '../input/paste-parse.js';
import { PASTE_MIN_BURST_CHARS } from '../input/limits.js';

describe('sanitisePaste (G2)', () => {
  it('T-1: CRLF and a lone CR both become exactly one newline', () => {
    // Terminals send CR, not LF, for a newline in pasted text — and Ink maps the
    // exact string '\r' to `key.return`, which the composer reads as "send".
    expect(sanitisePaste('a\r\nb\rc')).toBe('a\nb\nc');
    expect(sanitisePaste('\r\n')).toBe('\n');
    expect(sanitisePaste('a\n\nb')).toBe('a\n\nb');
  });

  it('T-2: strips ESC / BEL / NUL, keeps TAB, and leaves non-ASCII untouched', () => {
    expect(sanitisePaste('a\x1b[31mb\x07c\x00d')).toBe('a[31mbcd');
    expect(sanitisePaste('\tindented')).toBe('\tindented');
    expect(sanitisePaste('CJK: 中文 emoji: \u{1F600}')).toBe('CJK: 中文 emoji: \u{1F600}');
  });

  it('strips DEL and every C1 byte, which "strip C0" alone would let through (P2-1)', () => {
    // U+009B is the single-byte CSI and U+0085 is NEL: a terminal that decodes
    // them acts on them exactly as it acts on `\x1b[`.
    expect(sanitisePaste('a\x7fb\u009bc\u0085d\u0080e')).toBe('abcde');
  });

  it('is idempotent, so a payload cannot be made worse by a second pass', () => {
    const once = sanitisePaste('x\r\n\x1b[0m\ty');
    expect(sanitisePaste(once)).toBe(once);
  });
});

describe('classifyChunk (D-5)', () => {
  it('T-3: a single character is keys, and a lone CR is the Enter key', () => {
    expect(classifyChunk('a')).toBe('keys');
    expect(classifyChunk('\r')).toBe('keys');
    expect(classifyChunk('\n')).toBe('keys');
    expect(classifyChunk('')).toBe('keys');
  });

  it('T-3: a multi-character chunk containing a line break is a paste', () => {
    // A keyboard cannot emit this, and it is exactly the shape that submits the
    // draft by accident — so the rule and the defect coincide.
    expect(classifyChunk('ab\r')).toBe('paste');
    expect(classifyChunk('ab\n')).toBe('paste');
    expect(classifyChunk('\r\n')).toBe('paste');
  });

  it('T-3: the single-line rule steps at exactly PASTE_MIN_BURST_CHARS', () => {
    expect(classifyChunk('x'.repeat(PASTE_MIN_BURST_CHARS - 1))).toBe('keys');
    expect(classifyChunk('x'.repeat(PASTE_MIN_BURST_CHARS))).toBe('paste');
  });

  it('keeps an arrow-key burst out of the paste path', () => {
    // Holding Down, or a wheel notch translated by DEC 1007, produces exactly
    // this — long, no line break, and full of ESC.
    const burst = '\x1b[B'.repeat(20);
    expect(burst.length).toBeGreaterThan(PASTE_MIN_BURST_CHARS);
    expect(classifyChunk(burst)).toBe('keys');
  });

  it('allows TAB in the single-line rule, because indentation is content', () => {
    expect(classifyChunk(`\t${'x'.repeat(PASTE_MIN_BURST_CHARS)}`)).toBe('paste');
  });
});

describe('isPastePrefix (T-4)', () => {
  it('is true for every strict prefix of the begin marker and false for the whole one', () => {
    for (let i = 1; i < PASTE_BEGIN_MARK.length; i += 1) {
      expect(isPastePrefix(PASTE_BEGIN_MARK.slice(0, i)), `prefix ${i}`).toBe(true);
    }
    expect(isPastePrefix(PASTE_BEGIN_MARK)).toBe(false);
    expect(isPastePrefix('')).toBe(false);
  });

  it('covers the END marker too, which shares four characters with BEGIN (I-16)', () => {
    // Without this, `\x1b[201` in a chunk tail is passed through as text and the
    // user sees a literal `[201~` in their draft.
    expect(isPastePrefix(PASTE_END_MARK.slice(0, 5))).toBe(true);
    expect(isPastePrefix(PASTE_END_MARK)).toBe(false);
  });

  it('is false for ordinary text and for a mouse prefix past the shared bytes', () => {
    expect(isPastePrefix('a')).toBe(false);
    expect(isPastePrefix('\x1b[<0')).toBe(false);
  });
});

describe('trailingPastePrefixLength', () => {
  it('holds back only the bytes that could still become a marker', () => {
    expect(trailingPastePrefixLength('hello\x1b[20')).toBe(4);
    expect(trailingPastePrefixLength('hello\x1b')).toBe(1);
    expect(trailingPastePrefixLength('hello')).toBe(0);
  });

  it('holds nothing once the marker is complete', () => {
    expect(trailingPastePrefixLength(`hello${PASTE_BEGIN_MARK}`)).toBe(0);
  });
});
