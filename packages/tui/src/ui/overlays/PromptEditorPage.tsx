/**
 * The prompt editor page (quick-prompt-library §4.4 / D-11).
 *
 * ASCII ONLY - `src/ui/**` is inside `glyphs.test.ts::inScope`. Labels and the footer
 * are English like every other overlay; every sentence that explains a REFUSAL comes
 * from `prompts/copy.ts`.
 *
 * SELF-MANAGED `OverlayFrame`, not the controlled one. The two modes are a
 * discriminated union (`children?: undefined`), and this page lays out a multi-row
 * body field that owns its own scrolling: handing it over as `rows` would mean the
 * frame counts a body's lines as rows and windows them again (P2-2).
 *
 * TWO WAYS TO SAVE, AND THE SECOND ONE IS NOT DECORATION. `Ctrl+S` is the fast path,
 * and it is a byte a terminal can eat (XON/XOFF) - so `Tab` to the `Save` row and
 * `Enter` must do exactly the same thing. That is what keeps "I cannot save" from
 * being a bug a whole class of terminals can reproduce.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { Theme } from '../theme.js';
import type { TermCapabilities } from '../capabilities.js';
import { pickGlyphs } from '../glyphs.js';
import { stripPasteFrames } from '../paste-frames.js';
import { stripEnterFrames } from '../enter-frames.js';
import { stepGrapheme } from '../editor-navigation.js';
import { OverlayFrame, overlayBodyRows } from '../layout/OverlayFrame.js';
import { promptErrorCopy } from '../../model/prompts/copy.js';
import {
  PROMPT_EDITOR_FIELDS,
  fieldIndex,
  type PromptEditorField,
  type PromptLibraryState,
} from './prompt-library-state.js';
import {
  EMPTY_TEXT_AREA,
  PromptTextArea,
  promptTextAreaReducer,
  type PromptTextAreaState,
} from './PromptTextArea.js';

/** Columns the field labels occupy. Fixed, so the values line up. */
const LABEL_CELLS = 10;
/** Body rows the page reserves for chrome when the frame is generous. */
const MIN_BODY_ROWS = 3;

export interface PromptEditorPageProps {
  isActive: boolean;
  state: PromptLibraryState;
  cols: number;
  maxRows: number;
  theme: Theme;
  caps: TermCapabilities;
  reducedMotion?: boolean;
  /** One field changed; the page never owns the text, only the caret. */
  onDraft: (patch: {
    title?: string; content?: string; description?: string; tags?: string;
  }) => void;
  onSave: () => void;
  onEsc: () => void;
  onCancel: () => void;
}

interface CursorState {
  title: number;
  description: number;
  tags: number;
}

/** Text fields of the page, in the order Tab visits them. */
function nextField(at: number, delta: number): number {
  const count = PROMPT_EDITOR_FIELDS.length;
  return (at + delta + count) % count;
}

/**
 * Which deletion key was pressed, if any.
 *
 * `key.delete` IS TREATED AS BACKSPACE, and the reason is measured rather than assumed:
 * ink's parser reports the `0x7f` byte - which is what the BACKSPACE KEY sends on every
 * terminal this product runs on - as `name: 'delete'`, and it hands the component an
 * EMPTY `input` for both it and `ESC [ 3 ~`. The two are therefore indistinguishable at
 * this layer, and the safe reading is the one the keyboard actually produces: backward.
 * A forward-delete binding that fired on Backspace would delete the character the user
 * was not looking at, and there is no undo in this field.
 */
function deletionKind(
  _input: string,
  key: { backspace?: boolean; delete?: boolean },
): 'backspace' | null {
  return key.backspace === true || key.delete === true ? 'backspace' : null;
}

/**
 * The page.
 *
 * The draft lives in the parent (the reducer owns it, so `Save` and `Esc` can see the
 * same text); this component owns only what no other surface needs: which row has
 * focus, and where each single-line field's caret sits.
 */
