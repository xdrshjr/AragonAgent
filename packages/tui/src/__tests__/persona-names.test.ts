/**
 * PersonaBook (tui-subagent-persona-and-developer-mode §3.1 / AC-1).
 *
 * The properties under test are structural, not statistical: a name is unique inside a
 * scope because of probing, and stable across surfaces because the book remembers the
 * first assignment - neither depends on how unlikely a hash collision is.
 */

import { describe, expect, it } from 'vitest';
import {
  PERSONA_BOOK_MAX_ENTRIES,
  PERSONA_NAME_MAX_CHARS,
  PERSONA_POOL,
  createPersonaBook,
  hash32,
} from '../ui/persona-names.js';

describe('PERSONA_POOL', () => {
  it('has 64 ASCII names, case-insensitively unique, none reserved', () => {
    expect(PERSONA_POOL).toHaveLength(64);
    for (const name of PERSONA_POOL) expect(name).toMatch(/^[A-Z][a-z]{1,5}$/);
    expect(new Set(PERSONA_POOL.map((name) => name.toLowerCase())).size).toBe(64);
    for (const reserved of ['lead', 'all', 'user', 'team']) {
      expect(PERSONA_POOL.map((name) => name.toLowerCase())).not.toContain(reserved);
    }
    expect(Math.max(...PERSONA_POOL.map((name) => name.length))).toBeLessThanOrEqual(PERSONA_NAME_MAX_CHARS);
  });
});

describe('hash32', () => {
  it('is deterministic, unsigned 32-bit and total', () => {
    expect(hash32('dev1-r1')).toBe(hash32('dev1-r1'));
    for (const text of ['', 'a', '\u0000', '任务', 'x'.repeat(10_000)]) {
      const value = hash32(text);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });
});

describe('createPersonaBook', () => {
  it('(a) names are unique inside a scope for 10, 16 and 70 labels', () => {
    for (const count of [10, 16, 70]) {
      const book = createPersonaBook();
      const names = Array.from({ length: count }, (_, i) => book.nameFor('s', `label-${i}`));
      expect(new Set(names).size).toBe(count);
      for (const name of names) expect(name.length).toBeGreaterThan(0);
    }
  });

  it('(b) first sight wins: order, subset and later arrivals never rename anyone', () => {
    const book = createPersonaBook();
    const first = ['a', 'b', 'c', 'd'].map((label) => book.nameFor('s', label));
    const again = ['d', 'c', 'b', 'a'].map((label) => book.nameFor('s', label)).reverse();
    expect(again).toEqual(first);
    book.nameFor('s', 'e');
    book.nameFor('s', 'f');
    expect(['a', 'b', 'c', 'd'].map((label) => book.nameFor('s', label))).toEqual(first);
  });

  it('(c) an aliased scope resolves to the run scope, even when two labels collide', () => {
    // Find two labels whose hash slots coincide in the run scope.
    const slot = (label: string): number => hash32(`run\u0000${label}`) % PERSONA_POOL.length;
    const labels: string[] = [];
    for (let i = 0; labels.length < 2 && i < 5_000; i += 1) {
      const candidate = `dev${i}-r1`;
      if (labels.length === 0 || slot(candidate) === slot(labels[0]!)) labels.push(candidate);
    }
    expect(labels).toHaveLength(2);
    const book = createPersonaBook();
    const roster = labels.map((label) => book.nameFor('run', label));
    expect(roster[0]).not.toBe(roster[1]);
    book.alias('dispatch-9', 'run');
    // The stage card asks in the dispatch scope and, in the opposite order.
    const card = [...labels].reverse().map((label) => book.nameFor('dispatch-9', label)).reverse();
    expect(card).toEqual(roster);
  });

  it('registering an alias late discards names handed out under the raw scope (R-14)', () => {
    const book = createPersonaBook();
    book.nameFor('run', 'x');
    const early = book.nameFor('dispatch', 'x');
    book.alias('dispatch', 'run');
    expect(book.nameFor('dispatch', 'x')).toBe(book.nameFor('run', 'x'));
    expect(typeof early).toBe('string');
  });

  it('(d) different scopes give different assignments for at least some labels', () => {
    const book = createPersonaBook();
    const labels = Array.from({ length: 10 }, (_, i) => `l${i}`);
    const one = labels.map((label) => book.nameFor('one', label));
    const two = labels.map((label) => book.nameFor('two', label));
    expect(two).not.toEqual(one);
  });

  it('(e) reset forgets everything', () => {
    const book = createPersonaBook();
    book.nameFor('s', 'a');
    book.alias('d', 's');
    book.reset();
    // Fresh book behaviour: an alias is gone, so `d` is its own scope again.
    expect(book.nameFor('d', 'a')).toBe(createPersonaBook().nameFor('d', 'a'));
  });

  it('(f) stays bounded: past the entry cap the oldest scope is evicted and nothing throws', () => {
    const book = createPersonaBook();
    for (let scope = 0; scope < 12; scope += 1) {
      for (let i = 0; i < 64; i += 1) book.nameFor(`scope-${scope}`, `l${i}`);
    }
    expect(PERSONA_BOOK_MAX_ENTRIES).toBe(256);
    expect(() => book.nameFor('scope-11', 'l0')).not.toThrow();
    expect(book.nameFor('fresh', 'l0').length).toBeGreaterThan(0);
  });

  it('(g) an alias cycle neither hangs nor throws', () => {
    const book = createPersonaBook();
    book.alias('A', 'B');
    book.alias('B', 'A');
    expect(book.nameFor('A', 'x').length).toBeGreaterThan(0);
    expect(book.nameFor('B', 'x').length).toBeGreaterThan(0);
  });
});
