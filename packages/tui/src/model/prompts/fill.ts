/**
 * How a prompt lands in the composer (quick-prompt-library D-6 / §4.6).
 *
 * ASCII ONLY - `src/prompts/**` is inside `glyphs.test.ts::inScope`.
 *
 * PURE, AND IT KNOWS NOTHING ABOUT THE DRAFT'S REAL SHAPE. It is handed the current
 * buffer and caret, and it answers "what should be inserted, or what should the new
 * buffer be". It deliberately does NOT return the resulting buffer: a draft may
 * hold paste-collapse TOKENS (`[Pasted text #1 +8 lines]` plus a payload map), so
 * "the buffer after applying this plan" is a fact only `editorReducer` can compute.
 * Recomputing it here would be a second authority, and the two would drift exactly
 * on the drafts this feature exists to append to.
 *
 * WHY `insert` IS THE DEFAULT (and why the decision lives here rather than in
 * `App`): the only place that knows what the draft currently holds is the editor
 * (the host has no copy of the text), and silently discarding what someone has
 * already typed is the one thing a "fill" gesture must never do.
 */

/** Two newlines, so the typed text and the prompt read as two paragraphs. */
const SEPARATOR = '\n\n';

export interface PromptFillInput {
  /** The current draft buffer. */
  draft: string;
  /** Caret offset into `draft`, in UTF-16 units. */
  cursor: number;
  /** The prompt body. */
  content: string;
  /** `insert` unless the user configured `prompts.insertMode = 'replace'` (D-19). */
  mode?: 'insert' | 'replace';
}

export interface PromptFillPlan {
  mode: 'replace' | 'insert';
  /**
   * `replace`: the new buffer in full.
   * `insert`: only the fragment to insert, separators included.
   */
  text: string;
  /**
   * `replace`: where the caret goes afterwards (past the body).
   * `insert`: ignored - the reducer owns the caret and the token snapping.
   */
  cursor: number;
}

/**
 * Decide between replacing and inserting, and build the fragment.
 *
 * A blank draft is replaced even in `insert` mode: "insert at the caret" into an
 * empty buffer and "replace the empty buffer" are the same edit, and saying so
 * keeps the caller from having to special-case it.
 */
export function planPromptFill(input: PromptFillInput): PromptFillPlan {
  const cursor = Math.max(0, Math.min(input.draft.length, Math.floor(input.cursor)));
  const blank = input.draft.trim().length === 0;
  if (input.mode === 'replace' || blank) {
    return { mode: 'replace', text: input.content, cursor: input.content.length };
  }
  const before = input.draft.slice(0, cursor);
  const after = input.draft.slice(cursor);
  // A SEPARATOR IS ADDED ONLY WHERE ONE IS MISSING, which is what keeps the plan
  // from producing three newlines when the caret already sits on a blank line.
  const lead = before.length > 0 && !before.endsWith(SEPARATOR) ? SEPARATOR : '';
  const trail = after.length > 0 && !after.startsWith(SEPARATOR) ? SEPARATOR : '';
  const text = `${lead}${input.content}${trail}`;
  return { mode: 'insert', text, cursor: cursor + lead.length };
}

/** Lines a body occupies, for the "8 lines, editable" acknowledgement. */
export function promptLineCount(content: string): number {
  return content.split('\n').length;
}