export function PromptEditorPage(props: PromptEditorPageProps): React.ReactElement {
  const { state, cols, maxRows, theme, caps } = props;
  const draft = state.draft;
  const glyphs = pickGlyphs(caps);
  const [focus, setFocus] = useState(0);
  // THE CARET STARTS AT THE END OF EACH FIELD, which is where a user expects to append:
  // starting at 0 would put every typed character in FRONT of the prefilled text, so an
  // edit to `Clean code review` would read `FixClean code review`.
  const [cursors, setCursors] = useState<CursorState>(() => ({
    title: draft.title.length,
    description: draft.description.length,
    tags: draft.tags.length,
  }));
  const [content, setContent] = useState<PromptTextAreaState>({
    ...EMPTY_TEXT_AREA,
    buffer: draft.content,
    cursor: draft.content.length,
  });

  const field = PROMPT_EDITOR_FIELDS[Math.min(focus, PROMPT_EDITOR_FIELDS.length - 1)]!;
  const bodyRows = Math.max(MIN_BODY_ROWS, overlayBodyRows(maxRows, cols) - 5);
  const fieldCols = Math.max(8, cols - LABEL_CELLS - 6);

  // A REFUSAL OWNS THE FOCUS (D-12): the store already names the row that failed, so the
  // caret is moved there instead of leaving the user to read an error in a footer and
  // work out which of four fields it is about. Keyed on `state.error`, so it fires once
  // per distinct refusal rather than on every render.
  useEffect(() => {
    if (state.error === null) return;
    setFocus(fieldIndex(state.errorField));
  }, [state.error, state.errorField]);

  const editSingle = (name: 'title' | 'description' | 'tags', text: string, key: {
    leftArrow?: boolean; rightArrow?: boolean;
  }, deletion: 'backspace' | null): void => {
    const value = draft[name];
    const cursor = Math.min(cursors[name], value.length);
    if (key.leftArrow || key.rightArrow) {
      setCursors({
        ...cursors,
        [name]: stepGrapheme(value, cursor, key.leftArrow ? 'left' : 'right'),
      });
      return;
    }
    if (deletion === 'backspace') {
      if (cursor <= 0) return;
      const from = stepGrapheme(value, cursor, 'left');
      props.onDraft({ [name]: value.slice(0, from) + value.slice(cursor) });
      setCursors({ ...cursors, [name]: from });
      return;
    }

    if (text.length === 0) return;
    const next = value.slice(0, cursor) + text + value.slice(cursor);
    props.onDraft({ [name]: next });
    setCursors({ ...cursors, [name]: cursor + text.length });
  };

  const applyContent = (action: Parameters<typeof promptTextAreaReducer>[1]): void => {
    const current = { ...content, buffer: draft.content };
    const next = promptTextAreaReducer(current, action);
    // COMPARED ON THE FIELDS, not on object identity: the reducer echoes its input object
    // back for a no-op move, and that object is rebuilt on every keystroke - so an
    // identity check would both hide the no-op and trigger a render for it.
    if (next.buffer !== current.buffer || next.cursor !== current.cursor) setContent(next);
    if (next.buffer !== draft.content) props.onDraft({ content: next.buffer });
  };

  useInput((input, key) => {
    if (props.isActive === false) return;
    // BEFORE EVERYTHING: a refused save and a dirty Esc are both two-step states, and
    // the accelerator that resolves them must not be swallowed by the text handling
    // below. `Ctrl+S` is the same precedent `SettingsScreen.tsx` set.
    if (key.ctrl && (input === 's' || input === 'S')) {
      props.onSave();
      return;
    }
    if (key.escape) {
      props.onEsc();
      return;
    }
    if (key.tab) {
      setFocus(nextField(focus, key.shift ? -1 : 1));
      return;
    }
    const clean = stripPasteFrames(stripEnterFrames(input));
    if (field === 'save') {
      if (key.return) props.onSave();
      return;
    }
    if (field === 'cancel') {
      if (key.return) props.onCancel();
      return;
    }
    if (field === 'content') {
      if (key.upArrow) {
        applyContent({ type: 'up', cols: fieldCols });
        return;
      }
      if (key.downArrow) {
        applyContent({ type: 'down', cols: fieldCols });
        return;
      }
      if (key.return || clean.includes('\n')) {
        applyContent({ type: 'newline' });
        return;
      }
      const contentDeletion = deletionKind(input, key);
      if (contentDeletion !== null) {
        applyContent({ type: contentDeletion });
        return;
      }
      if (key.leftArrow) {
        applyContent({ type: 'left' });
        return;
      }
      if (key.rightArrow) {
        applyContent({ type: 'right' });
        return;
      }
      if (key.ctrl || key.meta) return;
      if (clean.length > 0) applyContent({ type: 'insert', text: clean });
      return;
    }
    // Single-line fields: Enter advances rather than saving, because there is nothing
    // for a newline to mean in a one-line field.
    if (key.return) {
      setFocus(nextField(focus, 1));
      return;
    }
    if (key.upArrow) {
      setFocus(nextField(focus, -1));
      return;
    }
    if (key.downArrow) {
      setFocus(nextField(focus, 1));
      return;
    }
    if (key.ctrl || key.meta) return;
    editSingle(field, clean, key, deletionKind(input, key));
  });

  /** One text field, or an action row. The caret marks the focused one. */
  const row = (name: PromptEditorField): React.ReactElement => {
    const focused = field === name;
    const caret = focused ? glyphs.caret : ' ';
    if (name === 'save' || name === 'cancel') {
      const label = name === 'save' ? 'Save' : 'Cancel';
      return (
        <Text key={name} wrap="truncate" color={focused ? theme.accent : theme.muted}>
          {`${caret} [ ${label} ]`}
        </Text>
      );
    }
    const label = name === 'title' ? 'Title' : name === 'content' ? 'Body'
      : name === 'description' ? 'Note' : 'Tags';
    const value = draft[name as 'title' | 'description' | 'tags'];
    if (name === 'content') {
      return (
        <Box key={name} flexDirection="column">
          <Text wrap="truncate" color={focused ? theme.accent : theme.muted}>
            {`${caret} ${label.padEnd(LABEL_CELLS)}`}
          </Text>
          <Box flexDirection="column" paddingLeft={2}>
            <PromptTextArea
              state={{ ...content, buffer: draft.content }}
              cols={fieldCols}
              rows={bodyRows}
              focused={focused}
              theme={theme}
              caps={caps}
              {...(props.reducedMotion === undefined ? {} : { reducedMotion: props.reducedMotion })}
            />
          </Box>
        </Box>
      );
    }
    const shown = value.length === 0 ? '(empty)' : value;
    return (
      <Text key={name} wrap="truncate" color={focused ? theme.accent : theme.muted}>
        {`${caret} ${label.padEnd(LABEL_CELLS)}${shown}`}
      </Text>
    );
  };

  const title = state.error === null
    ? (draft.id === null ? 'New prompt' : 'Edit prompt')
    : promptErrorCopy(state.error);
  const hint = state.escArmed
    ? 'Esc again discards the draft | Tab next field'
    : 'Tab next field | Enter next line | Ctrl+S save | Esc close';

  return (
    <OverlayFrame title={title} hint={hint} maxRows={maxRows} cols={cols} theme={theme} caps={caps}>
      <Text wrap="truncate" color={theme.muted}>
        <Text color={draft.favorite ? theme.toolDone : theme.muted}>
          {draft.favorite ? '[fav] ' : '      '}
        </Text>
        {`${[...draft.content].length} chars`}
      </Text>
      <Box flexDirection="column">
        {PROMPT_EDITOR_FIELDS.map((name) => row(name))}
      </Box>
    </OverlayFrame>
  );
}
