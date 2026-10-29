/**
 * Highlighting find matches with the CSS Custom Highlight API (Chromium >= 105; Electron 45 has it).
 * Ranges are built over the TEXT NODES of the one row that holds the current match, so the DOM is
 * never modified and a virtualised row unmounting leaves nothing behind but a stale `Range`, which
 * `clearHighlights` drops. Without the API the caller falls back to an outline on the row.
 */

type HighlightCtor = new (...ranges: Range[]) => unknown;

interface HighlightRegistry {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  return css?.highlights ?? null;
}

function highlightCtor(): HighlightCtor | null {
  return (globalThis as { Highlight?: HighlightCtor }).Highlight ?? null;
}

export const HIGHLIGHT_MATCH = 'find-match';
export const HIGHLIGHT_CURRENT = 'find-current';

export function supportsHighlights(): boolean {
  return registry() !== null && highlightCtor() !== null;
}

export function clearHighlights(): void {
  const highlights = registry();
  highlights?.delete(HIGHLIGHT_MATCH);
  highlights?.delete(HIGHLIGHT_CURRENT);
}

/** Every occurrence of `needle` (case-insensitive) inside `row`, as DOM ranges, in document order. */
export function rangesIn(row: Element, needle: string): Range[] {
  const lowered = needle.toLocaleLowerCase();
  const ranges: Range[] = [];
  if (lowered === '') return ranges;
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLocaleLowerCase();
    // A lower-casing that changes length (rare Unicode) would shift offsets; skip such nodes.
    if (text.length !== (node.nodeValue ?? '').length) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(lowered, from);
      if (at === -1) break;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + lowered.length);
      ranges.push(range);
      from = at + Math.max(1, lowered.length);
    }
  }
  return ranges;
}

/**
 * Highlight the matches in `row`, marking occurrence number `current` as the current one.
 * Returns the current range (so the caller can scroll it into view), or null when the row holds fewer
 * occurrences than expected (markdown can hide or split text the plain-text search saw).
 */
export function highlightRow(row: Element, needle: string, current: number): Range | null {
  clearHighlights();
  const ranges = rangesIn(row, needle);
  if (ranges.length === 0) return null;
  const target = ranges[Math.min(current, ranges.length - 1)] ?? null;
  const highlights = registry();
  const Highlight = highlightCtor();
  if (highlights && Highlight && target) {
    highlights.set(HIGHLIGHT_MATCH, new Highlight(...ranges));
    highlights.set(HIGHLIGHT_CURRENT, new Highlight(target));
  }
  return target;
}
