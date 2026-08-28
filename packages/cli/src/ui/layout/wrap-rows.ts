/**
 * `wrapToRows` — the prose wrapper for `OverlayFrame`'s controlled (mode A)
 * content (plan-mode §6.6).
 *
 * Mode A's contract is *one element per row, each already `wrap="truncate"`*,
 * and `sliceWindow` counts ELEMENTS, not lines. Help and Settings satisfy that
 * naturally because their content is a list of short rows. A plan is not: its
 * summary runs to 600 characters and a step detail to 400, so handing either
 * over as a single `<Text>` renders the whole paragraph as one truncated line —
 * the single worst failure available to a plan review card, and one that also
 * makes the frame's `1-14/22` position indicator a false statement.
 *
 * The repo had no wrapper before this (no `wrapText`, no `wordWrap`), so here is
 * one: pure, no Ink, unit-tested.
 */

/**
 * Break `text` into lines of at most `width` columns.
 *
 * Prefers spaces; hard-breaks any single token longer than `width` (a URL or a
 * long path, which must not be dropped and cannot be wrapped politely).
 * Existing newlines are honoured as paragraph breaks. Returns `[]` for empty
 * input so callers can splice the result without an emptiness branch.
 */
export function wrapToRows(text: string, width: number): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const limit = Math.max(1, Math.floor(width));

  const rows: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (paragraph.trim().length === 0) {
      // A blank line in the source is a deliberate separator; keep it as a row
      // rather than collapsing it, or the summary and the steps run together.
      rows.push('');
      continue;
    }
    rows.push(...wrapParagraph(paragraph, limit));
  }
  return rows;
}

function wrapParagraph(paragraph: string, limit: number): string[] {
  const rows: string[] = [];
  let current = '';

  for (const word of paragraph.split(/\s+/).filter((w) => w.length > 0)) {
    if (word.length > limit) {
      // Flush what we have, then chop the over-long token into full-width
      // pieces. Its tail becomes the new `current` so the next word can still
      // join it.
      if (current.length > 0) {
        rows.push(current);
        current = '';
      }
      let rest = word;
      while (rest.length > limit) {
        rows.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      current = rest;
      continue;
    }

    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= limit) {
      current = `${current} ${word}`;
    } else {
      rows.push(current);
      current = word;
    }
  }

  if (current.length > 0) rows.push(current);
  return rows;
}
