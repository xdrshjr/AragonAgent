/**
 * Enter-family sequence recognition (tui-shift-enter-copy-queue §3.3 / §9).
 *
 * The whole point of the module is a BYTE-LEVEL contract: these exact escape
 * sequences become these exact frames, partial sequences are held, and unknown
 * sequences pass through untouched. Every assertion below is therefore on
 * strings built from ESC and the raw bytes a terminal sends -- if an editor
 * strips a control character the test breaks loudly, not silently.
 */

import { describe, expect, it } from 'vitest';
import { ENTER_NEWLINE_FRAME } from '../input/limits.js';
import {
  ENTER_SEQUENCES,
  rewriteEnterSequences,
  trailingEnterPrefixLength,
} from '../input/enter-sequences.js';

const ESC = '\u001b';
const SEQ = (s: string): string => ESC + s; // keep the escape visible at each call site

describe('ENTER_SEQUENCES (the recognition table)', () => {
  it('covers CSI-u modifiers 2-8, both Alt+Enter encodings, and bare CSI-u', () => {
    const seqs = ENTER_SEQUENCES.map((s) => s.seq);
    for (const mod of ['2', '3', '4', '5', '6', '7', '8']) {
      expect(seqs).toContain(SEQ(`[13;${mod}u`));
    }
    expect(seqs).toContain(`${ESC}\r`);
    expect(seqs).toContain(`${ESC}\n`);
    expect(seqs).toContain(SEQ('[13u'));
  });

  it('names a meaning and a rewrite target for every entry', () => {
    for (const spec of ENTER_SEQUENCES) {
      expect(spec.meaning.length).toBeGreaterThan(0);
      expect(spec.to === ENTER_NEWLINE_FRAME || spec.to === '\r').toBe(true);
    }
  });
});

describe('rewriteEnterSequences', () => {
  it.each(ENTER_SEQUENCES.map((s) => [s.meaning, s.seq] as const))(
    'rewrites %s to the newline frame',
    (_meaning, seq) => {
      if (seq === SEQ('[13u') || seq === SEQ('[13;1u')) {
        // The unmodified CSI-u Enter a leftover kitty mode sends is a PLAIN
        // Enter: it must submit, so it maps to CR, not to a newline.
        expect(rewriteEnterSequences(seq)).toBe('\r');
        return;
      }
      expect(rewriteEnterSequences(seq)).toBe(ENTER_NEWLINE_FRAME);
    },
  );

  it('leaves a plain CR (the Enter key) untouched', () => {
    expect(rewriteEnterSequences('\r')).toBe('\r');
  });

  it('rewrites sequences embedded between keystrokes, preserving order', () => {
    expect(rewriteEnterSequences(`ab${SEQ('[13;2u')}cd${ESC}\r`)).toBe(
      `ab${ENTER_NEWLINE_FRAME}cd${ENTER_NEWLINE_FRAME}`,
    );
  });

  it('rewrites two sequences in one chunk', () => {
    expect(rewriteEnterSequences(`${ESC}\n${SEQ('[13;5u')}`)).toBe(
      `${ENTER_NEWLINE_FRAME}${ENTER_NEWLINE_FRAME}`,
    );
  });

  it('does NOT rewrite an unknown modifier (9+) or a foreign CSI-u key', () => {
    expect(rewriteEnterSequences(SEQ('[13;9u'))).toBe(SEQ('[13;9u'));
    expect(rewriteEnterSequences(SEQ('[97;2u'))).toBe(SEQ('[97;2u'));
  });

  it('does not touch arrow keys, mouse-style prefixes or plain text', () => {
    expect(rewriteEnterSequences(`${ESC}[A${ESC}[<0;12;5M`)).toBe(`${ESC}[A${ESC}[<0;12;5M`);
    expect(rewriteEnterSequences('hello')).toBe('hello');
  });

  it('is idempotent: its output contains none of its inputs', () => {
    const once = rewriteEnterSequences(`x${SEQ('[13;2u')}y${ESC}\r`);
    expect(rewriteEnterSequences(once)).toBe(once);
  });

  it('returns the same string object when nothing can match (hot path)', () => {
    const untouched = 'plain keystrokes';
    expect(rewriteEnterSequences(untouched)).toBe(untouched);
  });
});

describe('trailingEnterPrefixLength (the cross-chunk hold)', () => {
  it('holds a torn CSI-u sequence up to its divergence byte', () => {
    // Longest-match matters here: the sequence only becomes unambiguous at
    // its final byte, so every byte before it must be held for the next
    // chunk -- a shortest-match hold would release `[13;` early and destroy
    // the sequence a chunk later.
    expect(trailingEnterPrefixLength(`ab${ESC}[13;`)).toBe(`${ESC}[13;`.length); // 5
    expect(trailingEnterPrefixLength(`ab${ESC}[13;2`)).toBe(`${ESC}[13;2`.length); // 6
  });

  it('holds the shared ESC / ESC-[ heads', () => {
    expect(trailingEnterPrefixLength('ab' + ESC)).toBe(1);
    expect(trailingEnterPrefixLength('ab' + SEQ('['))).toBe(2);
    expect(trailingEnterPrefixLength('ab' + SEQ('[1'))).toBe(3);
  });

  it('a COMPLETE sequence is not a prefix -- nothing is held', () => {
    expect(trailingEnterPrefixLength(`ab${SEQ('[13;2u')}`)).toBe(0);
    expect(trailingEnterPrefixLength(`ab${SEQ('[13u')}`)).toBe(0);
    expect(trailingEnterPrefixLength(`ab${ESC}\r`)).toBe(0);
  });

  it('returns 0 for text with no sequence prefix', () => {
    expect(trailingEnterPrefixLength('hello')).toBe(0);
    expect(trailingEnterPrefixLength('')).toBe(0);
  });
});
