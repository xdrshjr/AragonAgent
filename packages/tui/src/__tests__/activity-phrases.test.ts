import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_PHRASES,
  PHRASE_ROTATE_MS,
  pickActivityPhrase,
} from '../ui/activity-phrases.js';

describe('ACTIVITY_PHRASES', () => {
  it('is pure ASCII, short, and free of duplicates', () => {
    // ASCII by the rule this tree is under: a literal that reaches a legacy
    // `cmd.exe` as mojibake is a build failure in `glyphs.test.ts`, and this list
    // is rendered verbatim.
    expect(ACTIVITY_PHRASES.length).toBeGreaterThan(20);
    expect(new Set(ACTIVITY_PHRASES).size).toBe(ACTIVITY_PHRASES.length);
    for (const phrase of ACTIVITY_PHRASES) {
      expect(phrase, phrase).not.toMatch(/[^\x20-\x7e]/);
      expect(phrase.length, phrase).toBeLessThanOrEqual(12);
      expect(phrase, phrase).not.toMatch(/\d/);
    }
  });
});

describe('pickActivityPhrase', () => {
  it('is deterministic for the same inputs', () => {
    const at = 1_700_000_000_000;
    expect(pickActivityPhrase(at, at + 500)).toBe(pickActivityPhrase(at, at + 500));
  });

  it('holds the word inside the rotation window and changes at its edge', () => {
    const at = 1_700_000_000_000;
    const opening = pickActivityPhrase(at, at);
    expect(pickActivityPhrase(at, at + PHRASE_ROTATE_MS - 1)).toBe(opening);
    expect(pickActivityPhrase(at, at + PHRASE_ROTATE_MS)).not.toBe(opening);
  });

  it('holds ONE word for the whole run under reduced motion (D-7)', () => {
    // Rotating text IS motion. Honoring the setting for the spinner only would
    // honor its letter and not its point.
    const at = 1_700_000_000_000;
    const word = pickActivityPhrase(at, at, false);
    for (const elapsed of [0, 4_000, 60_000, 3_600_000]) {
      expect(pickActivityPhrase(at, at + elapsed, false)).toBe(word);
    }
  });

  it('gives two runs a second or more apart different opening words', () => {
    const a = 1_700_000_000_000;
    expect(pickActivityPhrase(a, a)).not.toBe(pickActivityPhrase(a + 1000, a + 1000));
  });

  it('is TOTAL: a `now` before the start, and non-finite inputs, still answer', () => {
    const at = 1_700_000_000_000;
    expect(ACTIVITY_PHRASES).toContain(pickActivityPhrase(at, at - 10_000));
    expect(ACTIVITY_PHRASES).toContain(pickActivityPhrase(0, 0));
    expect(ACTIVITY_PHRASES).toContain(pickActivityPhrase(-5_000, 0));
    expect(ACTIVITY_PHRASES).toContain(pickActivityPhrase(Number.NaN, 0));
    expect(ACTIVITY_PHRASES).toContain(pickActivityPhrase(at, Number.POSITIVE_INFINITY));
  });
});
