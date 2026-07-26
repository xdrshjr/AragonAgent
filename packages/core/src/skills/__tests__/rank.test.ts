/**
 * AC-A3 — catalog ranking (§5.2).
 *
 * The load-bearing test here is I-A1, not the bucket arithmetic: with no usage
 * data the ranked order must be ELEMENT-FOR-ELEMENT the pre-ranking order. That
 * is what lets every catalog snapshot written before this feature keep passing
 * untouched, and it is the property that makes the change revertible by simply
 * not passing `usage`. If it ever breaks, the symptom is a pile of unrelated
 * red tests that hides whatever real regression landed alongside.
 */

import { describe, it, expect } from 'vitest';
import { catalogRecords, rankCatalogRecords } from '../disclosure.js';
import {
  USAGE_RECENCY_DAY_MS,
  USAGE_RECENCY_HOUR_MS,
  USAGE_RECENCY_WEEK_MS,
} from '../constants.js';
import { makeRecord } from './fixtures.js';
import type { SkillScope, SkillUsageMap } from '../types.js';

const NOW = 1_800_000_000_000;
const SCOPES: SkillScope[] = ['bundled', 'user', 'project', 'env'];

function names(records: ReturnType<typeof makeRecord>[]): string[] {
  return records.map((r) => r.name);
}

describe('rankCatalogRecords — I-A1 degradation invariant (AC-A3)', () => {
  it('with no usage map, matches catalogRecords element for element', () => {
    const records = [
      makeRecord({ name: 'zzz', scope: 'user' }),
      makeRecord({ name: 'aaa', scope: 'user' }),
      makeRecord({ name: 'mmm', scope: 'project' }),
      makeRecord({ name: 'bbb', scope: 'bundled' }),
      makeRecord({ name: 'ccc', scope: 'env' }),
    ];
    expect(names(rankCatalogRecords(records))).toEqual(names(catalogRecords(records)));
    expect(names(rankCatalogRecords(records, {}))).toEqual(names(catalogRecords(records)));
  });

  it('with an EMPTY usage map, still matches catalogRecords', () => {
    // Distinct from the case above: `usage: {}` takes the scoring path rather
    // than the early return, so this asserts the scores themselves collapse to
    // the scope term — the actual claim I-A1 makes.
    const records = SCOPES.flatMap((scope) =>
      ['q', 'a', 'z'].map((n) => makeRecord({ name: `${scope}-${n}`, scope })),
    );
    expect(names(rankCatalogRecords(records, { usage: {}, now: NOW }))).toEqual(
      names(catalogRecords(records)),
    );
  });

  it('property: 200 pseudo-random record sets all degrade identically', () => {
    // Deterministic LCG — a seeded generator keeps a failure reproducible,
    // which `Math.random()` would not.
    let seed = 42;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round += 1) {
      const size = 1 + Math.floor(next() * 12);
      const records = Array.from({ length: size }, (_, i) =>
        makeRecord({
          name: `s-${Math.floor(next() * 1000)}-${i}`,
          scope: SCOPES[Math.floor(next() * SCOPES.length)]!,
        }),
      );
      expect(names(rankCatalogRecords(records, { usage: {}, now: NOW }))).toEqual(
        names(catalogRecords(records)),
      );
    }
  });

  it('does not mutate the caller’s array', () => {
    const records = [makeRecord({ name: 'b' }), makeRecord({ name: 'a' })];
    const before = names(records);
    rankCatalogRecords(records, { usage: { a: { useCount: 99, lastUsedAt: NOW } }, now: NOW });
    expect(names(records)).toEqual(before);
  });
});

describe('rankCatalogRecords — scope dominates usage', () => {
  it('an unused project skill still outranks a heavily used user skill', () => {
    const records = [
      makeRecord({ name: 'daily-driver', scope: 'user' }),
      makeRecord({ name: 'never-used', scope: 'project' }),
    ];
    const usage: SkillUsageMap = { 'daily-driver': { useCount: 500, lastUsedAt: NOW - 1000 } };
    expect(names(rankCatalogRecords(records, { usage, now: NOW }))).toEqual([
      'never-used',
      'daily-driver',
    ]);
  });

  it('usage reorders WITHIN one scope (F3 — the lexical-truncation bug)', () => {
    const records = [
      makeRecord({ name: 'aaa-demo', scope: 'user' }),
      makeRecord({ name: 'zzz-deploy', scope: 'user' }),
    ];
    // Lexically `aaa-demo` wins and `zzz-deploy` is what truncation drops —
    // even though it is the one the user runs every day.
    expect(names(rankCatalogRecords(records))).toEqual(['aaa-demo', 'zzz-deploy']);
    const usage: SkillUsageMap = { 'zzz-deploy': { useCount: 40, lastUsedAt: NOW - 60_000 } };
    expect(names(rankCatalogRecords(records, { usage, now: NOW }))).toEqual([
      'zzz-deploy',
      'aaa-demo',
    ]);
  });
});

