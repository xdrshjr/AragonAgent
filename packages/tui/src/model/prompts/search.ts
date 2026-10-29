/**
 * Filtering and view ordering for the picker (quick-prompt-library D-9 / D-10).
 *
 * ASCII ONLY - `src/prompts/**` is inside `glyphs.test.ts::inScope`.
 *
 * SUBSEQUENCE MATCHING, NOT SUBSTRING MATCHING. `clr` should find `clean code
 * review`, and Chinese titles make the same demand in a different shape: the
 * characters a user remembers are rarely contiguous. The query is matched
 * case-insensitively against the title, then the tags, then the description, and
 * the FIELD a match landed in is a stronger signal than how good the match was.
 *
 * NO CHARACTER HIGHLIGHTING (D-10). Colouring the matched characters would mean
 * splitting a row into styled runs, and every row in this package is one
 * `wrap="truncate"` `<Text>` precisely so its height is exactly one row. The
 * detail block answers "why did this match" instead.
 */

import type { QuickPrompt, PromptSortView } from './types.js';

/** How much worse a match in tags, or in the description, is than in the title. */
const TAG_PENALTY = 1_000;
const DESCRIPTION_PENALTY = 2_000;

/**
 * Greedy subsequence match; `null` when `query` is not a subsequence of `text`.
 *
 * The score is LOWER-is-better and is built from what a reader would actually
 * call a good match: how early the first hit is, how tightly the hits cluster,
 * and how many characters had to be skipped between them.
 */
export function subsequenceScore(text: string, query: string): number | null {
  if (query.length === 0) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let at = 0;
  let first = -1;
  let last = -1;
  let gaps = 0;
  for (const char of needle) {
    const hit = haystack.indexOf(char, at);
    if (hit === -1) return null;
    if (first === -1) first = hit;
    else if (hit > last + 1) gaps += hit - last - 1;
    last = hit;
    at = hit + 1;
  }
  const span = last - first + 1;
  return first * 4 + gaps * 2 + (span - needle.length);
}

function fieldScore(prompt: QuickPrompt, query: string): number | null {
  const title = subsequenceScore(prompt.title, query);
  if (title !== null) return title;
  let best: number | null = null;
  for (const tag of prompt.tags ?? []) {
    const score = subsequenceScore(tag, query);
    if (score !== null && (best === null || score < best)) best = score;
  }
  if (best !== null) return TAG_PENALTY + best;
  const description = prompt.description;
  if (description === undefined) return null;
  const score = subsequenceScore(description, query);
  return score === null ? null : DESCRIPTION_PENALTY + score;
}

/**
 * Filter, but NEVER REORDER BEYOND WHAT THE QUERY EARNS.
 *
 * Ties keep the library's own order, because a filter that reshuffles entries with
 * equal scores makes the list move under the user's arrow keys while they type.
 * Favourites win ties, which is the only preference the picker states.
 */
export function searchPrompts(
  prompts: readonly QuickPrompt[],
  query: string,
): { prompt: QuickPrompt; score: number }[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return prompts.map((prompt) => ({ prompt, score: 0 }));
  const hits: { prompt: QuickPrompt; score: number; at: number }[] = [];
  for (let at = 0; at < prompts.length; at += 1) {
    const prompt = prompts[at]!;
    const score = fieldScore(prompt, trimmed);
    if (score !== null) hits.push({ prompt, score, at });
  }
  hits.sort((a, b) => {
    const favourite = (b.prompt.favorite === true ? 1 : 0) - (a.prompt.favorite === true ? 1 : 0);
    if (favourite !== 0) return favourite;
    if (a.score !== b.score) return a.score - b.score;
    return a.at - b.at;
  });
  return hits.map(({ prompt, score }) => ({ prompt, score }));
}

/**
 * The three presentations (D-9).
 *
 * `manual` is the only persisted order; the other two are VANISHING views. The one
 * that rearranges is `favorite` - `recent` sorts by `lastUsedAt` only, so an entry
 * that has never been used keeps its place at the tail instead of jumping around
 * while the user watches.
 */
export function viewOrder(
  prompts: readonly QuickPrompt[],
  view: PromptSortView,
): QuickPrompt[] {
  if (view === 'manual') return [...prompts];
  const indexed = prompts.map((prompt, at) => ({ prompt, at }));
  if (view === 'favorite') {
    indexed.sort((a, b) => {
      const favourite = (b.prompt.favorite === true ? 1 : 0) - (a.prompt.favorite === true ? 1 : 0);
      return favourite !== 0 ? favourite : a.at - b.at;
    });
    return indexed.map(({ prompt }) => prompt);
  }
  indexed.sort((a, b) => {
    const recent = (b.prompt.lastUsedAt ?? 0) - (a.prompt.lastUsedAt ?? 0);
    return recent !== 0 ? recent : a.at - b.at;
  });
  return indexed.map(({ prompt }) => prompt);
}

/** The next view in the `Ctrl+S` cycle (manual -> recent -> favorite -> manual). */
export function nextView(view: PromptSortView): PromptSortView {
  if (view === 'manual') return 'recent';
  if (view === 'recent') return 'favorite';
  return 'manual';
}

/**
 * Title order, for the `/prompts sort name` write.
 *
 * A TOTAL order (title, then id): a sort the user asked for has to be reproducible, and
 * two entries sharing a title would otherwise swap places between runs - a "sorted"
 * library that reorders itself on every read is worse than an unsorted one. Code-unit
 * comparison rather than `localeCompare`, because the file is written on one machine and
 * read on the next, and a locale-dependent order would silently rewrite the user's
 * sequence on a different machine for no reason they could see.
 */
export function sortedPromptTitleOrder(prompts: readonly QuickPrompt[]): QuickPrompt[] {
  const compare = (a: QuickPrompt, b: QuickPrompt): number => {
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  return [...prompts].sort(compare);
}
