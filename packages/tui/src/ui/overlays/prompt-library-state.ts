/**
 * The prompt manager's state machine and view models (quick-prompt-library §4.4).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`. Every sentence the
 * user reads comes from `prompts/copy.ts`; nothing in this file may hold a literal
 * non-ASCII byte.
 *
 * WHY A PURE REDUCER AND NOT `useState` INSIDE THE COMPONENT: the page stack has two
 * transitions that are easy to get wrong and impossible to see on screen - "the
 * second Esc discards, the first does not" and "the intent is consumed exactly
 * once" - and both are assertions, not screenshots. Everything below can be driven
 * from a test with no Ink mounted.
 */

import { PROMPT_LIMITS } from '../../model/prompts/limits.js';
import { parsePromptTags, validatePromptDraft } from '../../model/prompts/validate.js';
import type {
  PromptDraftInput,
  PromptDraftVerdict,
  PromptEditorDraft,
  PromptLibrary,
  PromptLibraryEntry,
  PromptWriteError,
  QuickPrompt,
} from '../../model/prompts/types.js';
// The list's read-only preview is the ONE place `wrapToRows` belongs: it is a prose
// wrapper, so it would destroy the caret-to-cell mapping in an editable field
// (D-11), and there is no caret here.
import { wrapToRows } from '../layout/wrap-rows.js';

export type PromptLibraryPage = 'list' | 'editor' | 'delete';

/** The six rows `Tab` cycles on the editor page, in visual order. */
export const PROMPT_EDITOR_FIELDS = [
  'title', 'content', 'description', 'tags', 'save', 'cancel',
] as const;

export type PromptEditorField = (typeof PROMPT_EDITOR_FIELDS)[number];

export interface PromptLibraryState {
  page: PromptLibraryPage;
  /** Focus index on the list page (clamped by the view). */
  index: number;
  /**
   * Id the focus should land on when the list is next drawn.
   *
   * BY ID, NEVER BY POSITION: a create appends and an edit does not move the entry,
   * but a delete shifts every row after it, and "focus row 3" would then point at a
   * different prompt than the one the user was working on.
   */
  focusId: string | null;
  draft: PromptEditorDraft;
  /** The entry the draft was seeded from, so `dirty` is a comparison, not a guess. */
  baseline: PromptEditorDraft | null;
  /** The first Esc on a dirty editor arms the discard; any edit disarms it. */
  escArmed: boolean;
  pendingDeleteId: string | null;
  error: PromptWriteError | null;
  /** The row that should own focus after a refusal (D-12). */
  errorField: PromptEditorField | null;
  /** Highest intent nonce this overlay has acted on (I-8). */
  consumedIntentNonce: number;
}

export type PromptLibraryAction =
  | { type: 'init'; entry: PromptLibraryEntry; library: PromptLibrary; nonce: number }
  | { type: 'list'; focusId?: string }
  | { type: 'focus'; index: number }
  | { type: 'create'; seed?: { title?: string; content?: string } }
  | { type: 'edit'; id: string; library: PromptLibrary }
  | { type: 'delete'; id: string }
  | { type: 'draft'; patch: Partial<PromptEditorDraft> }
  | { type: 'commit'; id: string | null }
  | { type: 'failed'; code: PromptWriteError; field?: PromptEditorField }
  | { type: 'esc' }
  | { type: 'cancelled' };

/** A new, empty draft. `id: null` is what makes `Save` a create rather than an update. */
export const EMPTY_PROMPT_DRAFT: PromptEditorDraft = {
  id: null,
  title: '',
  content: '',
  description: '',
  tags: '',
  favorite: false,
};

export const INITIAL_PROMPT_LIBRARY_STATE: PromptLibraryState = {
  page: 'list',
  index: 0,
  focusId: null,
  draft: EMPTY_PROMPT_DRAFT,
  baseline: null,
  escArmed: false,
  pendingDeleteId: null,
  error: null,
  errorField: null,
  consumedIntentNonce: 0,
};

/** The editable projection of a stored entry. */
export function draftFromEntry(entry: QuickPrompt): PromptEditorDraft {
  return {
    id: entry.id,
    title: entry.title,
    content: entry.content,
    description: entry.description ?? '',
    tags: (entry.tags ?? []).join(' '),
    favorite: entry.favorite === true,
  };
}

/** A create draft seeded from a command (`/prompts add title :: body`). */
export function seededDraft(seed?: { title?: string; content?: string }): PromptEditorDraft {
  return {
    ...EMPTY_PROMPT_DRAFT,
    title: seed?.title ?? '',
    content: seed?.content ?? '',
  };
}

/** Structural equality is enough: every field is a string or a boolean. */
export function draftIsDirty(
  draft: PromptEditorDraft,
  baseline: PromptEditorDraft | null,
): boolean {
  if (baseline === null) {
    return draft.title.length > 0 || draft.content.length > 0
      || draft.description.length > 0 || draft.tags.length > 0;
  }
  return draft.title !== baseline.title || draft.content !== baseline.content
    || draft.description !== baseline.description || draft.tags !== baseline.tags
    || draft.favorite !== baseline.favorite;
}

