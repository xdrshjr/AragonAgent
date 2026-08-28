/**
 * `normalizeCritique` (fast-model-tier §3.5.3 / D-17 / §8.1).
 *
 * THE ON-TRACK TEST IS THE ONE THAT MATTERS. Under string equality, a model that
 * writes `Ok, on track` would be classified as ADVICE and injected into the main
 * context on every cycle, forever, saying nothing — a permanent context tax that
 * looks like the feature working.
 */

import { describe, expect, it } from 'vitest';
import { isOnTrack, normalizeCritique } from '../fast/critique.js';

describe('the on-track classifier is a NORMALIZED REGEX, not equality (D-17)', () => {
  it.each([
    'OK - on track.',
    'Ok, on track',
    '  ok - everything on track  ',
    'OK. On track!',
    'ok, still on track',
  ])('classifies %j as `ok`', (raw) => {
    expect(isOnTrack(raw)).toBe(true);
    expect(normalizeCritique(raw, 280)).toEqual({ kind: 'ok' });
  });

  it.each([
    'OK, but the tests are failing',
    'Not on track: you have edited schema.ts three times',
    'The run is on the wrong track',
  ])('classifies %j as advice', (raw) => {
    expect(isOnTrack(raw)).toBe(false);
    expect(normalizeCritique(raw, 280).kind).toBe('advice');
  });

  it('does not match a sentence that merely CONTAINS "on track"', () => {
    // The anchor is `^ok\b`: an actual critique that happens to use the phrase
    // must not be swallowed as "nothing to report".
    expect(isOnTrack('You claimed this was on track; it is not.')).toBe(false);
  });
});

describe('normalization', () => {
  it('treats an empty or whitespace-only answer as `empty`, never as advice', () => {
    expect(normalizeCritique('', 280)).toEqual({ kind: 'empty' });
    expect(normalizeCritique('   \n\n  ', 280)).toEqual({ kind: 'empty' });
  });

  it('strips a fenced code block the model wrapped its prose in', () => {
    const out = normalizeCritique('```\nRun the tests before editing again.\n```', 280);
    expect(out).toEqual({ kind: 'advice', text: 'Run the tests before editing again.' });
  });

  it('strips a LANGUAGE-TAGGED fence too', () => {
    const out = normalizeCritique('```text\nCheck the clamp bounds.\n```', 280);
    expect(out).toEqual({ kind: 'advice', text: 'Check the clamp bounds.' });
  });

  it('collapses whitespace BEFORE measuring, so blank lines do not spend the budget', () => {
    const out = normalizeCritique('one\n\n\n   two', 280);
    expect(out).toEqual({ kind: 'advice', text: 'one two' });
  });

  it('clamps to `reviewMaxChars` on a word boundary when one is close enough', () => {
    const raw = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda';
    const out = normalizeCritique(raw, 20);
    expect(out.kind).toBe('advice');
    if (out.kind !== 'advice') throw new Error('unreachable');
    expect(out.text.length).toBeLessThanOrEqual(20);
    // A word boundary, not a mid-word cut: a truncated critique that reads as
    // corruption is worse than a shorter one.
    expect(out.text.endsWith(' ')).toBe(false);
    expect(raw.startsWith(out.text)).toBe(true);
  });

  it('falls back to a hard cut when there is no usable boundary', () => {
    const out = normalizeCritique('a'.repeat(40), 10);
    expect(out).toEqual({ kind: 'advice', text: 'a'.repeat(10) });
  });
});
