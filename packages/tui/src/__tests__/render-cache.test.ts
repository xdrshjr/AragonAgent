import { afterEach, describe, expect, it, vi } from 'vitest';

// Spied BEFORE the module under test is imported: `render-cache.ts` binds
// `highlight` at import time, so a later `vi.spyOn` on the namespace would never
// be seen. AC-3 is entirely about the CALL COUNT, so the mock has to be in place
// from the first call.
const highlightSpy = vi.fn((code: string, _opts?: unknown) => `<hl>${code}</hl>`);
vi.mock('cli-highlight', () => ({
  highlight: (code: string, opts?: unknown) => highlightSpy(code, opts),
}));

const {
  RENDER_CACHE_LIMITS,
  clearRenderCaches,
  highlightCached,
  parseMarkdownCached,
  renderCacheStats,
  splitLinesCached,
  glyphsFor,
} = await import('../ui/render-cache.js');
const { pickGlyphs } = await import('../ui/glyphs.js');

afterEach(() => {
  clearRenderCaches();
  highlightSpy.mockClear();
});

describe('highlightCached (AC-3)', () => {
  it('calls highlight() once per distinct (code, lang), not once per frame', () => {
    for (let i = 0; i < 30; i += 1) highlightCached('const a = 1;', 'ts');
    expect(highlightSpy).toHaveBeenCalledTimes(1);
    highlightCached('const a = 1;', 'js');
    expect(highlightSpy).toHaveBeenCalledTimes(2);
  });

  it('returns an identical reference for an identical input', () => {
    const a = highlightCached('x', 'ts');
    const b = highlightCached('x', 'ts');
    expect(a).toBe(b);
  });

  it('bypasses highlighting entirely above highlightMaxChars', () => {
    // highlight.js is superlinear; a multi-megabyte "code block" is a pasted log
    // and tokenising it would cost the whole frame budget for nothing.
    const huge = 'a'.repeat(RENDER_CACHE_LIMITS.highlightMaxChars + 1);
    expect(highlightCached(huge, 'ts')).toBe(huge);
    expect(highlightSpy).not.toHaveBeenCalled();
  });

  it('falls back to the plain code when the highlighter throws', () => {
    highlightSpy.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(highlightCached('oops', 'nope')).toBe('oops');
  });

  it('evicts by entry count', () => {
    for (let i = 0; i < RENDER_CACHE_LIMITS.highlightEntries + 5; i += 1) {
      highlightCached(`code${i}`, 'ts');
    }
    expect(renderCacheStats().highlightEntries).toBeLessThanOrEqual(
      RENDER_CACHE_LIMITS.highlightEntries,
    );
  });

  it('evicts by byte budget before the entry ceiling is reached', () => {
    // One-tenth of the budget each: the count ceiling (128) is never approached,
    // so only the byte budget can be doing the eviction.
    const chunk = 'b'.repeat(Math.floor(RENDER_CACHE_LIMITS.highlightBytes / 10));
    for (let i = 0; i < 20; i += 1) highlightCached(`${i}${chunk}`, 'ts');
    const stats = renderCacheStats();
    expect(stats.highlightEntries).toBeLessThan(20);
    expect(stats.highlightBytes).toBeLessThanOrEqual(RENDER_CACHE_LIMITS.highlightBytes);
  });
});

describe('parseMarkdownCached', () => {
  it('returns an identical reference for identical text', () => {
    const text = '# Title\n\nbody\n';
    expect(parseMarkdownCached(text)).toBe(parseMarkdownCached(text));
  });

  it('parses fences and tables into blocks', () => {
    const blocks = parseMarkdownCached('a\n```ts\nx\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(blocks.map((b) => b.kind)).toEqual(['line', 'code', 'table']);
  });

  it('evicts by entry count', () => {
    for (let i = 0; i < RENDER_CACHE_LIMITS.markdownEntries + 10; i += 1) {
      parseMarkdownCached(`doc ${i}`);
    }
    expect(renderCacheStats().markdownEntries).toBeLessThanOrEqual(
      RENDER_CACHE_LIMITS.markdownEntries,
    );
  });
});

describe('splitLinesCached', () => {
  it('returns an identical reference for identical text', () => {
    expect(splitLinesCached('a\nb')).toBe(splitLinesCached('a\nb'));
  });

  it('splits on newlines', () => {
    expect([...splitLinesCached('a\nb\nc')]).toEqual(['a', 'b', 'c']);
    expect([...splitLinesCached('')]).toEqual([]);
  });
});

describe('clearRenderCaches', () => {
  it('drops everything, so /perf reset really re-does the work', () => {
    highlightCached('z', 'ts');
    parseMarkdownCached('z');
    splitLinesCached('z');
    clearRenderCaches();
    const stats = renderCacheStats();
    expect(stats.highlightEntries).toBe(0);
    expect(stats.markdownEntries).toBe(0);
    expect(stats.lineEntries).toBe(0);
    highlightCached('z', 'ts');
    expect(highlightSpy).toHaveBeenCalledTimes(2);
  });
});

describe('glyphsFor', () => {
  it('is referentially stable per capability tier', () => {
    const caps = { colorLevel: 3, unicode: true } as const;
    expect(glyphsFor(caps)).toBe(pickGlyphs(caps));
    expect(glyphsFor(caps)).toBe(glyphsFor({ colorLevel: 1, unicode: true }));
  });
});
