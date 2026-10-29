import { editorReducer, type EditorState, type InputSegment } from './editor-reducer.js';
import { planPromptFill, type PromptFillPlan } from '../model/prompts/fill.js';

export interface ComposerSubmitResult {
  accepted: boolean;
  reason?: string;
}

/**
 * A fill carries the prompt body; `submit` folds "insert and send" into the SAME
 * transaction, so `Ctrl+Enter` in the picker is literally the Enter key one step
 * later rather than a second submission path (quick-prompt-library P0-1 / I-9).
 */
export type ComposerInputIntent =
  | InputSegment
  | { kind: 'newline' }
  | { kind: 'submit' }
  | { kind: 'fill'; text: string; mode: 'insert' | 'replace'; submit: boolean };

export interface ComposerInputOptions {
  editor: EditorState;
  intents: readonly ComposerInputIntent[];
  resolveSubmit: (editor: EditorState) => string | null;
  checkPasteLimit: (segments: InputSegment[], editor: EditorState) => string | null;
}

export interface ComposerInputPlan {
  nextEditor: EditorState;
  rejectedEditor: EditorState;
  submission?: string;
  notice?: string;
  refusal?: string;
}

const MORE_INPUT_NOTICE = 'More input is kept in the draft; press Enter to send.';

/**
 * Apply one fill to one draft. TWO CALLS PER INTENT, on purpose: the same plan runs
 * against the accepted and the rejected draft (P0-1), so a submission the host
 * refuses leaves the FILLED text in the composer rather than the text from before
 * the fill. Doing it once and sharing the result would silently drop the prompt the
 * user just chose, which is the data loss this design exists to prevent.
 *
 * THE REDUCER OWNS THE RESULT. `planPromptFill` says what to insert; `insert` and
 * `replace` decide the caret, the paste-token snapping and the draft-flag reset,
 * exactly as they do for typing.
 */
function applyFill(
  editor: EditorState,
  intent: { text: string; mode: 'insert' | 'replace' },
): EditorState {
  const plan: PromptFillPlan = planPromptFill({
    draft: editor.buffer,
    cursor: editor.cursor,
    content: intent.text,
    mode: intent.mode,
  });
  return plan.mode === 'replace'
    ? editorReducer(editor, { type: 'replace', buffer: plan.text, cursor: plan.cursor })
    : editorReducer(editor, { type: 'insert', text: plan.text });
}

/**
 * Plan both accepted and rejected drafts before any submission side effect.
 * Uses caller-assigned paste IDs and pure callbacks; never mutates the source editor.
 */
export function planComposerInput(options: ComposerInputOptions): ComposerInputPlan {
  let nextEditor = options.editor;
  let rejectedEditor = options.editor;
  let acceptedBase = options.editor;
  let acceptedPastes: InputSegment[] = [];
  const rejectedPastes: InputSegment[] = [];
  let submission: string | undefined;
  let notice: string | undefined;
  for (const intent of options.intents) {
    if (intent.kind === 'fill') {
      nextEditor = applyFill(nextEditor, intent);
      rejectedEditor = applyFill(rejectedEditor, intent);
      // A plain fill stops here: the draft is filled, nothing is sent (AC-16).
      if (!intent.submit) continue;
    } else if (intent.kind !== 'submit') {
      const segment: InputSegment = intent.kind === 'newline'
        ? { kind: 'text', text: '\n' } : intent;
      const segments = [segment];
      if (segment.kind === 'paste') {
        // Inline pastes have no map entry; count every paste in this callback as before.
        acceptedPastes.push(segment);
        rejectedPastes.push(segment);
        const refusal = options.checkPasteLimit(acceptedPastes, acceptedBase)
          ?? options.checkPasteLimit(rejectedPastes, options.editor);
        if (refusal) {
          return { nextEditor: options.editor, rejectedEditor: options.editor, refusal };
        }
      }
      nextEditor = editorReducer(nextEditor, { type: 'input', segments });
      rejectedEditor = editorReducer(rejectedEditor, { type: 'input', segments });
      continue;
    }
    // THE ONE SUBMIT PATH. A `fill` with `submit` and a bare `submit` reach this
    // block and nothing else, so queueing, paste expansion and the
    // accepted/rejected contract are inherited rather than re-implemented.
    const text = options.resolveSubmit(nextEditor);
    if (submission !== undefined) {
      notice = MORE_INPUT_NOTICE;
    } else if (text !== null && text.trim().length > 0) {
      submission = text;
      nextEditor = editorReducer(nextEditor, { type: 'clear' });
      acceptedBase = nextEditor;
      acceptedPastes = [];
    }
  }
  return { nextEditor, rejectedEditor, submission, notice };
}
