import { editorReducer, type EditorState, type InputSegment } from './editor-reducer.js';

export interface ComposerSubmitResult {
  accepted: boolean;
  reason?: string;
}

export type ComposerInputIntent = InputSegment | { kind: 'newline' } | { kind: 'submit' };

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
    if (intent.kind === 'submit') {
      const text = options.resolveSubmit(nextEditor);
      if (submission !== undefined) {
        notice = MORE_INPUT_NOTICE;
      } else if (text !== null && text.trim().length > 0) {
        submission = text;
        nextEditor = editorReducer(nextEditor, { type: 'clear' });
        acceptedBase = nextEditor;
        acceptedPastes = [];
      }
      continue;
    }
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
  }
  return { nextEditor, rejectedEditor, submission, notice };
}