describe('rankCatalogRecords — bucket boundaries', () => {
  const rankTwo = (aLastUsed: number, bLastUsed: number): string[] =>
    names(
      rankCatalogRecords([makeRecord({ name: 'a' }), makeRecord({ name: 'b' })], {
        usage: {
          a: { useCount: 1, lastUsedAt: aLastUsed },
          b: { useCount: 1, lastUsedAt: bLastUsed },
        },
        now: NOW,
      }),
    );

  it('59 min beats 61 min (the 1 h edge)', () => {
    expect(rankTwo(NOW - 59 * 60_000, NOW - 61 * 60_000)).toEqual(['a', 'b']);
    expect(rankTwo(NOW - 61 * 60_000, NOW - 59 * 60_000)).toEqual(['b', 'a']);
  });

  it('23 h beats 25 h (the 24 h edge)', () => {
    expect(rankTwo(NOW - 23 * USAGE_RECENCY_HOUR_MS, NOW - 25 * USAGE_RECENCY_HOUR_MS)).toEqual([
      'a',
      'b',
    ]);
  });

  it('6 d beats 8 d (the 7 d edge)', () => {
    expect(rankTwo(NOW - 6 * USAGE_RECENCY_DAY_MS, NOW - 8 * USAGE_RECENCY_DAY_MS)).toEqual([
      'a',
      'b',
    ]);
  });

  it('anything older than a week is in the same bucket, so name breaks the tie', () => {
    expect(rankTwo(NOW - 8 * USAGE_RECENCY_DAY_MS, NOW - 400 * USAGE_RECENCY_DAY_MS)).toEqual([
      'a',
      'b',
    ]);
    expect(rankTwo(NOW - 400 * USAGE_RECENCY_DAY_MS, NOW - 8 * USAGE_RECENCY_DAY_MS)).toEqual([
      'a',
      'b',
    ]);
  });

  it('lastUsedAt = 0 means never used, not "used at the epoch"', () => {
    const ranked = rankCatalogRecords([makeRecord({ name: 'a' }), makeRecord({ name: 'b' })], {
      usage: { a: { useCount: 0, lastUsedAt: 0 }, b: { useCount: 0, lastUsedAt: NOW - 1000 } },
      now: NOW,
    });
    expect(names(ranked)).toEqual(['b', 'a']);
  });

  it('frequency buckets at 3 and 10, and only breaks a recency tie', () => {
    const stale = NOW - 2 * USAGE_RECENCY_WEEK_MS;
    const ranked = rankCatalogRecords(
      [makeRecord({ name: 'a' }), makeRecord({ name: 'b' }), makeRecord({ name: 'c' })],
      {
        usage: {
          a: { useCount: 2, lastUsedAt: stale },
          b: { useCount: 10, lastUsedAt: stale },
          c: { useCount: 3, lastUsedAt: stale },
        },
        now: NOW,
      },
    );
    expect(names(ranked)).toEqual(['b', 'c', 'a']);
  });

  it('ties fall back to name ascending, so the order is reproducible', () => {
    const usage: SkillUsageMap = {
      b: { useCount: 5, lastUsedAt: NOW - 1000 },
      a: { useCount: 5, lastUsedAt: NOW - 1000 },
    };
    const ranked = rankCatalogRecords([makeRecord({ name: 'b' }), makeRecord({ name: 'a' })], {
      usage,
      now: NOW,
    });
    expect(names(ranked)).toEqual(['a', 'b']);
  });

  it('filters disabled / invalid / manual exactly like catalogRecords', () => {
    const records = [
      makeRecord({ name: 'ok' }),
      makeRecord({ name: 'off', disabled: true }),
      makeRecord({ name: 'bad', invalid: true }),
      makeRecord({ name: 'hidden', activation: 'manual' }),
    ];
    const usage: SkillUsageMap = {
      off: { useCount: 99, lastUsedAt: NOW },
      hidden: { useCount: 99, lastUsedAt: NOW },
    };
    expect(names(rankCatalogRecords(records, { usage, now: NOW }))).toEqual(['ok']);
  });
});
