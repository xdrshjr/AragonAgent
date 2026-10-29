/**
 * The quick-prompt library's data model (quick-prompt-library §6.1).
 *
 * ASCII ONLY - `src/prompts/**` is inside `glyphs.test.ts::inScope`. Chinese copy
 * lives in `copy.ts` as `\uXXXX` escapes, never as literal text in this tree.
 *
 * THE DISK SHAPE IS THE ONLY TRUTH (D-3 / I-6). `App` holds a `PromptLibrary`
 * snapshot for rendering, every mutation goes through `store.ts`, and the store
 * hands the new snapshot back. No component computes an optimistic library of its
 * own, because "the UI says it was added and the disk disagrees" is a failure
 * mode with no error message.
 */

/**
 * One entry.
 *
 * `useCount` / `createdAt` / `updatedAt` are ALWAYS present: a missing number
 * would make every consumer write `?? 0` and one of them would eventually forget.
 * `description` / `tags` / `favorite` / `lastUsedAt` are optional because "absent"
 * is their honest state.
 */
export interface QuickPrompt {
  /** `randomUUID()`. Never shown in full; the list uses an 8-character prefix. */
  id: string;
  /** 1..80 code points, trimmed, no control characters. Never empty (I-5). */
  title: string;
  /** 1..8000 code points. Original newlines preserved; `\r\n` normalised to `\n`. */
  content: string;
  /** 0..200 code points. */
  description?: string;
  /** 0..6 tags, each 0..24 code points. */
  tags?: string[];
  favorite?: boolean;
  /** Monotonic per entry (I-4). */
  useCount: number;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
}

/**
 * The whole library.
 *
 * `prompts` IS the manual order (I-1): index 0 is what the list shows first and
 * what `Ctrl+Up/Down` rearranges. There is no `order` field, because a second
 * ordering authority is a second thing that can disagree with the first.
 */
export interface PromptLibrary {
  schema: 1;
  prompts: QuickPrompt[];
  /** Epoch ms of the last successful write; strictly increasing (I-3). */
  updatedAt: number;
}

/**
 * The persistent re-orderings `/prompts sort <key>` can name (D-9).
 *
 * A WRITE key, not a view: `PromptSortView` is what the picker renders and never
 * persists, this is what the user may ask to have rewritten on disk. They overlap by two
 * words and are deliberately separate types, because "sort by recent" and "show me the
 * recent order for a moment" are different promises.
 */
export type PromptSortKey = 'name' | 'recent' | 'favorite';

/** The picker's three presentations. A VIEW: never persisted (D-9). */
export type PromptSortView = 'manual' | 'recent' | 'favorite';

/**
 * Why a write or a lookup failed. A stable code, never a sentence: the sentence
 * comes from `copy.ts`, so the same failure has one wording on every surface.
 */
export type PromptWriteError =
  | 'title_required'
  | 'content_required'
  | 'title_too_long'
  | 'content_too_long'
  | 'description_too_long'
  | 'tag_too_long'
  | 'too_many_tags'
  | 'too_many_prompts'
  | 'not_found'
  | 'ambiguous'
  | 'write_failed';

/**
 * The result of one mutation.
 *
 * THE LIBRARY TRAVELS WITH THE FAILURE TOO, and that is deliberate: a
 * `write_failed` still applied in memory (D-4), so the caller has to be able to
 * render what the user just created rather than pretending nothing happened.
 */
export type PromptMutationResult =
  | { ok: true; library: PromptLibrary; id?: string }
  | { ok: false; code: PromptWriteError; library: PromptLibrary };

/**
 * A one-shot hand-off into the manager overlay (D-21).
 *
 * `App` never edits the overlay's state directly; it hands over an intent, and the
 * overlay consumes it exactly once by nonce. That is what makes `/prompts edit 2`
 * land in the editor with a prefilled draft instead of on row 0 of the list.
 */
export type PromptLibraryEntry =
  | { kind: 'list'; focusId?: string }
  | { kind: 'create'; seed?: { title?: string; content?: string } }
  | { kind: 'edit'; id: string }
  | { kind: 'delete'; id: string };

/** `nonce` is monotonic; the same value is consumed at most once (I-8). */
export interface PromptLibraryIntent {
  nonce: number;
  entry: PromptLibraryEntry;
}

/**
 * `<n|title>` resolved to an entry (D-22).
 *
 * `ambiguous` CARRIES ITS CANDIDATES. Titles may repeat (I-2), and a lookup that
 * failed without saying which entries matched would leave the user with nothing
 * to type next - which is exactly how `/prompts rm <title>` deletes the wrong
 * prompt, and there is no recycle bin (D-13).
 */
export type PromptRefResolution =
  | { ok: true; prompt: QuickPrompt }
  | { ok: false; code: 'not_found' }
  | { ok: false; code: 'ambiguous'; candidates: QuickPrompt[] };

/**
 * The editable form of one entry.
 *
 * `id: null` means "not saved yet". `tags` is the RAW field text: parsing it on
 * every keystroke would rewrite what the user is typing as they type it.
 */
export interface PromptEditorDraft {
  id: string | null;
  title: string;
  content: string;
  description: string;
  tags: string;
  favorite: boolean;
}

/** The three things the manager overlay may ask the store to do (P2-1: idempotent). */
export type PromptLibraryMutation =
  | { kind: 'create'; draft: PromptEditorDraft }
  | { kind: 'update'; id: string; draft: PromptEditorDraft }
  | { kind: 'delete'; id: string }
  | { kind: 'move'; id: string; delta: -1 | 1 }
  | { kind: 'favorite'; id: string; favorite: boolean };

/**
 * What a command (or the picker) may ask the host to do (§6.3 / P1-3).
 *
 * THREE METHODS, and each one is something the command layer genuinely cannot do
 * itself: open a surface, hand that surface a payload, or read the library through
 * the same resolver the user's typing is interpreted with. Everything else
 * (notifications, toasts, overlays in general) already exists on `CommandContext`
 * and is not repeated here.
 */
export interface PromptCommandPort {
  /** Open the picker (`overlay: 'prompt-pick'`). */
  openPicker(): void;
  /** Open the manager on a specific page, with an optional prefilled draft. */
  openManager(entry: PromptLibraryEntry): void;
  /** `<n|title>` -> entry, through `resolvePromptRef` (D-22). */
  resolve(ref: string): PromptRefResolution;
}

/** A validated draft, ready for the store. Produced by `finishPromptEditor`. */
export interface PromptDraftInput {
  title: string;
  content: string;
  description?: string;
  tags?: string[];
  favorite?: boolean;
}

/**
 * The verdict of validating a draft (§4.4 / D-12).
 *
 * `field` is the row that should own focus after a refusal, so the editor can jump
 * there instead of leaving the user staring at a footer with an error code in it.
 */
export type PromptDraftVerdict =
  | { ok: true; input: PromptDraftInput }
  | { ok: false; code: PromptWriteError; field: 'title' | 'content' | 'description' | 'tags' };
