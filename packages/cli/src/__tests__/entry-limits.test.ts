import { describe, expect, it } from 'vitest';
import {
  ELISION_MARK_PREFIX,
  ELISION_MARK_SUFFIX,
  ENTRY_LIMITS,
  appendBounded,
  entryRetain,
  setEntryRetain,
  trimEntries,
} from '../agent/entry-limits.js';
import type { Entry } from '../agent/reducer.js';

const notice = (id: string): Entry => ({ id, kind: 'notice', level: 'info', text: id });

describe('appendBounded (AC-7)', () => {
  it('returns the concatenation untouched while it fits', () => {
    expect(appendBounded('abc', 'def', 100)).toBe('abcdef');
    expect(appendBounded('', '', 100)).toBe('');
  });

  it('never exceeds the cap, however long the delta', () => {
    const cap = 400;
    let text = '';
    for (let i = 0; i < 50; i += 1) {
      text = appendBounded(text, 'x'.repeat(97), cap);
      expect(text.length).toBeLessThanOrEqual(cap);
    }
  });

  it('keeps the head AND the tail', () => {
    const head = 'START';
    const tail = 'END';
    const out = appendBounded(head + 'm'.repeat(5000), tail, 400);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
  });

  it('collapses re-elision into a single marker with a growing count', () => {
    const cap = 300;
    const first = appendBounded('HEAD' + 'a'.repeat(1000), 'TAIL', cap);
    const second = appendBounded(first, 'b'.repeat(1000), cap);
    const markers = second.split(ELISION_MARK_PREFIX).length - 1;
    expect(markers).toBe(1);
    expect(second.split(ELISION_MARK_SUFFIX).length - 1).toBe(1);
    expect(second.length).toBeLessThanOrEqual(cap);

    const countOf = (s: string): number => {
      const m = /\[\.\.\. (\d+) characters elided/.exec(s);
      return m ? Number.parseInt(m[1]!, 10) : 0;
    };
    // The second elision must ADD to the first, not restart it: a reset count
    // would under-report the loss for the rest of the session.
    expect(countOf(second)).toBeGreaterThan(countOf(first));
  });

  it('stays ASCII, so it is safe on a legacy console', () => {
    const out = appendBounded('h'.repeat(1000), 't', 200);
    expect(out).not.toMatch(/[^\x00-\x7f]/);
  });

  it('degrades rather than throwing on a nonsense cap', () => {
    expect(appendBounded('abc', 'd', 0)).toBe('');
    expect(appendBounded('abcdef', 'g', 3)).toBe('efg');
  });

  it('ships caps that are ordered text > thinking > argsRaw', () => {
    expect(ENTRY_LIMITS.text).toBeGreaterThan(ENTRY_LIMITS.thinking);
    expect(ENTRY_LIMITS.thinking).toBeGreaterThan(ENTRY_LIMITS.argsRaw);
  });
});

describe('trimEntries', () => {
  it('returns the SAME array reference when it is a no-op', () => {
    // Load-bearing: a fresh array on every append would defeat every
    // `React.memo` boundary in the transcript.
    const entries = [notice('e1'), notice('e2')];
    const out = trimEntries(entries, 10);
    expect(out.entries).toBe(entries);
    expect(out.dropped).toBe(0);
  });

  it('drops from the HEAD and reports how many', () => {
    const entries = [notice('e1'), notice('e2'), notice('e3'), notice('e4')];
    const out = trimEntries(entries, 2);
    expect(out.dropped).toBe(2);
    expect(out.entries.map((e) => e.id)).toEqual(['e3', 'e4']);
  });

  it('never returns an empty list for a nonsense retain', () => {
    const entries = [notice('e1'), notice('e2')];
    expect(trimEntries(entries, 0).entries).toHaveLength(1);
    expect(trimEntries(entries, -5).entries).toHaveLength(1);
  });
});

describe('the resolved retain singleton', () => {
  it('accepts a positive value and ignores nonsense', () => {
    const before = entryRetain();
    setEntryRetain(1234);
    expect(entryRetain()).toBe(1234);
    setEntryRetain(0);
    setEntryRetain(Number.NaN);
    expect(entryRetain()).toBe(1234);
    setEntryRetain(before);
  });
});