/**
 * Validate a draft and turn it into what the store accepts (D-12).
 *
 * THE VALIDATOR IS `store.ts`'S, not a second copy here: the sentence the editor
 * shows and the rule the write applies have to be the same rule, or a user can be
 * told a title is fine by the form and refused by the store.
 */
export function finishPromptEditor(draft: PromptEditorDraft): PromptDraftVerdict {
  return validatePromptDraft({
    title: draft.title,
    content: draft.content,
    description: draft.description,
    tags: parsePromptTags(draft.tags),
    favorite: draft.favorite,
  });
}

/** Index of the first focusable row, for a refusal that named a field. */
export function fieldIndex(field: PromptEditorField | null): number {
  if (field === null) return 0;
  const at = PROMPT_EDITOR_FIELDS.indexOf(field);
  return at < 0 ? 0 : at;
}

function enterEditor(
  state: PromptLibraryState,
  draft: PromptEditorDraft,
  baseline: PromptEditorDraft | null,
): PromptLibraryState {
  return {
    ...state,
    page: 'editor',
    draft,
    baseline,
    escArmed: false,
    error: null,
    errorField: null,
  };
}

/**
 * The reducer.
 *
 * `init` is the ONLY action that can jump straight to the editor or the delete page:
 * that is what makes `/prompts edit 2` land where it should (D-21). The intent's
 * nonce is stored as `consumedIntentNonce` by the component before dispatching, so a
 * replayed intent is a no-op at the component, not a second edit here.
 */
export function promptLibraryReducer(
  state: PromptLibraryState,
  action: PromptLibraryAction,
  library: PromptLibrary,
): PromptLibraryState {
  switch (action.type) {
    case 'init': {
      if (action.nonce <= state.consumedIntentNonce) return state;
      const consumed = { ...state, consumedIntentNonce: action.nonce };
      const entry = action.entry;
      if (entry.kind === 'create') {
        return enterEditor(consumed, seededDraft(entry.seed), null);
      }
      if (entry.kind === 'edit') {
        const found = action.library.prompts.find((prompt) => prompt.id === entry.id);
        if (!found) return { ...consumed, page: 'list', focusId: null };
        const draft = draftFromEntry(found);
        return enterEditor(consumed, draft, { ...draft });
      }
      if (entry.kind === 'delete') {
        const found = action.library.prompts.find((prompt) => prompt.id === entry.id);
        if (!found) return { ...consumed, page: 'list', focusId: null };
        return { ...consumed, page: 'delete', pendingDeleteId: entry.id };
      }
      return { ...consumed, page: 'list', focusId: entry.focusId ?? null, index: 0 };
    }
    case 'list':
      return {
        ...state,
        page: 'list',
        focusId: action.focusId ?? state.focusId,
        escArmed: false,
        pendingDeleteId: null,
        error: null,
        errorField: null,
      };
    case 'focus':
      return { ...state, index: Math.max(0, Math.floor(action.index)) };
    case 'create':
      return enterEditor(state, seededDraft(action.seed), null);
    case 'edit': {
      const found = action.library.prompts.find((prompt) => prompt.id === action.id);
      if (!found) return { ...state, page: 'list', error: 'not_found' };
      const draft = draftFromEntry(found);
      return enterEditor(state, draft, { ...draft });
    }
    case 'delete':
      return { ...state, page: 'delete', pendingDeleteId: action.id };
    case 'draft':
      return { ...state, draft: { ...state.draft, ...action.patch }, escArmed: false };
    case 'commit':
      return {
        ...state,
        page: 'list',
        focusId: action.id,
        baseline: null,
        escArmed: false,
        error: null,
        errorField: null,
        draft: EMPTY_PROMPT_DRAFT,
      };
    case 'failed':
      return { ...state, error: action.code, errorField: action.field ?? null };
    case 'esc': {
      if (state.page !== 'editor') return { ...state, page: 'list', pendingDeleteId: null };
      // A CLEAN EDITOR CLOSES ON THE FIRST Esc. A dirty one asks once, and the answer
      // has to be a second Esc rather than a modal: losing a body typed into a
      // multi-line field because one key was pressed is the failure this guards.
      if (!draftIsDirty(state.draft, state.baseline)) {
        return { ...state, page: 'list', baseline: null, draft: EMPTY_PROMPT_DRAFT };
      }
      if (state.escArmed) {
        return {
          ...state, page: 'list', baseline: null, escArmed: false, draft: EMPTY_PROMPT_DRAFT,
        };
      }
      return { ...state, escArmed: true };
    }
    case 'cancelled':
      return { ...state, page: 'list', baseline: null, escArmed: false, draft: EMPTY_PROMPT_DRAFT };
  }
}

// ---------------------------------------------------------------------------
// View models
// ---------------------------------------------------------------------------

export interface PromptLibraryRow {
  id: string;
  /** One-line render text: the title plus its markers. The caret is the component's. */
  label: string;
  markers: { favorite: boolean; hasTags: boolean; uses: number };
  /** Body length in code points; the detail block and the delete page share it. */
  chars: number;
}

