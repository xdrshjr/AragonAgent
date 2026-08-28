/**
 * Render caches (tui-render-performance L2 / R2 + R3).
 *
 * Ink has no output caching: every frame re-walks the whole mounted tree,
 * re-measures every text node and re-serialises the frame. The two most
 * expensive PURE computations in that walk were being redone from scratch on
 * every one of them:
 *
 *   - `cli-highlight`'s `highlight()` ran INSIDE `CodeBlock`'s render body, so a
 *     200-line fenced block was a complete highlight.js tokenise, 30 times a
 *     second, for as long as it stayed mounted;
 *   - `Markdown` re-split and re-regexed the whole answer into one React element
 *     per line on every render.
 *
 * Everything cached here is a function of its INPUT STRING ALONE. Theme and
 * glyphs are applied at render time and are never cached, because a themed
 * React element in a cache makes `/theme` a no-op until the entry evicts (K-5) —
 * exactly the class of silent bug this package writes comments to avoid.
 *
 * Caches are MODULE-LEVEL on purpose: settled transcript text is identical
 * across component instances and across mount/unmount cycles, so per-instance
 * caches would miss precisely when a scroll brings an old entry back.
 */

import { highlight } from 'cli-highlight';
import { parseMarkdownBlocks, type MdBlock } from './markdown-blocks.js';
import { pickGlyphs, type Glyphs } from './glyphs.js';
import type { TermCapabilities } from './capabilities.js';

export const RENDER_CACHE_LIMITS = {
  highlightEntries: 128,
  highlightBytes: 2 * 1024 * 1024,
  /**
   * Above this, skip highlighting entirely.
   *
   * highlight.js is superlinear in the length of a single block, and a
   * multi-megabyte "code block" is almost always a pasted log rather than
   * source. Rendering it plain costs the user nothing they would have been able
   * to read; tokenising it costs the whole frame budget.
   */
  highlightMaxChars: 20_000,
  markdownEntries: 256,
  markdownBytes: 4 * 1024 * 1024,
  linesEntries: 512,
} as const;

export interface RenderCacheStats {
  markdownEntries: number;
  markdownBytes: number;
  highlightEntries: number;
  highlightBytes: number;
  lineEntries: number;
  hits: number;
  misses: number;
}

/**
 * Insertion-ordered LRU with both an entry-count and an approximate byte budget.
 *
 * TWO BUDGETS, NOT ONE. An entry count alone is unbounded in memory (one 5 MB
 * answer), and a byte budget alone is unbounded in Map overhead (a hundred
 * thousand one-character keys). Every cache here can be fed by the model, so
 * both directions have to be closed.
 */
class LruCache<V> {
  private readonly map = new Map<string, { value: V; bytes: number }>();
  private total = 0;
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (hit === undefined) {
      this.misses += 1;
      return undefined;
    }
    // Re-insert to move the key to the young end of the insertion order.
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits += 1;
    return hit.value;
  }

  set(key: string, value: V, bytes: number): V {
    const existing = this.map.get(key);
    if (existing) this.total -= existing.bytes;
    this.map.delete(key);
    this.map.set(key, { value, bytes });
    this.total += bytes;
    while (this.map.size > this.maxEntries || this.total > this.maxBytes) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      const entry = this.map.get(oldest.value);
      if (entry) this.total -= entry.bytes;
      this.map.delete(oldest.value);
    }
    return value;
  }

  clear(): void {
    this.map.clear();
    this.total = 0;
    this.hits = 0;
    this.misses = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.total;
  }
}

const highlightCache = new LruCache<string>(
  RENDER_CACHE_LIMITS.highlightEntries,
  RENDER_CACHE_LIMITS.highlightBytes,
);

const markdownCache = new LruCache<MdBlock[]>(
  RENDER_CACHE_LIMITS.markdownEntries,
  RENDER_CACHE_LIMITS.markdownBytes,
);

/**
 * `text.split('\n')` results.
 *
 * Bounded by ENTRY COUNT ONLY, and the byte budget is set to the markdown one
 * because the arrays are views over strings the transcript already holds — they
 * add pointer overhead, not a second copy of the text.
 */
const lineCache = new LruCache<readonly string[]>(
  RENDER_CACHE_LIMITS.linesEntries,
  RENDER_CACHE_LIMITS.markdownBytes,
);

/**
 * Syntax-highlight `code`, memoised on `(lang, code)`.
 *
 * `cli-highlight` emits chalk-level ANSI that does not depend on `theme.*`, so
 * unlike a rendered element this string IS safe to cache across a `/theme`
 * switch — the same property it has had since before this cache existed.
 */
export function highlightCached(code: string, lang: string): string {
  if (code.length === 0) return code;
  if (code.length > RENDER_CACHE_LIMITS.highlightMaxChars) return code;
  // The delimiter is written as an ESCAPE and never as a literal control
  // character: a raw NUL byte makes the whole file "binary" to grep and
  // ripgrep, which silently hides every definition in it from the tool this
  // codebase navigates itself with. NUL rather than a space because a space
  // still lets ("a b", "ts") and ("b", "ts a") collide on one key.
  const key = `${lang}\u0000${code}`;
  const hit = highlightCache.get(key);
  if (hit !== undefined) return hit;
  let rendered = code;
  try {
    rendered = highlight(code, { language: lang || undefined, ignoreIllegals: true });
  } catch {
    rendered = code;
  }
  return highlightCache.set(key, rendered, key.length + rendered.length);
}

/** Parse a markdown document into blocks, memoised on the whole text. */
export function parseMarkdownCached(text: string): MdBlock[] {
  const hit = markdownCache.get(text);
  if (hit !== undefined) return hit;
  return markdownCache.set(text, parseMarkdownBlocks(text), text.length * 2);
}

/**
 * `text.split('\n')`, memoised.
 *
 * READ-ONLY BY CONTRACT. The returned array is shared with every other holder of
 * the same string, so a caller that sorts or splices it in place corrupts an
 * unrelated card. The `readonly string[]` return type is the enforcement.
 */
export function splitLinesCached(text: string): readonly string[] {
  if (text.length === 0) return EMPTY_LINES;
  const hit = lineCache.get(text);
  if (hit !== undefined) return hit;
  return lineCache.set(text, text.split('\n'), text.length);
}

const EMPTY_LINES: readonly string[] = [];

/**
 * The glyph set for a terminal.
 *
 * `pickGlyphs` already returns one of two module constants, so this adds no
 * caching of its own — it exists so that every render-layer memoisation the
 * transcript depends on is reachable from one module, and so the components can
 * stop calling `pickGlyphs` once per entry per frame through six import paths.
 */
export function glyphsFor(caps: TermCapabilities): Glyphs {
  return pickGlyphs(caps);
}

/** Drop everything. `/perf reset`, and the test suite between cases. */
export function clearRenderCaches(): void {
  highlightCache.clear();
  markdownCache.clear();
  lineCache.clear();
}

export function renderCacheStats(): RenderCacheStats {
  return {
    markdownEntries: markdownCache.size,
    markdownBytes: markdownCache.bytes,
    highlightEntries: highlightCache.size,
    highlightBytes: highlightCache.bytes,
    lineEntries: lineCache.size,
    hits: markdownCache.hits + highlightCache.hits + lineCache.hits,
    misses: markdownCache.misses + highlightCache.misses + lineCache.misses,
  };
}
