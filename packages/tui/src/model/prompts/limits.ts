/**
 * Structural bounds for the quick-prompt library (quick-prompt-library §5.1).
 *
 * ASCII ONLY - `src/prompts/**` is inside `glyphs.test.ts::inScope`.
 *
 * STRUCTURE, NOT POLICY (index.md:52-56). Nothing here is user-tunable: these are
 * what an entry, the library and the picker's query can physically carry. The
 * three keys a user may actually change (`prompts.enabled`, `insertMode`, `hint`)
 * live in `config/schema.ts`, are clamped there, and are persisted there. Mixing
 * the two is how a "temporary" ceiling becomes a setting nobody clamps.
 *
 * EVERY NUMBER IS A CODE-POINT COUNT, not a byte count and not a UTF-16 length.
 * Titles and bodies are typed in Chinese by the users this feature exists for, so
 * a byte-based ceiling would silently allow a third of the characters a
 * Latin-alphabet user gets. `[...text].length` is the measurement everywhere in
 * this tree.
 */
export const PROMPT_LIMITS = {
  /** Entries one library may hold. The 201st create is REFUSED, never truncated. */
  maxPrompts: 200,
  /** Title, without surrounding whitespace. */
  titleMaxChars: 80,
  /** Body. Large enough for a 40-line procedure, small enough to rewrite cheaply. */
  contentMaxChars: 8000,
  /** Optional one-line note under the title. */
  descriptionMaxChars: 200,
  /** Tags per entry. */
  maxTags: 6,
  /** Characters per tag. */
  tagMaxChars: 24,
  /** Body preview lines the list page's detail block may spend (read-only). */
  detailPreviewLines: 3,
  /** Rows the list page's detail block may occupy, preview lines included. */
  detailMaxLines: 6,
  /** Characters of a body shown on ONE preview line. */
  previewLineChars: 72,
} as const;

/**
 * The picker's own structural bounds.
 *
 * A SEPARATE OBJECT because the picker is a separate surface with a separate
 * budget: its rows carry an index and a title and nothing else, and its query is
 * a filter rather than content. Sharing one object would tie a future change to
 * the library's row height.
 */
export const PROMPT_PICKER_LIMITS = {
  /** Longest query the filter accepts; further typing is ignored. */
  queryMaxChars: 64,
  /** `1`-`9` pick directly, so nine. */
  quickDigits: 9,
  /** Rows the picker's detail block may occupy. */
  detailMaxLines: 4,
} as const;