/** `1.2k` for anything a fixed-width column cannot show in full. */
export function formatCount(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1)}k`;
}

/** `3d ago` / `2h ago` / `just now`. Deliberately coarse: it is a hint, not a clock. */
export function formatAgo(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined || timestamp <= 0) return 'never';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The list, one row per entry, in the library's own order.
 *
 * DUPLICATE TITLES GET AN ID PREFIX (I-2), exactly as `kit-picker-state.ts` does for
 * duplicate kit names: two rows reading the same words make `Enter` a coin flip.
 */
export function libraryRows(library: PromptLibrary): PromptLibraryRow[] {
  const seen = new Map<string, number>();
  for (const prompt of library.prompts) {
    seen.set(prompt.title, (seen.get(prompt.title) ?? 0) + 1);
  }
  return library.prompts.map((prompt) => {
    const duplicate = (seen.get(prompt.title) ?? 0) > 1;
    const identity = duplicate ? `#${prompt.id.slice(0, 8)} ` : '';
    const marks: string[] = [];
    if (prompt.favorite === true) marks.push('[fav]');
    const tags = prompt.tags ?? [];
    for (const tag of tags.slice(0, 2)) marks.push(`#${tag}`);
    if (tags.length > 2) marks.push(`+#${tags.length - 2}`);
    marks.push(`${formatCount([...prompt.content].length)}c`);
    if (prompt.useCount > 0) marks.push(`${formatCount(prompt.useCount)}x`);
    return {
      id: prompt.id,
      label: `${identity}${prompt.title}  ${marks.join(' ')}`,
      markers: {
        favorite: prompt.favorite === true,
        hasTags: tags.length > 0,
        uses: prompt.useCount,
      },
      chars: [...prompt.content].length,
    };
  });
}

/**
 * The detail block under the list: at most `detailMaxLines` rows, fixed shape.
 *
 * FIXED, because `OverlayFrame`'s window is shared with the list (D-16): a body that
 * participated in row height would squeeze six prompts into two visible rows. The
 * full text has exactly one home, and it is the editor.
 */
export function libraryDetail(
  row: PromptLibraryRow | undefined,
  library: PromptLibrary,
  cols: number,
  now: number = Date.now(),
): string[] {
  if (!row) return [];
  const prompt = library.prompts.find((entry) => entry.id === row.id);
  if (!prompt) return [];
  const tags = (prompt.tags ?? []).map((tag) => `#${tag}`).join(' ');
  const facts = [
    `${formatCount(row.chars)} chars`,
    `${prompt.useCount} uses`,
    formatAgo(prompt.lastUsedAt, now),
    prompt.favorite === true ? '[fav]' : '',
  ].filter(Boolean).join('  ');
  const body = prompt.content.split('\n').slice(0, PROMPT_LIMITS.detailPreviewLines).join('\n');
  const preview = wrapToRows(body, Math.max(8, cols - 8))
    .slice(0, PROMPT_LIMITS.detailPreviewLines);
  return [prompt.title, ...(tags.length > 0 ? [tags] : []), facts, ...preview]
    .slice(0, PROMPT_LIMITS.detailMaxLines);
}

/**
 * The list page's footer.
 *
 * THE LAST CLAUSE IS ALWAYS THE WAY OUT (§9.5): a narrow terminal clips from the
 * left, so the reader always keeps `Esc close`. The reorder keys are named here
 * rather than in the row above it because they are the one affordance a user cannot
 * discover by pressing a key they already know.
 */
export function libraryHint(state: PromptLibraryState, count: number): string {
  if (state.page === 'delete') return 'Enter delete | Esc cancel';
  if (state.page === 'editor') return editorHint(state);
  if (count === 0) return 'a create your first prompt | Esc close';
  return 'Enter edit | a new | d delete | f favorite | ^up/^dn reorder | Esc close';
}

function editorHint(state: PromptLibraryState): string {
  if (state.escArmed) return 'Esc again discards the draft | Tab next field';
  return 'Tab next field | Ctrl+S save | Esc close';
}

/** The delete page's four lines: what it is, how big, and what it costs. */
export function deleteDetail(
  library: PromptLibrary,
  id: string | null,
): string[] {
  const prompt = library.prompts.find((entry) => entry.id === id);
  if (!prompt) return [];
  return [
    prompt.title,
    `${[...prompt.content].length} chars, ${prompt.content.split('\n').length} lines`,
    'This cannot be undone.',
    'Enter or y deletes it; Esc or n keeps it.',
  ];
}

/**
 * The draft as the store accepts it.
 *
 * THE TAGS FIELD IS PARSED HERE, ONCE, and nowhere else: the editor edits a raw
 * string, the store validates a `string[]`, and a second parser between them is how
 * `a,b` and `a b` come to mean different things depending on which surface saved it.
 */
export function draftToInput(draft: PromptEditorDraft): PromptDraftInput {
  const input: PromptDraftInput = {
    title: draft.title,
    content: draft.content,
    tags: parsePromptTags(draft.tags),
    favorite: draft.favorite,
  };
  const description = draft.description.trim();
  if (description.length > 0) input.description = description;
  return input;
}
