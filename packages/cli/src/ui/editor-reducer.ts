/**
 * Composer editor state — F3 of tui-input-flicker-fix (§3.4).
 *
 * Ink creates its container with tag `0` — a LEGACY React root
 * (`ink/build/ink.js:59-61`). In a legacy root, `setState` called outside a
 * React event handler is NOT batched: each call schedules and immediately
 * flushes a synchronous render. `useInput`'s callback runs from a stdin
 * `'data'` listener, which is outside React entirely, so `PromptInput.insert`'s
 * five `setState` calls became five commits, five whole-tree Yoga layouts, and
 * — through Ink's 32 ms leading+trailing throttle — TWO full-frame repaints per
 * printable character (§2 R3). The flicker got worse the faster the user typed,
 * which is exactly what the report described.
 *
 * Collapsing the five always-together pieces of state into one reducer makes a
 * keystroke cost one commit. `fileMatches` deliberately stays a separate
 * `useState` in the component: it is written from the debounced async glob
 * effect, not from the key handler, so folding it in here would couple two
 * unrelated update sources.
 *
 * THE RULE A REVIEWER SHOULD CHECK LINE BY LINE: every branch of the `useInput`
 * callback performs at most ONE `dispatch` and then returns.
 *
 * Extracted from the component so it is unit-testable without mounting Ink.
 */

import {
  expandRangeOverTokens,
  formatPasteToken,
  makePasteRecord,
  referencedIds,
  shouldCollapse,
  snapOutOfToken,
  type PasteRecord,
} from './paste-tokens.js';

export interface EditorState {
  buffer: string;
  cursor: number;
  historyIndex: number | null;
  dismissed: boolean;
  sel: number;
  /**
   * Payloads for the collapse tokens currently in `buffer`
   * (tui-paste-handling section 5.3).
   *
   * Pruned to `referencedIds(buffer)` on EVERY buffer-changing action and
   * emptied by `clear` (I-7). Without both, a payload outlives the draft that
   * referenced it, unbounded, for the whole session.
   */
  pastes: ReadonlyMap<number, PasteRecord>;
}

/**
 * One run of an `input` chunk that mixed typing and pasting.
 *
 * THE `id` IS ALLOCATED BY THE CALLER (P1-5). React may run a reducer more than
 * once for a single action -- eager evaluation in `dispatchSetState`, base-queue
 * replay after a bailout, StrictMode -- so a counter read and written inside one
 * would skip ids and produce two computed states differing in the token TEXT.
 * `PromptInput` calls `allocatePasteId()` while building these segments, and the
 * reducer stays a pure function of `(state, action)`.
 */
export type InputSegment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'paste'; readonly text: string; readonly id: number };

/**
 * A `type` and not an `interface` because it is a discriminated union — the one
 * documented exception to this package's interface-first convention.
 */
export type EditorAction =
  | { type: 'insert'; text: string }
  | { type: 'replace'; buffer: string; cursor: number }
  | { type: 'backspace' }
  | { type: 'moveCursor'; cursor: number }
  | { type: 'recall'; buffer: string; cursor: number; historyIndex: number | null }
  | { type: 'select'; sel: number }
  | { type: 'dismiss' }
  | { type: 'clear' }
  /**
   * ONE chunk of stdin, already split into ordered runs. The only new action,
   * and it is what keeps the one-dispatch-per-key rule true for a chunk that
   * carried both a paste and the keystrokes beside it.
   */
  | { type: 'input'; segments: InputSegment[] };

const NO_PASTES: ReadonlyMap<number, PasteRecord> = new Map();

export const INITIAL_EDITOR_STATE: EditorState = {
  buffer: '',
  cursor: 0,
  historyIndex: null,
  dismissed: false,
  sel: 0,
  pastes: NO_PASTES,
};

/**
 * The three flags `resetDraftFlags()` used to clear with three separate
 * `setState` calls.
 *
 * Every action that CHANGES THE BUFFER resets them, and that is the pre-existing
 * semantics rather than a new rule: an edit invalidates the history cursor (the
 * draft is no longer the recalled entry), un-dismisses the popup (the user is
 * typing again, so suggestions should come back), and re-homes the selection
 * (the candidate list is about to be recomputed).
 */
const DRAFT_FLAGS = { historyIndex: null, dismissed: false, sel: 0 } as const;

