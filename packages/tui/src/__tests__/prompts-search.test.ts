/**
 * Filtering and view order (quick-prompt-library D-9 / D-10 / AC-14 / AC-22).
 *
 * Two properties are load-bearing and easy to lose: a match in the TITLE outranks a
 * match in a tag, and a filter never reshuffles entries with equal scores (a list that
 * moves under the arrow keys while the user types is unusable).
 */

import { describe, expect, it } from 'vitest';
import {
  nextView,
  searchPrompts,
  sortedPromptTitleOrder,
  subsequenceScore,
  viewOrder,
} from '../model/prompts/search.js';
import type { QuickPrompt } from '../model/prompts/types.js';

const prompt = (over: Partial<QuickPrompt> & { id: string }): QuickPrompt => ({
  title: over.id, content: 'body', useCount: 0, createdAt: 0, updatedAt: 0, ...over,
});

const rows = [
  prompt({ id: 'a', title: 'Clean code review', tags: ['quality'], useCount: 4 }),
  prompt({ id: 'b', title: 'Fix lint', tags: ['clean'], favorite: true, useCount: 1 }),
  prompt({ id: 'c', title: 'Write changelog', description: 'clean wording', useCount: 9,
    lastUsedAt: 5_000 }),
  prompt({ id: 'd', title: '中文标题', tags: ['写作'], useCount: 0 }),
];

describe('subsequenceScore', () => {
  it('matches characters in order and rejects them out of order', () => {
    expect(subsequenceScore('clean code review', 'clr')).not.toBeNull();
    expect(subsequenceScore('clean code review', 'rcl')).toBeNull();
    expect(subsequenceScore('anything', '')).toBe(0);
  });

  it('scores an earlier and tighter match better', () => {
    const early = subsequenceScore('abc xxx', 'abc')!;
    const late = subsequenceScore('xxx abc', 'abc')!;
    expect(early).toBeLessThan(late);
  });

  it('is case-insensitive', () => {
    expect(subsequenceScore('Clean Code', 'cc')).not.toBeNull();
  });
});

describe('searchPrompts: field priority and stable ties', () => {
  it('returns the manual order for an empty query', () => {
    expect(searchPrompts(rows, '   ').map((hit) => hit.prompt.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('prefers a title match over a tag match over a description match', () => {
    // No favourites here: the favourite boost would outrank the field penalty, and this
    // case is precisely about the FIELD a match landed in.
    const hits = searchPrompts([
      prompt({ id: 'title', title: 'clean sweep' }),
      prompt({ id: 'tag', title: 'Fix lint', tags: ['clean'] }),
      prompt({ id: 'desc', title: 'Other', description: 'clean wording' }),
    ], 'clean').map((hit) => hit.prompt.id);
    expect(hits).toEqual(['title', 'tag', 'desc']);
  });

  it('puts a favourite first when the scores are comparable', () => {
    const hits = searchPrompts([prompt({ id: 'x', title: 'fix a' }),
      prompt({ id: 'y', title: 'fix b', favorite: true })], 'fix');
    expect(hits[0]!.prompt.id).toBe('y');
  });

  it('filters out everything that does not match', () => {
    expect(searchPrompts(rows, 'zzz')).toEqual([]);
  });

  it('matches a Chinese title by its characters', () => {
    expect(searchPrompts(rows, '中文').map((hit) => hit.prompt.id)).toEqual(['d']);
    expect(searchPrompts(rows, '写作').map((hit) => hit.prompt.id)).toEqual(['d']);
  });
});

describe('viewOrder: three presentations, one persisted order', () => {
  it('manual is the array order', () => {
    expect(viewOrder(rows, 'manual').map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('recent sorts by lastUsedAt and leaves never-used entries at the tail', () => {
    expect(viewOrder(rows, 'recent').map((entry) => entry.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('favorite lifts favourites and keeps everything else in place', () => {
    expect(viewOrder(rows, 'favorite').map((entry) => entry.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('never mutates the input array', () => {
    const before = rows.map((entry) => entry.id);
    viewOrder(rows, 'favorite');
    expect(rows.map((entry) => entry.id)).toEqual(before);
  });

  it('cycles manual -> recent -> favorite -> manual (AC-22)', () => {
    expect(nextView('manual')).toBe('recent');
    expect(nextView('recent')).toBe('favorite');
    expect(nextView('favorite')).toBe('manual');
  });

  it('sortedPromptTitleOrder is the `/prompts sort name` order, and it is total', () => {
    // `name` HAS TO MEAN TITLE ORDER: it is the word the user typed. The tie-break on id
    // is what makes the result reproducible for two entries with the same title.
    expect(sortedPromptTitleOrder(rows).map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    const twins = [prompt({ id: 'y', title: 'Same' }), prompt({ id: 'x', title: 'Same' })];
    expect(sortedPromptTitleOrder(twins).map((entry) => entry.id)).toEqual(['x', 'y']);
  });
});
