/**
 * Pure prompt-draft validation, split out of `store.ts` (tui-package-split S3).
 *
 * ASCII ONLY - `src/prompts/**` is inside `glyphs.test.ts::inScope`.
 *
 * NO I/O. The prompt-library editor (a terminal-UI view model) calls these on every keystroke
 * to decide which field owns an error, while the store that persists the library also reads
 * and writes files. Splitting them lets the editor live in a package without filesystem
 * persistence. `store.ts` re-exports both names, so every existing importer is unchanged.
 */

import { PROMPT_LIMITS } from './limits.js';
import type { PromptDraftInput, PromptDraftVerdict } from './types.js';

export function codePoints(text: string): number {
  return [...text].length;
}

/**
 * Validate one draft, at the boundary where a draft becomes data (I-5).
 *
 * The editor calls this too, so the code that decides "that title is too long" and
 * the code that decides which ROW owns the error cannot disagree - which is why it
 * lives here rather than in the view model.
 */
export function validatePromptDraft(input: PromptDraftInput): PromptDraftVerdict {
  const title = input.title.trim();
  const content = input.content;
  if (title.length === 0) return { ok: false, code: 'title_required', field: 'title' };
  if (codePoints(title) > PROMPT_LIMITS.titleMaxChars) {
    return { ok: false, code: 'title_too_long', field: 'title' };
  }
  if (content.trim().length === 0) return { ok: false, code: 'content_required', field: 'content' };
  if (codePoints(content) > PROMPT_LIMITS.contentMaxChars) {
    return { ok: false, code: 'content_too_long', field: 'content' };
  }
  const description = (input.description ?? '').trim();
  if (codePoints(description) > PROMPT_LIMITS.descriptionMaxChars) {
    return { ok: false, code: 'description_too_long', field: 'description' };
  }
  const tags = input.tags ?? [];
  if (tags.length > PROMPT_LIMITS.maxTags) {
    return { ok: false, code: 'too_many_tags', field: 'tags' };
  }
  if (tags.some((tag) => codePoints(tag) > PROMPT_LIMITS.tagMaxChars)) {
    return { ok: false, code: 'tag_too_long', field: 'tags' };
  }
  const verdict: PromptDraftInput = { title, content };
  if (description.length > 0) verdict.description = description;
  if (tags.length > 0) verdict.tags = [...tags];
  if (input.favorite === true) verdict.favorite = true;
  return { ok: true, input: verdict };
}

/** Parsed tags from the editor's raw comma/space separated field. Never throws. */
export function parsePromptTags(raw: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const tag = part.trim();
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= PROMPT_LIMITS.maxTags) break;
  }
  return tags;
}