/**
 * Drop payloads the buffer no longer references (I-7).
 *
 * A WRAPPER, NOT A LINE IN ONE BRANCH (P1-6). v1 of the design pruned only inside
 * `input`, which leaves `replace` (the action behind `Ctrl+U` / `Ctrl+K` /
 * `Ctrl+W` and every `applyEdit`), `backspace` and `recall` able to delete a token
 * without releasing its payload. A rule the body contradicts is worse than no
 * rule, because the next reader trusts the invariant.
 *
 * `moveCursor`, `select` and `dismiss` do not change the buffer and are left
 * alone, which keeps their "return the same object so React bails out" property.
 */
function withPrune(next: EditorState): EditorState {
  if (next.pastes.size === 0) return next;
  const live = referencedIds(next.buffer);
  // EVERY held id is tested, rather than `live.size === next.pastes.size`.
  // Equal counts do not mean equal sets: `referencedIds` reads the BUFFER, which
  // can name an id this map never held — a user who types `[Pasted text #99 +2
  // lines]` by hand, or edits the number inside a real token. One such id
  // balances out one deleted token and the cheap check then returns early with a
  // payload the buffer no longer references, which is the leak I-7 forbids.
  let stale = false;
  for (const id of next.pastes.keys()) {
    if (!live.has(id)) {
      stale = true;
      break;
    }
  }
  if (!stale) return next;
  const kept = new Map<number, PasteRecord>();
  for (const [id, record] of next.pastes) if (live.has(id)) kept.set(id, record);
  return { ...next, pastes: kept };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'insert': {
      // D-8: typing can never land INSIDE a token. A no-op on a buffer with no
      // tokens, which is every buffer until the first collapse.
      const cursor = snapOutOfToken(state.buffer, state.cursor);
      return withPrune({
        ...state,
        ...DRAFT_FLAGS,
        buffer: state.buffer.slice(0, cursor) + action.text + state.buffer.slice(cursor),
        cursor: cursor + action.text.length,
      });
    }
    case 'replace':
      return withPrune({
        ...state,
        ...DRAFT_FLAGS,
        buffer: action.buffer,
        cursor: action.cursor,
      });
    case 'backspace': {
      if (state.cursor <= 0) return state;
      // G5: one `Backspace` immediately after `...lines]` removes the whole
      // token and releases its payload, in ONE dispatch.
      const range = expandRangeOverTokens(state.buffer, state.cursor - 1, state.cursor);
      return withPrune({
        ...state,
        ...DRAFT_FLAGS,
        buffer: state.buffer.slice(0, range.from) + state.buffer.slice(range.to),
        cursor: range.from,
      });
    }
    case 'input': {
      let buffer = state.buffer;
      let cursor = snapOutOfToken(buffer, state.cursor);
      let pastes: Map<number, PasteRecord> | null = null;
      for (const segment of action.segments) {
        const collapse = segment.kind === 'paste' && shouldCollapse(segment.text);
        let text = segment.text;
        if (collapse) {
          const record = makePasteRecord(segment.id, segment.text);
          text = formatPasteToken(record);
          pastes = pastes ?? new Map(state.pastes);
          pastes.set(record.id, record);
        }
        buffer = buffer.slice(0, cursor) + text + buffer.slice(cursor);
        cursor += text.length;
      }
      return withPrune({
        ...state,
        ...DRAFT_FLAGS,
        buffer,
        cursor,
        ...(pastes ? { pastes } : {}),
      });
    }
    case 'moveCursor':
      // NO DRAFT-FLAG RESET. Moving the caret is not an edit: clearing
      // `historyIndex` here would end a history walk the moment the user pressed
      // ← to look at what they recalled.
      return state.cursor === action.cursor ? state : { ...state, cursor: action.cursor };
    case 'recall':
      // `historyIndex` is SET, not reset, which is why recall cannot reuse
      // `replace` — the two differ in exactly the field that keeps the walk
      // alive. `dismissed` and `sel` are LEFT ALONE, which is not an oversight:
      // the three `setState` calls this replaces did not touch them either, and
      // an Esc-dismissed popup that reopened when the user stepped through their
      // history would be a behaviour change smuggled in by a refactor whose whole
      // claim is that input semantics are identical (K-7).
      return withPrune({
        ...state,
        buffer: action.buffer,
        cursor: action.cursor,
        historyIndex: action.historyIndex,
      });
    case 'select':
      return state.sel === action.sel ? state : { ...state, sel: action.sel };
    case 'dismiss':
      return state.dismissed ? state : { ...state, dismissed: true };
    case 'clear':
      return INITIAL_EDITOR_STATE;
  }
}
